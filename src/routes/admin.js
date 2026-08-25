const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { firebaseAuth } = require('../services/firebaseAdmin');
const {
  ISTANBUL_DATE_SQL,
  normalizeAnalyticsDays,
} = require('../services/userActivity');
const { fetchAdminAnalyticsSummary } = require('../services/adminAnalytics');
const { expireClosedListingPromotion } = require('../services/promotionGrants');

router.use(authMiddleware, adminMiddleware);

function paging(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30));
  return { page, limit, offset: (page - 1) * limit };
}

function safeUserSnapshot(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    account_status: user.account_status,
    auth_providers: user.auth_providers,
    created_at: user.created_at,
  };
}

async function audit(client, { adminId, action, targetType, targetId, reason, snapshot }) {
  await client.query(`
    INSERT INTO admin_audit_logs (admin_id,action,target_type,target_id,reason,snapshot)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
  `, [adminId, action, targetType, targetId, reason, JSON.stringify(snapshot || {})]);
}

router.get('/users', async (req, res, next) => {
  try {
    const { page, limit, offset } = paging(req);
    const params = [];
    const where = [];
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    if (search) {
      params.push(`%${search}%`);
      where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }
    if (status) {
      if (!['active', 'suspended', 'deletion_pending'].includes(status)) {
        return res.status(400).json({ error: 'Geçersiz hesap durumu.' });
      }
      params.push(status);
      where.push(`u.account_status=$${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countParams = [...params];
    params.push(limit, offset);
    const [{ rows }, countResult] = await Promise.all([
      query(`
        SELECT u.id,u.name,u.email,u.phone,u.phone_verified,u.profile_image,u.city,u.district,
               u.is_admin,u.account_status,u.auth_providers,u.has_local_password,u.created_at,
               u.last_active_at,
               (SELECT COUNT(*)::int FROM listings l WHERE l.seller_id=u.id) AS listing_count,
               (SELECT COUNT(*)::int FROM offers o WHERE o.buyer_id=u.id) AS offer_count
        FROM users u ${clause}
        ORDER BY u.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      query(`SELECT COUNT(*)::int AS count FROM users u ${clause}`, countParams),
    ]);
    res.json({ users: rows, total: countResult.rows[0].count, page, limit });
  } catch (err) { next(err); }
});

router.get('/analytics', async (req, res, next) => {
  try {
    const days = normalizeAnalyticsDays(req.query.days);
    const [summary, dailyResult] = await Promise.all([
      fetchAdminAnalyticsSummary(),
      query(`
        WITH dates AS (
          SELECT generate_series(
            ${ISTANBUL_DATE_SQL} - ($1::int - 1),
            ${ISTANBUL_DATE_SQL},
            INTERVAL '1 day'
          )::date AS activity_date
        )
        SELECT dates.activity_date,
               COUNT(DISTINCT activity.user_id)::int AS active_users,
               COALESCE(SUM(activity.ping_count),0)::int AS ping_count
        FROM dates
        LEFT JOIN user_activity_daily activity
          ON activity.activity_date=dates.activity_date
        GROUP BY dates.activity_date
        ORDER BY dates.activity_date
      `, [days]),
    ]);
    res.json({
      days,
      summary,
      daily_activity: dailyResult.rows,
    });
  } catch (err) { next(err); }
});

router.get('/analytics/products', async (req, res, next) => {
  try {
    const days = normalizeAnalyticsDays(req.query.days);
    const { rows } = await query(`
      SELECT product_family_key,
             MAX(product_name) AS product_name,
             MAX(category) AS category,
             COUNT(*) FILTER (WHERE event_type='listing_view')::int AS views,
             COALESCE(SUM(active_seconds) FILTER (WHERE event_type='listing_view'),0)::int AS active_seconds,
             COUNT(*) FILTER (WHERE event_type='search')::int AS searches,
             COUNT(*) FILTER (WHERE event_type='listing_create')::int AS listings,
             COUNT(*) FILTER (WHERE event_type='call_button_click')::int AS calls,
             COUNT(*) FILTER (WHERE event_type='offer_create')::int AS offers,
             COUNT(*) FILTER (WHERE event_type='message_sent')::int AS messages
      FROM product_interest_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY product_family_key
      ORDER BY views DESC,offers DESC,searches DESC
      LIMIT 100
    `, [days]);
    res.json({ days, products: rows });
  } catch (err) { next(err); }
});

router.get('/promotions/summary', async (req, res, next) => {
  try {
    const days = normalizeAnalyticsDays(req.query.days);
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE sp.created_at>=NOW()-($1::int*INTERVAL '1 day'))::int AS purchases,
        COUNT(*) FILTER (WHERE sp.status='verified' AND sp.created_at>=NOW()-($1::int*INTERVAL '1 day'))::int AS verified_purchases,
        COUNT(*) FILTER (WHERE sp.status='revoked' AND sp.created_at>=NOW()-($1::int*INTERVAL '1 day'))::int AS revoked_purchases,
        COALESCE(SUM(sp.configured_gross_amount) FILTER (
          WHERE sp.status='verified' AND sp.created_at>=NOW()-($1::int*INTERVAL '1 day')
        ),0)::numeric AS configured_gross_try,
        (SELECT COUNT(*)::int FROM listings WHERE status='active' AND promoted_until>NOW()) AS active_promotions,
        (SELECT COUNT(*)::int FROM promotion_grants WHERE status='credit') AS available_credits
      FROM store_purchases sp
    `, [days]);
    const byPlatform = await query(`
      SELECT platform,product_id,status,COUNT(*)::int AS count
      FROM store_purchases
      WHERE created_at>=NOW()-($1::int*INTERVAL '1 day')
      GROUP BY platform,product_id,status
      ORDER BY platform,product_id,status
    `, [days]);
    res.json({ days, summary: rows[0], breakdown: byPlatform.rows });
  } catch (error) { next(error); }
});

router.get('/promotions/purchases', async (req, res, next) => {
  try {
    const { page, limit, offset } = paging(req);
    const params = [];
    const where = [];
    const platform = String(req.query.platform || '').trim();
    const status = String(req.query.status || '').trim();
    if (platform) {
      if (!['ios', 'android'].includes(platform)) return res.status(400).json({ error: 'Geçersiz platform.' });
      params.push(platform); where.push(`sp.platform=$${params.length}`);
    }
    if (status) {
      if (!['pending', 'verified', 'revoked', 'failed'].includes(status)) return res.status(400).json({ error: 'Geçersiz durum.' });
      params.push(status); where.push(`sp.status=$${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countParams = [...params];
    params.push(limit, offset);
    const [result, countResult] = await Promise.all([
      query(`
        SELECT sp.id,sp.platform,sp.product_id,sp.status,sp.environment,
               sp.configured_gross_amount,sp.currency,sp.verified_at,sp.revoked_at,sp.created_at,
               u.id AS user_id,u.name AS user_name,u.email AS user_email,
               l.id AS listing_id,l.crop_name,
               CASE WHEN pg.status='active' AND pg.ends_at<=NOW()
                 THEN 'ended' ELSE pg.status END AS grant_status,
               pg.duration_days
        FROM store_purchases sp
        JOIN users u ON u.id=sp.user_id
        LEFT JOIN listings l ON l.id=sp.listing_id
        LEFT JOIN promotion_grants pg ON pg.purchase_id=sp.id
        ${clause}
        ORDER BY sp.created_at DESC
        LIMIT $${params.length-1} OFFSET $${params.length}
      `, params),
      query(`SELECT COUNT(*)::int AS count FROM store_purchases sp ${clause}`, countParams),
    ]);
    res.json({ purchases: result.rows, total: countResult.rows[0].count, page, limit });
  } catch (error) { next(error); }
});

router.get('/listings', async (req, res, next) => {
  try {
    const { page, limit, offset } = paging(req);
    const params = [];
    const where = [];
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    if (search) {
      params.push(`%${search}%`);
      where.push(`(l.crop_name ILIKE $${params.length} OR u.name ILIKE $${params.length} OR l.city ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`l.status=$${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countParams = [...params];
    params.push(limit, offset);
    const [{ rows }, countResult] = await Promise.all([
      query(`
        SELECT l.*,CASE WHEN l.quantity_unlimited THEN 0
                 ELSE GREATEST(l.quantity-l.fulfilled_quantity,0) END AS remaining_quantity,
               json_build_object('id',u.id,'name',u.name,'email',u.email,'phone',u.phone,
                 'profile_image',u.profile_image) AS seller
        FROM listings l JOIN users u ON u.id=l.seller_id
        ${clause}
        ORDER BY l.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      query(`SELECT COUNT(*)::int AS count FROM listings l JOIN users u ON u.id=l.seller_id ${clause}`, countParams),
    ]);
    res.json({ listings: rows, total: countResult.rows[0].count, page, limit });
  } catch (err) { next(err); }
});

router.patch('/users/:id/status', [
  body('status').isIn(['active', 'suspended']),
  body('reason').trim().isLength({ min: 5, max: 1000 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Kendi admin hesabınızın durumunu değiştiremezsiniz.' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }
    const target = current.rows[0];
    if (target.is_admin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Başka bir admin hesabı değiştirilemez.' });
    }

    if (target.firebase_uid) {
      await firebaseAuth().updateUser(target.firebase_uid, {
        disabled: req.body.status === 'suspended',
      });
      await firebaseAuth().revokeRefreshTokens(target.firebase_uid);
    }
    const result = await client.query(`
      UPDATE users
      SET account_status=$1,token_version=token_version+1,updated_at=NOW()
      WHERE id=$2
      RETURNING id,name,email,phone,is_admin,account_status,token_version
    `, [req.body.status, target.id]);
    await audit(client, {
      adminId: req.user.id,
      action: req.body.status === 'suspended' ? 'user_suspend' : 'user_reactivate',
      targetType: 'user', targetId: target.id, reason: req.body.reason,
      snapshot: safeUserSnapshot(target),
    });
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/users/:id', [
  body('reason').trim().isLength({ min: 5, max: 1000 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Kendi admin hesabınızı silemezsiniz.' });
  }

  const current = await query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!current.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  const target = current.rows[0];
  if (target.is_admin) return res.status(403).json({ error: 'Başka bir admin hesabı silinemez.' });

  await query(`
    UPDATE users SET account_status='deletion_pending',token_version=token_version+1,updated_at=NOW()
    WHERE id=$1
  `, [target.id]);
  try {
    if (target.firebase_uid) {
      await firebaseAuth().updateUser(target.firebase_uid, { disabled: true });
      await firebaseAuth().revokeRefreshTokens(target.firebase_uid);
      await firebaseAuth().deleteUser(target.firebase_uid);
    }
  } catch (err) {
    // Firebase may already have been removed by an earlier partial attempt.
    if (err.code !== 'auth/user-not-found') {
      err.status = 502;
      err.message = `Firebase hesabı silinemedi; kullanıcı deletion_pending durumunda bırakıldı: ${err.message}`;
      return next(err);
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await audit(client, {
      adminId: req.user.id, action: 'user_delete', targetType: 'user',
      targetId: target.id, reason: req.body.reason, snapshot: safeUserSnapshot(target),
    });
    await client.query('DELETE FROM users WHERE id=$1', [target.id]);
    await client.query('COMMIT');
    res.json({ message: 'Kullanıcı ve bağlı verileri kalıcı olarak silindi.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/listings/:id', [
  body('reason').trim().isLength({ min: 5, max: 1000 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT l.*,u.name AS owner_name,u.email AS owner_email
      FROM listings l JOIN users u ON u.id=l.seller_id
      WHERE l.id=$1 FOR UPDATE OF l
    `, [req.params.id]);
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'İlan bulunamadı.' });
    }
    const listing = result.rows[0];
    await audit(client, {
      adminId: req.user.id, action: 'listing_delete', targetType: 'listing',
      targetId: listing.id, reason: req.body.reason,
      snapshot: {
        id: listing.id, crop_name: listing.crop_name, seller_id: listing.seller_id,
        owner_name: listing.owner_name, owner_email: listing.owner_email,
        status: listing.status, created_at: listing.created_at,
      },
    });
    await expireClosedListingPromotion(listing.id, client);
    await client.query('DELETE FROM listings WHERE id=$1', [listing.id]);
    await client.query('COMMIT');
    res.json({ message: 'İlan ve bağlı teklif/mesaj kayıtları silindi.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;

router.testHelpers = { paging, normalizeAnalyticsDays };
