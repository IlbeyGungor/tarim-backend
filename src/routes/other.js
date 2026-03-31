// ── Market Prices ──────────────────────────────────────────────────────────
const pricesRouter = require('express').Router();
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

// GET /api/prices  (public)
pricesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM market_prices WHERE price_date = CURRENT_DATE ORDER BY product ASC`
    );
    // If no prices today, return latest
    if (!rows.length) {
      const { rows: latest } = await query(
        `SELECT DISTINCT ON (product) * FROM market_prices ORDER BY product, price_date DESC`
      );
      return res.json(latest);
    }
    res.json(rows);
  } catch (err) { next(err); }
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

module.exports = { pricesRouter, usersRouter };
