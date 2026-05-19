// src/routes/offers.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const notify = require('../utils/notify');

function chatAccessWhere(alias = 'o') {
  return `(
    (${alias}.buyer_id = $1 AND ${alias}.buyer_chat_deleted_at IS NULL)
    OR (l.seller_id = $1 AND ${alias}.seller_chat_deleted_at IS NULL)
  )`;
}

// GET /api/offers/chats — accepted offer chats for current user
router.get('/chats', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        o.id AS offer_id,
        o.listing_id,
        o.buyer_id,
        l.seller_id,
        o.updated_at,
        json_build_object(
          'id', l.id,
          'crop_name', l.crop_name,
          'city', l.city,
          'district', l.district,
          'unit', l.unit,
          'price_per_unit', l.price_per_unit,
          'status', l.status
        ) AS listing,
        CASE
          WHEN o.buyer_id = $1 THEN json_build_object('id', seller.id, 'name', seller.name, 'phone', seller.phone, 'role', seller.role, 'rating', seller.rating, 'is_verified', seller.is_verified)
          ELSE json_build_object('id', buyer.id, 'name', buyer.name, 'phone', buyer.phone, 'role', buyer.role, 'rating', buyer.rating, 'is_verified', buyer.is_verified)
        END AS other_user,
        last_message.text AS last_message,
        last_message.created_at AS last_message_at
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users buyer ON buyer.id = o.buyer_id
      JOIN users seller ON seller.id = l.seller_id
      LEFT JOIN LATERAL (
        SELECT text, created_at
        FROM messages
        WHERE offer_id = o.id
        ORDER BY created_at DESC
        LIMIT 1
      ) last_message ON true
      WHERE o.status = 'accepted'
        AND ${chatAccessWhere('o')}
      ORDER BY COALESCE(last_message.created_at, o.updated_at, o.created_at) DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// DELETE /api/offers/:id/chat — hide chat for current user
router.delete('/:id/chat', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT o.id, o.buyer_id, l.seller_id
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.id=$1 AND o.status='accepted'
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Sohbet bulunamadı.' });

    const chat = rows[0];
    if (chat.buyer_id !== req.user.id && chat.seller_id !== req.user.id) {
      return res.status(403).json({ error: 'Yetki yok.' });
    }

    if (chat.buyer_id === req.user.id) {
      await query('UPDATE offers SET buyer_chat_deleted_at=NOW(), updated_at=NOW() WHERE id=$1', [req.params.id]);
    } else {
      await query('UPDATE offers SET seller_chat_deleted_at=NOW(), updated_at=NOW() WHERE id=$1', [req.params.id]);
    }

    res.json({ message: 'Sohbet listenizden kaldırıldı.' });
  } catch (err) { next(err); }
});

// POST /api/offers/:id/reviews — one review per accepted offer per user
router.post('/:id/reviews', authMiddleware, [
  body('reviewee_id').notEmpty(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('message').trim().notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { reviewee_id, rating, message } = req.body;
    const { rows: offerRows } = await client.query(`
      SELECT o.id, o.buyer_id, l.seller_id
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.id=$1 AND o.status='accepted'
    `, [req.params.id]);
    if (!offerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Kabul edilmiş teklif bulunamadı.' });
    }

    const offer = offerRows[0];
    const isBuyer = offer.buyer_id === req.user.id;
    const isSeller = offer.seller_id === req.user.id;
    if (!isBuyer && !isSeller) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Yetki yok.' });
    }

    const expectedReviewee = isBuyer ? offer.seller_id : offer.buyer_id;
    if (reviewee_id !== expectedReviewee) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sadece bu sohbetteki karşı tarafı değerlendirebilirsiniz.' });
    }

    const { rows } = await client.query(`
      INSERT INTO reviews (offer_id, reviewer_id, reviewee_id, rating, message)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `, [req.params.id, req.user.id, reviewee_id, rating, message.trim()]);

    await client.query(`
      UPDATE users
      SET rating = COALESCE((SELECT AVG(rating)::numeric(3,2) FROM reviews WHERE reviewee_id=$1), 0),
          total_trades = (SELECT COUNT(*) FROM reviews WHERE reviewee_id=$1),
          updated_at = NOW()
      WHERE id=$1
    `, [reviewee_id]);

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Bu teklif için zaten değerlendirme yaptınız.' });
    next(err);
  } finally { client.release(); }
});

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
        AND o.buyer_deleted_at IS NULL
        AND (l.status <> 'reserved' OR o.status IN ('accepted','rejected'))
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
      WHERE l.seller_id = $1 AND o.seller_deleted_at IS NULL
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
    if (!listingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Aktif ilan bulunamadı.' });
    }
    const listing = listingRows[0];
    if (listing.seller_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Kendi ilanınıza teklif veremezsiniz.' });
    }

    const { rows } = await client.query(`
      INSERT INTO offers (listing_id,buyer_id,offered_price,quantity,message)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [listing_id, req.user.id, offered_price, quantity, message||null]);

    await client.query('UPDATE listings SET offer_count=offer_count+1 WHERE id=$1', [listing_id]);

    const { rows: buyerRows } = await client.query('SELECT name FROM users WHERE id=$1', [req.user.id]);

    await client.query('COMMIT');

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
      SELECT o.*, l.seller_id, l.crop_name, l.unit, l.status AS listing_status,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM offers o
      JOIN listings l ON l.id=o.listing_id
      JOIN users buyer ON buyer.id=o.buyer_id
      JOIN users seller ON seller.id=l.seller_id
      WHERE o.id=$1
      FOR UPDATE OF o, l
    `, [req.params.id]);
    if (!offerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Teklif bulunamadı.' });
    }
    const offer = offerRows[0];
    if (offer.seller_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Yetki yok.' });
    }
    if (status === 'accepted' && offer.listing_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu ilan artık teklif kabul etmeye uygun değil.' });
    }

    const counterBy = status === 'countered' ? 'seller' : null;
    const { rows } = await client.query(`
      UPDATE offers SET status=$1, counter_price=$2, counter_by=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, status === 'countered' ? counter_price : null, counterBy, req.params.id]);

    if (status === 'accepted') {
      await client.query(`
        UPDATE listings
        SET status='reserved',
            reserved_at=NOW(),
            reserved_until=NOW() + INTERVAL '7 days',
            updated_at=NOW()
        WHERE id=$1
      `, [offer.listing_id]);
      await client.query(`
        UPDATE offers
        SET status='rejected', updated_at=NOW()
        WHERE listing_id=$1
          AND id<>$2
          AND status IN ('pending','countered')
      `, [offer.listing_id, req.params.id]);
    }

    await client.query('COMMIT');

    if (status === 'accepted') {
      notify.offerAccepted({
        buyerId: offer.buyer_id,
        sellerName: offer.seller_name,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      });
    } else if (status === 'rejected') {
      notify.offerRejected({
        buyerId: offer.buyer_id,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      });
    } else if (status === 'countered') {
      notify.counterOffer({
        recipientId: offer.buyer_id,
        senderName: offer.seller_name,
        cropName: offer.crop_name,
        counterPrice: counter_price,
        unit: offer.unit,
        offerId: req.params.id,
        madeBy: 'seller',
        listingId: offer.listing_id,
      });
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
      SELECT o.*, l.seller_id, l.crop_name, l.unit, l.status AS listing_status,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM offers o
      JOIN listings l ON l.id=o.listing_id
      JOIN users buyer ON buyer.id=o.buyer_id
      JOIN users seller ON seller.id=l.seller_id
      WHERE o.id=$1
      FOR UPDATE OF o, l
    `, [req.params.id]);
    if (!offerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Teklif bulunamadı.' });
    }
    const offer = offerRows[0];
    if (offer.buyer_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Yetki yok.' });
    }
    if (offer.status !== 'countered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sadece karşı teklife yanıt verebilirsiniz.' });
    }
    if (status === 'accepted' && offer.listing_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu ilan artık teklif kabul etmeye uygun değil.' });
    }

    const counterBy = status === 'countered' ? 'buyer' : null;
    const { rows } = await client.query(`
      UPDATE offers SET status=$1, counter_price=$2, counter_by=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, status === 'countered' ? counter_price : null, counterBy, req.params.id]);

    if (status === 'accepted') {
      await client.query(`
        UPDATE listings
        SET status='reserved',
            reserved_at=NOW(),
            reserved_until=NOW() + INTERVAL '7 days',
            updated_at=NOW()
        WHERE id=$1
      `, [offer.listing_id]);
      await client.query(`
        UPDATE offers
        SET status='rejected', updated_at=NOW()
        WHERE listing_id=$1
          AND id<>$2
          AND status IN ('pending','countered')
      `, [offer.listing_id, req.params.id]);
    }

    await client.query('COMMIT');

    if (status === 'accepted') {
      notify.offerAccepted({
        buyerId: offer.seller_id,
        sellerName: offer.buyer_name,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      });
    } else if (status === 'rejected') {
      notify.offerRejected({
        buyerId: offer.seller_id,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      });
    } else if (status === 'countered') {
      notify.finalOffer({
        sellerId: offer.seller_id,
        buyerName: offer.buyer_name,
        cropName: offer.crop_name,
        finalPrice: counter_price,
        unit: offer.unit,
        offerId: req.params.id,
        listingId: offer.listing_id,
      });
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
    if (!offerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Teklif bulunamadı.' });
    }
    if (offerRows[0].status !== 'countered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sadece bekleyen karşı teklifi düzenleyebilirsiniz.' });
    }
    const isSeller = offerRows[0].seller_id === req.user.id;
    const isBuyer  = offerRows[0].buyer_id  === req.user.id;
    const madeByMe = (isSeller && offerRows[0].counter_by === 'seller') ||
                     (isBuyer  && offerRows[0].counter_by === 'buyer');
    if (!madeByMe) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sadece kendi karşı teklifinizi düzenleyebilirsiniz.' });
    }
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
      FOR UPDATE OF o, l
    `, [req.params.id]);
    if (!offerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Teklif bulunamadı.' });
    }
    const offer = offerRows[0];
    if (offer.status !== 'countered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'İptal edilecek karşı teklif yok.' });
    }
    const isSeller = offer.seller_id === req.user.id;
    const isBuyer  = offer.buyer_id  === req.user.id;
    const madeByMe = (isSeller && offer.counter_by === 'seller') ||
                     (isBuyer  && offer.counter_by === 'buyer');
    if (!madeByMe) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sadece kendi karşı teklifinizi iptal edebilirsiniz.' });
    }

    const { rows } = await client.query(
      "UPDATE offers SET status='pending', counter_price=NULL, counter_by=NULL, updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    await client.query('COMMIT');

    const recipientId = isSeller ? offer.buyer_id : offer.seller_id;
    const senderName  = isSeller ? offer.seller_name : offer.buyer_name;
    notify.counterCancelled({
      recipientId,
      senderName,
      cropName: offer.crop_name,
      offerId: req.params.id,
      listingId: offer.listing_id,
    });

    res.json(rows[0]);
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});


router.delete('/:id', authMiddleware, async (req, res, next) => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      SELECT
        o.id,
        o.status,
        o.listing_id,
        o.buyer_id,
        o.buyer_deleted_at,
        o.seller_deleted_at,
        l.seller_id
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      WHERE o.id = $1
    `, [req.params.id]);

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Teklif bulunamadı.' });
    }

    const offer = rows[0];
    const isBuyer = offer.buyer_id === req.user.id;
    const isSeller = offer.seller_id === req.user.id;

    if (!isBuyer && !isSeller) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Bu teklifi silme yetkiniz yok.' });
    }

    // accepted / countered / completed -> silinemez
    if (['accepted', 'countered', 'completed'].includes(offer.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu durumdaki teklifler silinemez.' });
    }

    // pending -> sadece buyer silebilir, tamamen silinir
    if (offer.status === 'pending') {
      if (!isBuyer) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Bekleyen teklifi sadece teklifi veren kullanıcı silebilir.' });
      }

      await client.query(`DELETE FROM offers WHERE id = $1`, [offer.id]);

      await client.query(`
        UPDATE listings
        SET offer_count = GREATEST(offer_count - 1, 0)
        WHERE id = $1
      `, [offer.listing_id]);

      await client.query('COMMIT');
      return res.json({ message: 'Teklif tamamen silindi.', mode: 'hard' });
    }

    // rejected -> sadece o kullanıcı için gizlenir
    if (offer.status === 'rejected') {
      if (isBuyer) {
        await client.query(`
          UPDATE offers
          SET buyer_deleted_at = COALESCE(buyer_deleted_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
        `, [offer.id]);
      }

      if (isSeller) {
        await client.query(`
          UPDATE offers
          SET seller_deleted_at = COALESCE(seller_deleted_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
        `, [offer.id]);
      }

      // İki taraf da sildiyse DB'den tamamen temizle
      await client.query(`
        DELETE FROM offers
        WHERE id = $1
          AND status = 'rejected'
          AND buyer_deleted_at IS NOT NULL
          AND seller_deleted_at IS NOT NULL
      `, [offer.id]);

      await client.query('COMMIT');
      return res.json({ message: 'Teklif listenizden kaldırıldı.', mode: 'soft' });
    }

    await client.query('ROLLBACK');
    return res.status(400).json({ error: 'Bu teklif silinemez.' });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

async function requireAcceptedChatParticipant(offerId, userId) {
  const { rows } = await query(`
    SELECT o.id, o.buyer_id, l.seller_id
    FROM offers o
    JOIN listings l ON l.id = o.listing_id
    WHERE o.id=$1 AND o.status='accepted'
  `, [offerId]);
  if (!rows.length) return null;
  const offer = rows[0];
  if (offer.buyer_id !== userId && offer.seller_id !== userId) return null;
  return offer;
}

// GET /api/offers/:id/messages
router.get('/:id/messages', authMiddleware, async (req, res, next) => {
  try {
    const offer = await requireAcceptedChatParticipant(req.params.id, req.user.id);
    if (!offer) return res.status(404).json({ error: 'Sohbet bulunamadı.' });

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
    const offer = await requireAcceptedChatParticipant(req.params.id, req.user.id);
    if (!offer) return res.status(404).json({ error: 'Sohbet bulunamadı.' });

    const { rows } = await query(
      'INSERT INTO messages (offer_id,sender_id,text) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, req.body.text]
    );
    const clearColumn = offer.buyer_id === req.user.id ? 'seller_chat_deleted_at' : 'buyer_chat_deleted_at';
    await query(`UPDATE offers SET ${clearColumn}=NULL, updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
