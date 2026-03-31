const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');

// GET /api/offers/my
router.get('/my', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT o.*,
        json_build_object('id',l.id,'crop_name',l.crop_name,'city',l.city,
          'district',l.district,'unit',l.unit,'price_per_unit',l.price_per_unit) AS listing,
        json_build_object('id',u.id,'name',u.name,'phone',u.phone,'role',u.role) AS seller
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users u ON u.id = l.seller_id
      WHERE o.buyer_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/offers/received
router.get('/received', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT o.*,
        json_build_object('id',l.id,'crop_name',l.crop_name,'city',l.city,'district',l.district,'unit',l.unit,'price_per_unit',l.price_per_unit) AS listing,
        json_build_object('id',u.id,'name',u.name,'phone',u.phone,'rating',u.rating,'is_verified',u.is_verified) AS buyer
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users u ON u.id = o.buyer_id
      WHERE l.seller_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/offers
router.post('/', authMiddleware, [
  body('listing_id').notEmpty(),
  body('offered_price').isFloat({ gt: 0 }),
  body('quantity').isFloat({ gt: 0 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { listing_id, offered_price, quantity, message } = req.body;
    const { rows: listing } = await client.query(
      "SELECT * FROM listings WHERE id=$1 AND status='active'", [listing_id]
    );
    if (!listing.length) return res.status(404).json({ error: 'Aktif ilan bulunamadı.' });
    if (listing[0].seller_id === req.user.id) return res.status(400).json({ error: 'Kendi ilanınıza teklif veremezsiniz.' });
    const { rows } = await client.query(`
      INSERT INTO offers (listing_id,buyer_id,offered_price,quantity,message)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [listing_id, req.user.id, offered_price, quantity, message||null]);
    await client.query('UPDATE listings SET offer_count=offer_count+1 WHERE id=$1', [listing_id]);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/respond  — seller: accept / reject / counter
router.patch('/:id/respond', authMiddleware, [
  body('status').isIn(['accepted','rejected','countered']),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { status, counter_price } = req.body;
    const { rows: offer } = await client.query(
      'SELECT o.*, l.seller_id FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1',
      [req.params.id]
    );
    if (!offer.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    if (offer[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });

    const counterBy = status === 'countered' ? 'seller' : null;
    const { rows } = await client.query(`
      UPDATE offers
      SET status=$1, counter_price=$2, counter_by=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, status === 'countered' ? counter_price : null, counterBy, req.params.id]);

    if (status === 'accepted') {
      await client.query("UPDATE listings SET status='reserved' WHERE id=$1", [offer[0].listing_id]);
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/buyer-respond  — buyer: accept / reject / son teklif
router.patch('/:id/buyer-respond', authMiddleware, [
  body('status').isIn(['accepted','rejected','countered']),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { status, counter_price } = req.body;
    const { rows: offer } = await client.query(
      'SELECT o.*, l.seller_id FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1',
      [req.params.id]
    );
    if (!offer.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    if (offer[0].buyer_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });
    if (offer[0].status !== 'countered') return res.status(400).json({ error: 'Sadece karşı teklife yanıt verebilirsiniz.' });

    // NEVER touch offered_price — it always stays as buyer's original price
    // counter_price and counter_by track the latest counter from either side
    const counterBy = status === 'countered' ? 'buyer' : null;
    const { rows } = await client.query(`
      UPDATE offers
      SET status=$1, counter_price=$2, counter_by=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, status === 'countered' ? counter_price : null, counterBy, req.params.id]);

    if (status === 'accepted') {
      await client.query("UPDATE listings SET status='reserved' WHERE id=$1", [offer[0].listing_id]);
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/edit-counter  — edit your own pending counter offer
router.patch('/:id/edit-counter', authMiddleware, [
  body('counter_price').isFloat({ gt: 0 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { counter_price } = req.body;
    const { rows: offer } = await client.query(
      'SELECT o.*, l.seller_id FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1',
      [req.params.id]
    );
    if (!offer.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    if (offer[0].status !== 'countered') return res.status(400).json({ error: 'Sadece bekleyen karşı teklifi düzenleyebilirsiniz.' });

    // Only the person who made the counter can edit it
    const isSeller = offer[0].seller_id === req.user.id;
    const isBuyer  = offer[0].buyer_id  === req.user.id;
    const madeByMe = (isSeller && offer[0].counter_by === 'seller') ||
                     (isBuyer  && offer[0].counter_by === 'buyer');
    if (!madeByMe) return res.status(403).json({ error: 'Sadece kendi karşı teklifinizi düzenleyebilirsiniz.' });

    const { rows } = await client.query(`
      UPDATE offers SET counter_price=$1, updated_at=NOW() WHERE id=$2 RETURNING *
    `, [counter_price, req.params.id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/cancel-counter  — withdraw your counter, reset to pending
router.patch('/:id/cancel-counter', authMiddleware, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows: offer } = await client.query(
      'SELECT o.*, l.seller_id FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1',
      [req.params.id]
    );
    if (!offer.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    if (offer[0].status !== 'countered') return res.status(400).json({ error: 'İptal edilecek karşı teklif yok.' });

    const isSeller = offer[0].seller_id === req.user.id;
    const isBuyer  = offer[0].buyer_id  === req.user.id;
    const madeByMe = (isSeller && offer[0].counter_by === 'seller') ||
                     (isBuyer  && offer[0].counter_by === 'buyer');
    if (!madeByMe) return res.status(403).json({ error: 'Sadece kendi karşı teklifinizi iptal edebilirsiniz.' });

    const { rows } = await client.query(`
      UPDATE offers SET status='pending', counter_price=NULL, counter_by=NULL, updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// GET /api/offers/:id/messages
router.get('/:id/messages', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT m.*, json_build_object('id',u.id,'name',u.name) AS sender
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.offer_id=$1 ORDER BY m.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/offers/:id/messages
router.post('/:id/messages', authMiddleware, [
  body('text').trim().notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const { rows } = await query(`
      INSERT INTO messages (offer_id,sender_id,text) VALUES ($1,$2,$3) RETURNING *
    `, [req.params.id, req.user.id, req.body.text]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
