const { getClient, query } = require('../db');
const { getPromotionProduct } = require('./promotionProducts');

async function grantVerifiedPurchase(purchaseId, { getClientImpl = getClient } = {}) {
  const client = await getClientImpl();
  try {
    await client.query('BEGIN');
    const purchaseResult = await client.query(`
      SELECT sp.*, pi.listing_id AS intended_listing_id
      FROM store_purchases sp
      LEFT JOIN promotion_purchase_intents pi ON pi.id=sp.intent_id
      WHERE sp.id=$1
      FOR UPDATE OF sp
    `, [purchaseId]);
    const purchase = purchaseResult.rows[0];
    if (!purchase) throw Object.assign(new Error('Satın alma kaydı bulunamadı.'), { status: 404 });
    if (purchase.status !== 'verified') {
      throw Object.assign(new Error('Satın alma henüz doğrulanmadı.'), { status: 409, code: 'PURCHASE_NOT_VERIFIED' });
    }

    const existing = await client.query(
      'SELECT * FROM promotion_grants WHERE purchase_id=$1',
      [purchase.id],
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      return existing.rows[0];
    }

    const product = getPromotionProduct(purchase.product_id);
    if (!product) throw new Error(`Unknown promotion product: ${purchase.product_id}`);
    const listingId = purchase.intended_listing_id || purchase.listing_id;
    const listingResult = listingId
      ? await client.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [listingId])
      : { rows: [] };
    const listing = listingResult.rows[0];
    const canApply = listing && listing.seller_id === purchase.user_id && listing.status === 'active';
    let startsAt = null;
    let endsAt = null;
    if (canApply) {
      const timingResult = await client.query(`
        WITH timing AS (
          SELECT GREATEST(NOW(),COALESCE(promoted_until,NOW())) AS starts_at
          FROM listings WHERE id=$2
        )
        UPDATE listings l
        SET promoted_until=timing.starts_at + ($1::int * INTERVAL '1 day'),
            promoted_ranked_at=NOW(),updated_at=NOW()
        FROM timing
        WHERE l.id=$2
        RETURNING timing.starts_at,l.promoted_until AS ends_at
      `, [product.durationDays, listing.id]);
      startsAt = timingResult.rows[0].starts_at;
      endsAt = timingResult.rows[0].ends_at;
    }
    const grantResult = await client.query(`
      INSERT INTO promotion_grants
        (purchase_id,user_id,listing_id,duration_days,status,applied_at,starts_at,ends_at)
      VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='active' THEN NOW() ELSE NULL END,$6,$7)
      RETURNING *
    `, [
      purchase.id,
      purchase.user_id,
      canApply ? listing.id : null,
      product.durationDays,
      canApply ? 'active' : 'credit',
      startsAt,
      endsAt,
    ]);
    await client.query(`
      UPDATE promotion_purchase_intents
      SET status=$1,completed_at=NOW(),updated_at=NOW()
      WHERE id=$2
    `, [canApply ? 'completed' : 'credited', purchase.intent_id]);
    await client.query('COMMIT');
    return grantResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyPromotionCredit({ grantId, userId, listingId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const grantResult = await client.query(`
      SELECT * FROM promotion_grants
      WHERE id=$1 AND user_id=$2
      FOR UPDATE
    `, [grantId, userId]);
    const grant = grantResult.rows[0];
    if (!grant) throw Object.assign(new Error('Öne çıkarma kredisi bulunamadı.'), { status: 404 });
    if (grant.status !== 'credit') {
      throw Object.assign(new Error('Bu kredi daha önce kullanılmış veya iptal edilmiş.'), { status: 409, code: 'CREDIT_NOT_AVAILABLE' });
    }
    const listingResult = await client.query(
      `SELECT * FROM listings WHERE id=$1 AND seller_id=$2 FOR UPDATE`,
      [listingId, userId],
    );
    const listing = listingResult.rows[0];
    if (!listing || listing.status !== 'active') {
      throw Object.assign(new Error('Kredi yalnız aktif bir ilanınıza uygulanabilir.'), { status: 409, code: 'LISTING_NOT_ACTIVE' });
    }
    const timingResult = await client.query(`
      WITH timing AS (
        SELECT GREATEST(NOW(),COALESCE(promoted_until,NOW())) AS starts_at
        FROM listings WHERE id=$2
      )
      UPDATE listings l
      SET promoted_until=timing.starts_at + ($1::int * INTERVAL '1 day'),
          promoted_ranked_at=NOW(),updated_at=NOW()
      FROM timing
      WHERE l.id=$2
      RETURNING timing.starts_at,l.promoted_until AS ends_at
    `, [grant.duration_days, listing.id]);
    const timing = timingResult.rows[0];
    const updated = await client.query(`
      UPDATE promotion_grants
      SET listing_id=$1,status='active',applied_at=NOW(),starts_at=$3,ends_at=$4,updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [listing.id, grant.id, timing.starts_at, timing.ends_at]);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function revokePurchaseByTransaction(
  { platform, transactionKey },
  { getClientImpl = getClient } = {},
) {
  const client = await getClientImpl();
  try {
    await client.query('BEGIN');
    const purchaseResult = await client.query(`
      UPDATE store_purchases
      SET status='revoked',revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
      WHERE platform=$1 AND transaction_key=$2
      RETURNING *
    `, [platform, transactionKey]);
    const purchase = purchaseResult.rows[0];
    if (!purchase) {
      await client.query('COMMIT');
      return null;
    }
    const grantResult = await client.query(
      'SELECT * FROM promotion_grants WHERE purchase_id=$1 FOR UPDATE',
      [purchase.id],
    );
    const grant = grantResult.rows[0];
    if (grant && !grant.revoked_at) {
      if (grant.status === 'active' && grant.listing_id) {
        const remainingResult = await client.query(`
          SELECT EXTRACT(EPOCH FROM GREATEST(
            INTERVAL '0',
            COALESCE(ends_at,NOW()) - GREATEST(NOW(),COALESCE(starts_at,NOW()))
          ))::double precision AS remaining_seconds
          FROM promotion_grants WHERE id=$1
        `, [grant.id]);
        const remainingSeconds = remainingResult.rows[0].remaining_seconds;
        await client.query(`
          UPDATE listings
          SET promoted_until=GREATEST(
                NOW(),
                COALESCE(promoted_until,NOW()) - ($1::double precision * INTERVAL '1 second')
              ),
              updated_at=NOW()
          WHERE id=$2
        `, [remainingSeconds, grant.listing_id]);
        await client.query(`
          UPDATE promotion_grants
          SET starts_at=starts_at-($1::double precision*INTERVAL '1 second'),
              ends_at=ends_at-($1::double precision*INTERVAL '1 second'),updated_at=NOW()
          WHERE listing_id=$2 AND status='active' AND id<>$3
            AND starts_at>=COALESCE($4::timestamptz,starts_at)
        `, [remainingSeconds, grant.listing_id, grant.id, grant.ends_at]);
      }
      await client.query(`
        UPDATE promotion_grants
        SET status='revoked',revoked_at=NOW(),updated_at=NOW()
        WHERE id=$1
      `, [grant.id]);
    }
    await client.query('COMMIT');
    return purchase;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function expireClosedListingPromotion(listingId, client = null) {
  const runner = client || { query };
  await runner.query(`
    UPDATE listings
    SET promoted_until=CASE
      WHEN promoted_until>NOW() THEN NOW()
      ELSE promoted_until END
    WHERE id=$1
  `, [listingId]);
  await runner.query(`
    UPDATE promotion_grants
    SET status='ended',updated_at=NOW()
    WHERE listing_id=$1 AND status='active'
  `, [listingId]);
}

module.exports = {
  grantVerifiedPurchase,
  applyPromotionCredit,
  revokePurchaseByTransaction,
  expireClosedListingPromotion,
};
