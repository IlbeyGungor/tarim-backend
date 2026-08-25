const crypto = require('crypto');
const router = require('express').Router();
const webhookRouter = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  listPromotionProducts,
  getPromotionProduct,
  promotionsEnabled,
} = require('../services/promotionProducts');
const {
  verifyStorePurchase,
  verifyGooglePurchase,
  consumeGooglePurchase,
  decodeAppleNotification,
  purchaseTokenHash,
} = require('../services/storeVerification');
const {
  grantVerifiedPurchase,
  applyPromotionCredit,
  revokePurchaseByTransaction,
} = require('../services/promotionGrants');

function errorResponse(res, error) {
  const status = error.status || (error.code === 'STORE_NOT_CONFIGURED' ? 503 : 400);
  return res.status(status).json({ error: error.message, code: error.code || 'PURCHASE_FAILED' });
}

router.use(authMiddleware);

router.get('/products', (req, res) => {
  res.json({
    enabled: promotionsEnabled(),
    products: listPromotionProducts().map((item) => ({
      product_id: item.productId,
      duration_days: item.durationDays,
    })),
  });
});

router.get('/me', async (req, res, next) => {
  try {
    const [listingsResult, grantsResult] = await Promise.all([
      query(`
        SELECT id,crop_name,listing_type,status,image_urls,default_image_url,
               promoted_until,promoted_ranked_at,
               (promoted_until>NOW()) AS is_promoted
        FROM listings
        WHERE seller_id=$1 AND status='active'
        ORDER BY created_at DESC
      `, [req.user.id]),
      query(`
        SELECT pg.id,pg.duration_days,pg.status,pg.listing_id,pg.created_at,
               pg.applied_at,l.crop_name,l.promoted_until,sp.product_id,sp.platform
        FROM promotion_grants pg
        JOIN store_purchases sp ON sp.id=pg.purchase_id
        LEFT JOIN listings l ON l.id=pg.listing_id
        WHERE pg.user_id=$1
          AND (pg.status='credit' OR (pg.status='active' AND pg.ends_at>NOW()))
        ORDER BY pg.created_at DESC
      `, [req.user.id]),
    ]);
    res.json({ enabled: promotionsEnabled(), listings: listingsResult.rows, grants: grantsResult.rows });
  } catch (error) { next(error); }
});

router.post('/intents', [
  body('listing_id').isUUID(),
  body('product_id').isString(),
  body('platform').isIn(['ios', 'android']),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (!promotionsEnabled()) return res.status(503).json({ error: 'Öne çıkarma satın alımları henüz kullanıma açık değil.', code: 'PROMOTIONS_DISABLED' });
  const product = getPromotionProduct(req.body.product_id);
  if (!product) return res.status(400).json({ error: 'Geçersiz öne çıkarma paketi.' });
  try {
    const listingResult = await query(
      `SELECT id FROM listings WHERE id=$1 AND seller_id=$2 AND status='active'`,
      [req.body.listing_id, req.user.id],
    );
    if (!listingResult.rows.length) {
      return res.status(409).json({ error: 'Yalnız aktif ilanlarınız öne çıkarılabilir.', code: 'LISTING_NOT_ACTIVE' });
    }
    const result = await query(`
      INSERT INTO promotion_purchase_intents
        (user_id,listing_id,product_id,platform,expires_at)
      VALUES ($1,$2,$3,$4,NOW()+INTERVAL '30 minutes')
      RETURNING id,listing_id,product_id,platform,status,expires_at
    `, [req.user.id, req.body.listing_id, product.productId, req.body.platform]);
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

router.post('/purchases/verify', [
  body('intent_id').isUUID(),
  body('purchase_id').optional({ nullable: true }).isString(),
  body('verification_data').optional({ nullable: true }).isString(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const intentResult = await query(`
      SELECT * FROM promotion_purchase_intents
      WHERE id=$1 AND user_id=$2
    `, [req.body.intent_id, req.user.id]);
    const intent = intentResult.rows[0];
    if (!intent) return res.status(404).json({ error: 'Satın alma isteği bulunamadı.' });
    if (!['created', 'pending'].includes(intent.status)) {
      const existing = await query(`
        SELECT pg.*,sp.status AS purchase_status
        FROM store_purchases sp LEFT JOIN promotion_grants pg ON pg.purchase_id=sp.id
        WHERE sp.intent_id=$1
      `, [intent.id]);
      return res.json({ status: intent.status, grant: existing.rows[0] || null });
    }

    const verified = await verifyStorePurchase({
      platform: intent.platform,
      productId: intent.product_id,
      purchaseId: req.body.purchase_id,
      verificationData: req.body.verification_data,
    });
    const client = await getClient();
    let purchase;
    try {
      await client.query('BEGIN');
      const duplicate = await client.query(`
        SELECT * FROM store_purchases
        WHERE platform=$1 AND transaction_key=$2
        FOR UPDATE
      `, [intent.platform, verified.transactionKey]);
      if (duplicate.rows.length && duplicate.rows[0].user_id !== req.user.id) {
        throw Object.assign(new Error('Bu mağaza işlemi başka bir hesaba bağlı.'), { status: 409, code: 'PURCHASE_OWNERSHIP_CONFLICT' });
      }
      const result = await client.query(`
        INSERT INTO store_purchases
          (intent_id,user_id,listing_id,platform,product_id,transaction_key,
           order_id,environment,status,configured_gross_amount,currency,verified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TRY',CASE WHEN $9='verified' THEN NOW() ELSE NULL END)
        ON CONFLICT (platform,transaction_key) DO UPDATE
        SET status=EXCLUDED.status,verified_at=EXCLUDED.verified_at,
            order_id=COALESCE(EXCLUDED.order_id,store_purchases.order_id),updated_at=NOW()
        RETURNING *
      `, [
        intent.id, req.user.id, intent.listing_id, intent.platform,
        intent.product_id, verified.transactionKey, verified.orderId || null,
        verified.environment, verified.status,
        getPromotionProduct(intent.product_id).configuredPriceTry,
      ]);
      purchase = result.rows[0];
      await client.query(`
        UPDATE promotion_purchase_intents SET status=$1,updated_at=NOW() WHERE id=$2
      `, [verified.status, intent.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (verified.status === 'pending') return res.status(202).json({ status: 'pending' });
    const grant = await grantVerifiedPurchase(purchase.id);
    if (intent.platform === 'android') {
      try {
        await consumeGooglePurchase({ productId: intent.product_id, purchaseToken: req.body.verification_data });
        await query(`UPDATE store_purchases SET consumption_status='consumed',updated_at=NOW() WHERE id=$1`, [purchase.id]);
      } catch (consumeError) {
        console.error(`[promotions] Google consume failed purchase=${purchase.id}:`, consumeError.message);
        await query(`UPDATE store_purchases SET consumption_status='failed',updated_at=NOW() WHERE id=$1`, [purchase.id]);
      }
    }
    res.json({ status: grant.status === 'credit' ? 'credited' : 'completed', grant });
  } catch (error) {
    if (error.status || error.code) return errorResponse(res, error);
    next(error);
  }
});

router.post('/credits/:id/apply', [body('listing_id').isUUID()], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const grant = await applyPromotionCredit({
      grantId: req.params.id,
      userId: req.user.id,
      listingId: req.body.listing_id,
    });
    res.json({ status: 'completed', grant });
  } catch (error) {
    if (error.status || error.code) return errorResponse(res, error);
    next(error);
  }
});

async function verifyPubSubRequest(req) {
  const audience = String(process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE || '').trim();
  const expectedEmail = String(process.env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT || '').trim();
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!audience || !expectedEmail || !token) return false;
  const { OAuth2Client } = require('google-auth-library');
  const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();
  return payload?.email === expectedEmail && payload.email_verified === true;
}

function googleNotificationAction(notification) {
  if (notification.voidedPurchaseNotification?.purchaseToken &&
      Number(notification.voidedPurchaseNotification.productType) === 2) {
    return 'voided';
  }
  const type = Number(notification.oneTimeProductNotification?.notificationType);
  if (type === 1) return 'purchased';
  if (type === 2) return 'pending_cancelled';
  return 'ignored';
}

webhookRouter.post('/apple/iap', async (req, res, next) => {
  try {
    const signedPayload = String(req.body?.signedPayload || '');
    if (!signedPayload) return res.status(400).json({ error: 'signedPayload eksik.' });
    const { notification, transaction } = await decodeAppleNotification(signedPayload);
    if (transaction && ['REFUND', 'REVOKE'].includes(notification.notificationType)) {
      await revokePurchaseByTransaction({ platform: 'ios', transactionKey: String(transaction.transactionId) });
    }
    res.sendStatus(200);
  } catch (error) { next(error); }
});

webhookRouter.post('/google/play', async (req, res, next) => {
  try {
    if (!(await verifyPubSubRequest(req))) return res.sendStatus(401);
    const encoded = req.body?.message?.data;
    if (!encoded) return res.sendStatus(400);
    const notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (notification.packageName !== String(process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim()) {
      return res.sendStatus(400);
    }
    const action = googleNotificationAction(notification);
    const voided = notification.voidedPurchaseNotification;
    if (action === 'voided') {
      await revokePurchaseByTransaction({
        platform: 'android',
        transactionKey: purchaseTokenHash(voided.purchaseToken),
      });
      return res.sendStatus(200);
    }
    const item = notification.oneTimeProductNotification;
    if (!item?.purchaseToken || !item?.sku) return res.sendStatus(200);
    const transactionKey = purchaseTokenHash(item.purchaseToken);
    if (action === 'pending_cancelled') {
      await query(`
        UPDATE store_purchases
        SET status='failed',updated_at=NOW()
        WHERE platform='android' AND transaction_key=$1 AND status='pending'
      `, [transactionKey]);
      await query(`
        UPDATE promotion_purchase_intents pi
        SET status='cancelled',updated_at=NOW()
        FROM store_purchases sp
        WHERE sp.intent_id=pi.id AND sp.platform='android'
          AND sp.transaction_key=$1 AND sp.status='failed'
      `, [transactionKey]);
      return res.sendStatus(200);
    }
    const purchaseResult = await query(`
      SELECT * FROM store_purchases WHERE platform='android' AND transaction_key=$1
    `, [transactionKey]);
    const purchase = purchaseResult.rows[0];
    if (!purchase) return res.sendStatus(200);
    const verified = await verifyGooglePurchase({ productId: purchase.product_id, purchaseToken: item.purchaseToken });
    if (verified.status === 'verified') {
      await query(`UPDATE store_purchases SET status='verified',verified_at=NOW(),updated_at=NOW() WHERE id=$1`, [purchase.id]);
      await grantVerifiedPurchase(purchase.id);
      await consumeGooglePurchase({ productId: purchase.product_id, purchaseToken: item.purchaseToken });
      await query(`UPDATE store_purchases SET consumption_status='consumed',updated_at=NOW() WHERE id=$1`, [purchase.id]);
    }
    res.sendStatus(200);
  } catch (error) { next(error); }
});

module.exports = {
  promotionsRouter: router,
  promotionWebhooksRouter: webhookRouter,
  testHelpers: { googleNotificationAction },
};
