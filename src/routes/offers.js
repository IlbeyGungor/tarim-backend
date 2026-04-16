// src/routes/offers.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const notify = require('../utils/notify');

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

// POST /api/offers  — make a new offer, notify seller
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

    const { rows: listingRows } = await client.query(
      "SELECT l.*, u.name AS seller_name FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1 AND l.status='active'",
      [listing_id]
    );
    if (!listingRows.length) return res.status(404).json({ error: 'Aktif ilan bulunamadı.' });
    const listing = listingRows[0];
    if (listing.seller_id === req.user.id) return res.status(400).json({ error: 'Kendi ilanınıza teklif veremezsiniz.' });

    const { rows } = await client.query(`
      INSERT INTO offers (listing_id,buyer_id,offered_price,quantity,message)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [listing_id, req.user.id, offered_price, quantity, message||null]);

    await client.query('UPDATE listings SET offer_count=offer_count+1 WHERE id=$1', [listing_id]);

    // Get buyer name for notification
    const { rows: buyerRows } = await client.query('SELECT name FROM users WHERE id=$1', [req.user.id]);

    await client.query('COMMIT');

    // Notify seller — after commit so DB is consistent
    notify.newOffer({
      sellerId:      listing.seller_id,
      buyerName:     buyerRows[0]?.name || 'Bir alıcı',
      cropName:      listing.crop_name,
      offeredPrice:  offered_price,
      unit:          listing.unit,
      offerId:       rows[0].id,
      listingId:     listing_id,
    });

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

    const { rows: offerRows } = await client.query(`
      SELECT o.*, l.seller_id, l.crop_name, l.unit,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM offers o
      JOIN listings l ON l.id=o.listing_id
      JOIN users buyer ON buyer.id=o.buyer_id
      JOIN users seller ON seller.id=l.seller_id
      WHERE o.id=$1
    `, [req.params.id]);
    if (!offerRows.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    const offer = offerRows[0];
    if (offer.seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });

    const counterBy = status === 'countered' ? 'seller' : null;
    const { rows } = await client.query(`
      UPDATE offers SET status=$1, counter_price=$2, counter_by=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, status === 'countered' ? counter_price : null, counterBy, req.params.id]);

    if (status === 'accepted') {
      await client.query("UPDATE listings SET status='reserved' WHERE id=$1", [offer.listing_id]);
    }

    await client.query('COMMIT');

    // Notify buyer based on what seller did
    if (status === 'accepted') {
      notify.offerAccepted({ buyerId: offer.buyer_id, sellerName: offer.seller_name, cropName: offer.crop_name, offerId: req.params.id });
    } else if (status === 'rejected') {
      notify.offerRejected({ buyerId: offer.buyer_id, cropName: offer.crop_name, offerId: req.params.id });
    } else if (status === 'countered') {
      notify.counterOffer({ recipientId: offer.buyer_id, senderName: offer.seller_name, cropName: offer.crop_name, counterPrice: counter_price, unit: offer.unit, offerId: req.params.id, madeBy: 'seller' });
    }

    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/buyer-respond  — buyer: accept / reject / final counter
router.patch('/:id/buyer-respond', authMiddleware, [
  body('status').isIn(['accepted','rejected','countered']),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { status, counter_price } = req.body;

    const { rows: offerRows } = await client.query(`
      SELECT o.*, l.seller_id, l.crop_name, l.unit,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM offers o
      JOIN listings l ON l.id=o.listing_id
      JOIN users buyer ON buyer.id=o.buyer_id
      JOIN users seller ON seller.id=l.seller_id
      WHERE o.id=$1
    `, [req.params.id]);
    if (!offerRows.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    const offer = offerRows[0];
    if (offer.buyer_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });
    if (offer.status !== 'countered') return res.status(400).json({ error: 'Sadece karşı teklife yanıt verebilirsiniz.' });

    const counterBy = status === 'countered' ? 'buyer' : null;
    const { rows } = await client.query(`
      UPDATE offers SET status=$1, counter_price=$2, counter_by=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, status === 'countered' ? counter_price : null, counterBy, req.params.id]);

    if (status === 'accepted') {
      await client.query("UPDATE listings SET status='reserved' WHERE id=$1", [offer.listing_id]);
    }

    await client.query('COMMIT');

    // Notify seller based on what buyer did
    if (status === 'accepted') {
      notify.offerAccepted({ buyerId: offer.seller_id, sellerName: offer.buyer_name, cropName: offer.crop_name, offerId: req.params.id });
    } else if (status === 'rejected') {
      notify.offerRejected({ buyerId: offer.seller_id, cropName: offer.crop_name, offerId: req.params.id });
    } else if (status === 'countered') {
      notify.finalOffer({ sellerId: offer.seller_id, buyerName: offer.buyer_name, cropName: offer.crop_name, finalPrice: counter_price, unit: offer.unit, offerId: req.params.id });
    }

    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/edit-counter
router.patch('/:id/edit-counter', authMiddleware, [
  body('counter_price').isFloat({ gt: 0 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { counter_price } = req.body;
    const { rows: offerRows } = await client.query(
      'SELECT o.*, l.seller_id FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1',
      [req.params.id]
    );
    if (!offerRows.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    if (offerRows[0].status !== 'countered') return res.status(400).json({ error: 'Sadece bekleyen karşı teklifi düzenleyebilirsiniz.' });
    const isSeller = offerRows[0].seller_id === req.user.id;
    const isBuyer  = offerRows[0].buyer_id  === req.user.id;
    const madeByMe = (isSeller && offerRows[0].counter_by === 'seller') ||
                     (isBuyer  && offerRows[0].counter_by === 'buyer');
    if (!madeByMe) return res.status(403).json({ error: 'Sadece kendi karşı teklifinizi düzenleyebilirsiniz.' });
    const { rows } = await client.query(
      'UPDATE offers SET counter_price=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [counter_price, req.params.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

// PATCH /api/offers/:id/cancel-counter
router.patch('/:id/cancel-counter', authMiddleware, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows: offerRows } = await client.query(`
      SELECT o.*, l.seller_id, l.crop_name,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM offers o
      JOIN listings l ON l.id=o.listing_id
      JOIN users buyer ON buyer.id=o.buyer_id
      JOIN users seller ON seller.id=l.seller_id
      WHERE o.id=$1
    `, [req.params.id]);
    if (!offerRows.length) return res.status(404).json({ error: 'Teklif bulunamadı.' });
    const offer = offerRows[0];
    if (offer.status !== 'countered') return res.status(400).json({ error: 'İptal edilecek karşı teklif yok.' });
    const isSeller = offer.seller_id === req.user.id;
    const isBuyer  = offer.buyer_id  === req.user.id;
    const madeByMe = (isSeller && offer.counter_by === 'seller') ||
                     (isBuyer  && offer.counter_by === 'buyer');
    if (!madeByMe) return res.status(403).json({ error: 'Sadece kendi karşı teklifinizi iptal edebilirsiniz.' });

    const { rows } = await client.query(
      "UPDATE offers SET status='pending', counter_price=NULL, counter_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    await client.query('COMMIT');

    // Notify the other party that counter was withdrawn
    const recipientId = isSeller ? offer.buyer_id : offer.seller_id;
    const senderName  = isSeller ? offer.seller_name : offer.buyer_name;
    notify.counterCancelled({ recipientId, senderName, cropName: offer.crop_name, offerId: req.params.id });

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
    const { rows } = await query(
      'INSERT INTO messages (offer_id,sender_id,text) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, req.body.text]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
