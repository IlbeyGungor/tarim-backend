const router = require('express').Router();
const { body, query: qv, validationResult } = require('express-validator');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

// Reusable query to get full listing with seller info
const LISTING_SELECT = `
  SELECT
    l.*,
    json_build_object(
      'id', u.id, 'name', u.name, 'phone', u.phone,
      'role', u.role, 'city', u.city, 'district', u.district,
      'tc_verified', u.tc_verified, 'cks_verified', u.cks_verified,
      'is_verified', u.is_verified, 'rating', u.rating,
      'total_trades', u.total_trades, 'profile_image', u.profile_image
    ) AS seller
  FROM listings l
  JOIN users u ON u.id = l.seller_id
`;

// GET /api/listings  (public, with optional filters)
router.get('/', async (req, res, next) => {
  try {
    const { search, category, city, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = ["l.status != 'sold'"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(l.crop_name ILIKE $${params.length} OR l.city ILIKE $${params.length} OR l.district ILIKE $${params.length})`);
    }
    if (category) { params.push(category); conditions.push(`l.category = $${params.length}`); }
    if (city)     { params.push(city);     conditions.push(`l.city = $${params.length}`); }
    if (status)   { params.push(status);   conditions.push(`l.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), offset);

    const { rows } = await query(
      `${LISTING_SELECT} ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Total count for pagination
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id ${where}`,
      countParams
    );

    res.json({
      listings: rows,
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countRows[0].count / limit),
    });
  } catch (err) { next(err); }
});

// GET /api/listings/:id  (public)
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`${LISTING_SELECT} WHERE l.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    // Increment view count
    await query('UPDATE listings SET view_count = view_count + 1 WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/listings  (auth required)
router.post('/', authMiddleware, [
  body('crop_name').trim().notEmpty().withMessage('Ürün adı zorunludur.'),
  body('category').isIn(['grain','vegetable','fruit','nut','legume','other']),
  body('quantity').isFloat({ gt: 0 }),
  body('price_per_unit').isFloat({ gt: 0 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const {
      crop_name, category, quantity, unit = 'kg',
      price_per_unit, price_type = 'negotiate',
      city, district, address, description, harvest_date
    } = req.body;

    const { rows } = await query(`
      INSERT INTO listings
        (seller_id,crop_name,category,quantity,unit,price_per_unit,price_type,city,district,address,description,harvest_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [req.user.id, crop_name, category, quantity, unit, price_per_unit, price_type,
        city||null, district||null, address||null, description||null, harvest_date||null]);

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/listings/:id  (auth, owner only)
router.patch('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows: existing } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (existing[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });

    const allowed = ['crop_name','quantity','price_per_unit','price_type','description','status','harvest_date'];
    const sets = [], params = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${key}=$${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE listings SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
      params
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/listings/:id  (auth, owner only)
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT seller_id FROM listings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (rows[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });
    await query('DELETE FROM listings WHERE id=$1', [req.params.id]);
    res.json({ message: 'İlan silindi.' });
  } catch (err) { next(err); }
});

module.exports = router;
