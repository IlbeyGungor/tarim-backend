// ── Market Prices ──────────────────────────────────────────────────────────
const pricesRouter = require('express').Router();
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');

// GET /api/prices  (public)
// Ana liste için: her ürün + hal kombinasyonunun son mümkün fiyatı
pricesRouter.get('/', async (req, res, next) => {
  try {
    const scope = req.query.scope || 'national';
    const productionType = req.query.production_type || 'Geleneksel';

    const { rows } = await query(`
      SELECT
        id,
        product,
        scope,
        market,
        city,
        production_type,
        icon,
        min_price,
        max_price,
        avg_price,
        unit,
        trend,
        latest_price_date
      FROM market_price_latest
      WHERE scope = $1
        AND production_type = $2
      ORDER BY product ASC
    `, [scope, productionType]);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/prices/history?product=Mayer%20Limon&city=Mersin&market=Mersin%20Hali&range=30d
pricesRouter.get('/history', async (req, res, next) => {
  try {
    const { product, city, market, range = '30d' } = req.query;

    if (!product || !city || !market) {
      return res.status(400).json({
        error: 'product, city ve market parametreleri zorunludur.'
      });
    }

    let days;
    switch (range) {
      case '7d':
        days = 7;
        break;
      case '30d':
        days = 30;
        break;
      case '365d':
        days = 365;
        break;
      default:
        return res.status(400).json({
          error: 'range sadece 7d, 30d veya 365d olabilir.'
        });
    }

    const { rows } = await query(`
      SELECT
        price_date,
        min_price,
        max_price,
        avg_price
      FROM market_price_history
      WHERE product = $1
        AND city = $2
        AND market = $3
        AND price_date >= CURRENT_DATE - ($4::int * INTERVAL '1 day')
      ORDER BY price_date ASC
    `, [product, city, market, days]);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── Users ──────────────────────────────────────────────────────────────────
const usersRouter = require('express').Router();

// GET /api/users/:id  (public profile)
usersRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id,name,role,city,district,bio,tc_verified,cks_verified,
             is_verified,rating,total_trades,profile_image,created_at
      FROM users WHERE id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/users/me  (update own profile)
usersRouter.patch('/me', authMiddleware, async (req, res, next) => {
  try {
    const allowed = ['name', 'city', 'district', 'bio'];
    const sets = [], params = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key}=$${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    params.push(req.user.id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length}
       RETURNING id,name,phone,role,city,district,bio,tc_verified,cks_verified,is_verified,rating,total_trades`,
      params
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/users/me  — permanently delete account and all related data
usersRouter.delete('/me', authMiddleware, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const userId = req.user.id;

    // 1. Delete messages in offers where this user is buyer or seller
    await client.query(`
      DELETE FROM messages
      WHERE offer_id IN (
        SELECT o.id FROM offers o
        JOIN listings l ON l.id = o.listing_id
        WHERE o.buyer_id = $1 OR l.seller_id = $1
      )
    `, [userId]);

    // 2. Delete offers where this user is buyer
    await client.query(`DELETE FROM offers WHERE buyer_id = $1`, [userId]);

    // 3. Delete offers on this user's listings (as seller)
    await client.query(`
      DELETE FROM offers
      WHERE listing_id IN (SELECT id FROM listings WHERE seller_id = $1)
    `, [userId]);

    // 4. Delete this user's listings
    await client.query(`DELETE FROM listings WHERE seller_id = $1`, [userId]);

    // 5. Finally delete the user itself
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query('COMMIT');
    res.json({ message: 'Hesabınız ve tüm verileriniz başarıyla silindi.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = { pricesRouter, usersRouter };
