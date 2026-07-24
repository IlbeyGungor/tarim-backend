// src/routes/offers.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const notify = require('../utils/notify');

function sendNotification(type, promise) {
  promise.catch((err) => {
    console.error(`[notification] ${type} failed:`, err);
  });
}

function chatAccessWhere(alias = 'o') {
  return `(
    (${alias}.buyer_id = $1 AND ${alias}.buyer_chat_deleted_at IS NULL)
    OR (l.seller_id = $1 AND ${alias}.seller_chat_deleted_at IS NULL)
  )`;
}

function optionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function insertOfferTimelineMessage(client, {
  offerId,
  senderId,
  text,
  actionType,
  price,
  quantity,
  unit,
}) {
  const { rows } = await client.query(`
    INSERT INTO messages (
      offer_id,
      sender_id,
      text,
      action_type,
      price_snapshot,
      quantity_snapshot,
      unit_snapshot
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
  `, [
    offerId,
    senderId,
    optionalText(text),
    actionType,
    price ?? null,
    quantity ?? null,
    unit ?? null,
  ]);
  return rows[0];
}

async function upsertLatestOfferTimelineMessage(client, {
  offerId,
  senderId,
  text,
  textProvided = true,
  actionType,
  price,
  quantity,
  unit,
}) {
  const { rows } = await client.query(`
    UPDATE messages
    SET text=CASE WHEN $8 THEN $1 ELSE text END,
        price_snapshot=$2,
        quantity_snapshot=$3,
        unit_snapshot=$4,
        updated_at=NOW()
    WHERE id = (
      SELECT id
      FROM messages
      WHERE offer_id=$5 AND sender_id=$6 AND action_type=$7
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING *
  `, [
    optionalText(text),
    price ?? null,
    quantity ?? null,
    unit ?? null,
    offerId,
    senderId,
    actionType,
    textProvided,
  ]);
  if (rows.length) return rows[0];
  return insertOfferTimelineMessage(client, {
    offerId,
    senderId,
    text,
    actionType,
    price,
    quantity,
    unit,
  });
}

async function acceptOffer(client, offer) {
  const { rows: acceptedSiblingRows } = await client.query(`
    SELECT id FROM offers
    WHERE listing_id=$1 AND buyer_id=$2 AND id<>$3 AND status='accepted'
    LIMIT 1
  `, [offer.listing_id, offer.buyer_id, offer.id]);
  if (acceptedSiblingRows.length) {
    const error = new Error('Bu kullanıcı için daha önce bir teklif kabul edilmiş.');
    error.statusCode = 409;
    throw error;
  }

  const { rows: acceptedRows } = await client.query(`
    UPDATE offers
    SET status='accepted', counter_price=NULL, counter_by=NULL,
        rejection_source=NULL, updated_at=NOW()
    WHERE id=$1 AND status IN ('pending','countered')
    RETURNING *
  `, [offer.id]);
  if (!acceptedRows.length) {
    const error = new Error('Bu teklif artık kabul edilmeye uygun değil.');
    error.statusCode = 400;
    throw error;
  }

  await client.query(`
    UPDATE offers
    SET status='rejected', rejection_source='superseded',
        counter_price=NULL, counter_by=NULL, updated_at=NOW()
    WHERE listing_id=$1 AND buyer_id=$2 AND id<>$3
      AND status IN ('pending','countered')
  `, [offer.listing_id, offer.buyer_id, offer.id]);

  const { rows: listingRows } = await client.query(`
    UPDATE listings
    SET fulfilled_quantity=fulfilled_quantity + $2, updated_at=NOW()
    WHERE id=$1 AND status='active'
    RETURNING *, GREATEST(quantity - fulfilled_quantity, 0) AS remaining_quantity
  `, [offer.listing_id, offer.quantity]);
  if (!listingRows.length) {
    const error = new Error('Bu ilan artık teklif kabul etmeye uygun değil.');
    error.statusCode = 400;
    throw error;
  }

  const listing = listingRows[0];
  let autoRejectedOffers = [];
  const isFulfilled = Number(listing.fulfilled_quantity) >= Number(listing.quantity);
  if (isFulfilled) {
    await client.query(`
      UPDATE listings
      SET status='reserved', reserved_at=NOW(),
          reserved_until=NOW() + INTERVAL '7 days', updated_at=NOW()
      WHERE id=$1
    `, [offer.listing_id]);
    const { rows } = await client.query(`
      UPDATE offers
      SET status='rejected', rejection_source='listing_fulfilled',
          counter_price=NULL, counter_by=NULL, updated_at=NOW()
      WHERE listing_id=$1 AND status IN ('pending','countered')
      RETURNING id, buyer_id
    `, [offer.listing_id]);
    autoRejectedOffers = rows;
  }

  return {
    offer: acceptedRows[0],
    listing,
    isFulfilled,
    autoRejectedOffers,
  };
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
          'listing_type', l.listing_type,
          'quantity', l.quantity,
          'fulfilled_quantity', l.fulfilled_quantity,
          'remaining_quantity', GREATEST(l.quantity - l.fulfilled_quantity, 0),
          'status', l.status
        ) AS listing,
        CASE
          WHEN o.buyer_id = $1 THEN json_build_object('id', seller.id, 'name', seller.name, 'phone', seller.phone, 'phone_verified', seller.phone_verified, 'rating', seller.rating, 'is_verified', seller.is_verified)
          ELSE json_build_object('id', buyer.id, 'name', buyer.name, 'phone', buyer.phone, 'phone_verified', buyer.phone_verified, 'rating', buyer.rating, 'is_verified', buyer.is_verified)
        END AS other_user,
        last_message.text AS last_message,
        last_message.created_at AS last_message_at
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users buyer ON buyer.id = o.buyer_id
      JOIN users seller ON seller.id = l.seller_id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            NULLIF(text, ''),
            CASE action_type
              WHEN 'initial_offer' THEN 'Teklif verildi'
              WHEN 'seller_counter' THEN 'Karşı teklif verildi'
              WHEN 'buyer_counter' THEN 'Son teklif verildi'
              ELSE NULL
            END
          ) AS text,
          created_at
        FROM messages
        WHERE offer_id = o.id
        ORDER BY created_at DESC
        LIMIT 1
      ) last_message ON true
      WHERE o.status = 'accepted'
        AND ${chatAccessWhere('o')}
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (
            ub.blocker_id = $1
            AND ub.blocked_id = CASE WHEN o.buyer_id = $1 THEN l.seller_id ELSE o.buyer_id END
          ) OR (
            ub.blocked_id = $1
            AND ub.blocker_id = CASE WHEN o.buyer_id = $1 THEN l.seller_id ELSE o.buyer_id END
          )
        )
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
      WHERE o.id=$1 AND o.status IN ('accepted','completed')
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
  body('message').optional({ nullable: true }).trim(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { reviewee_id, rating, message } = req.body;
    const { rows: offerRows } = await client.query(`
      SELECT o.id, o.buyer_id, l.seller_id,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users buyer ON buyer.id = o.buyer_id
      JOIN users seller ON seller.id = l.seller_id
      WHERE o.id=$1
        AND (
          o.status IN ('accepted','completed')
          OR (o.status='rejected' AND o.rejection_source='manual')
        )
    `, [req.params.id]);
    if (!offerRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Değerlendirmeye uygun teklif bulunamadı.' });
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
    `, [
      req.params.id,
      req.user.id,
      reviewee_id,
      rating,
      String(message || '').trim() || null,
    ]);

    await client.query(`
      UPDATE users
      SET rating = COALESCE((SELECT AVG(rating)::numeric(3,2) FROM reviews WHERE reviewee_id=$1), 0),
          total_trades = (SELECT COUNT(*) FROM reviews WHERE reviewee_id=$1),
          updated_at = NOW()
      WHERE id=$1
    `, [reviewee_id]);

    await client.query('COMMIT');
    const reviewerName = isBuyer ? offer.buyer_name : offer.seller_name;
    sendNotification('reviewReceived', notify.reviewReceived({
      revieweeId: reviewee_id,
      reviewerName,
      rating,
      offerId: req.params.id,
      hasMessage: Boolean(String(message || '').trim()),
    }));
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
          'district',l.district,'unit',l.unit,'price_per_unit',l.price_per_unit,
          'listing_type',l.listing_type,'quantity',l.quantity,
          'fulfilled_quantity',l.fulfilled_quantity,
          'remaining_quantity',GREATEST(l.quantity-l.fulfilled_quantity,0)) AS listing,
        json_build_object('id',u.id,'name',u.name,'phone',u.phone,'phone_verified',u.phone_verified) AS seller
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users u ON u.id = l.seller_id
      WHERE o.buyer_id = $1
        AND o.buyer_deleted_at IS NULL
        AND (l.status <> 'reserved' OR o.status IN ('accepted','rejected'))
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = l.seller_id)
             OR (ub.blocked_id = $1 AND ub.blocker_id = l.seller_id)
        )
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
        json_build_object('id',l.id,'crop_name',l.crop_name,'city',l.city,'district',l.district,'unit',l.unit,'price_per_unit',l.price_per_unit,
          'listing_type',l.listing_type,'quantity',l.quantity,
          'fulfilled_quantity',l.fulfilled_quantity,
          'remaining_quantity',GREATEST(l.quantity-l.fulfilled_quantity,0)) AS listing,
        json_build_object('id',u.id,'name',u.name,'phone',u.phone,'phone_verified',u.phone_verified,'rating',u.rating,'is_verified',u.is_verified) AS buyer
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      JOIN users u ON u.id = o.buyer_id
      WHERE l.seller_id = $1 AND o.seller_deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = $1 AND ub.blocked_id = o.buyer_id)
             OR (ub.blocked_id = $1 AND ub.blocker_id = o.buyer_id)
        )
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
      "SELECT l.*, u.name AS seller_name FROM listings l JOIN users u ON u.id=l.seller_id WHERE l.id=$1 AND l.status='active' FOR UPDATE OF l",
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

    const { rows: blockRows } = await client.query(`
      SELECT 1 FROM user_blocks
      WHERE (blocker_id=$1 AND blocked_id=$2)
         OR (blocker_id=$2 AND blocked_id=$1)
      LIMIT 1
    `, [req.user.id, listing.seller_id]);
    if (blockRows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Bu kullanıcıyla etkileşim kuramazsınız.' });
    }

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [String(listing_id), String(req.user.id)]
    );
    const { rows: openOfferRows } = await client.query(`
      SELECT id FROM offers
      WHERE listing_id=$1 AND buyer_id=$2
        AND status IN ('pending','countered','accepted')
      ORDER BY created_at DESC
      LIMIT 1
    `, [listing_id, req.user.id]);
    if (openOfferRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Bu ilan için zaten açık bir teklifiniz var.',
        existing_offer_id: openOfferRows[0].id,
      });
    }

    const { rows } = await client.query(`
      INSERT INTO offers (listing_id,buyer_id,offered_price,quantity,message)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [listing_id, req.user.id, offered_price, quantity, message||null]);

    await insertOfferTimelineMessage(client, {
      offerId: rows[0].id,
      senderId: req.user.id,
      text: message,
      actionType: 'initial_offer',
      price: offered_price,
      quantity,
      unit: listing.unit,
    });

    await client.query('UPDATE listings SET offer_count=offer_count+1 WHERE id=$1', [listing_id]);

    const { rows: buyerRows } = await client.query('SELECT name FROM users WHERE id=$1', [req.user.id]);

    await client.query('COMMIT');

    sendNotification('newOffer', notify.newOffer({
      ownerId:       listing.seller_id,
      proposerName:  buyerRows[0]?.name || (listing.listing_type === 'buy' ? 'Bir satıcı' : 'Bir alıcı'),
      cropName:      listing.crop_name,
      offeredPrice:  offered_price,
      unit:          listing.unit,
      offerId:       rows[0].id,
      listingId:     listing_id,
      listingType:   listing.listing_type,
    }));

    res.status(201).json({
      ...rows[0],
      listing: {
        id: listing.id,
        crop_name: listing.crop_name,
        city: listing.city,
        district: listing.district,
        unit: listing.unit,
        price_per_unit: listing.price_per_unit,
        listing_type: listing.listing_type,
        quantity: listing.quantity,
        fulfilled_quantity: listing.fulfilled_quantity,
        remaining_quantity: Math.max(
          Number(listing.quantity) - Number(listing.fulfilled_quantity),
          0
        ),
      },
      seller: {
        id: listing.seller_id,
        name: listing.seller_name,
      },
    });
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
    const { status, counter_price, message } = req.body;
    let acceptance = null;

    const { rows: offerRows } = await client.query(`
      SELECT o.*, l.seller_id, l.crop_name, l.unit, l.listing_type,
             l.status AS listing_status,
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

    if (
      !['pending', 'countered'].includes(offer.status) ||
      (offer.status === 'countered' && offer.counter_by !== 'buyer')
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu teklif artık yanıtlanmaya uygun değil.' });
    }
    if (status === 'countered' && !(Number(counter_price) > 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Geçerli bir karşı teklif fiyatı girin.' });
    }

    let rows;
    if (status === 'accepted') {
      acceptance = await acceptOffer(client, offer);
      rows = [acceptance.offer];
    } else {
      const counterBy = status === 'countered' ? 'seller' : null;
      ({ rows } = await client.query(`
        UPDATE offers
        SET status=$1, counter_price=$2, counter_by=$3,
            rejection_source=$4, updated_at=NOW()
        WHERE id=$5 RETURNING *
      `, [
        status,
        status === 'countered' ? counter_price : null,
        counterBy,
        status === 'rejected' ? 'manual' : null,
        req.params.id,
      ]));
    }

    if (status === 'countered') {
      await insertOfferTimelineMessage(client, {
        offerId: req.params.id,
        senderId: req.user.id,
        text: message,
        actionType: 'seller_counter',
        price: counter_price,
        quantity: offer.quantity,
        unit: offer.unit,
      });
    }

    await client.query('COMMIT');

    if (status === 'accepted') {
      sendNotification('offerAccepted', notify.offerAccepted({
        recipientId: offer.buyer_id,
        actorName: offer.seller_name,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      }));
      acceptance.autoRejectedOffers.forEach((rejectedOffer) => {
        sendNotification('offerAutoRejected', notify.offerAutoRejected({
          recipientId: rejectedOffer.buyer_id,
          ownerName: offer.seller_name,
          cropName: offer.crop_name,
          offerId: rejectedOffer.id,
          listingId: offer.listing_id,
          reason: 'listing_fulfilled',
        }));
      });
    } else if (status === 'rejected') {
      sendNotification('offerRejected', notify.offerRejected({
        recipientId: offer.buyer_id,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      }));
    } else if (status === 'countered') {
      sendNotification('counterOffer', notify.counterOffer({
        recipientId: offer.buyer_id,
        senderName: offer.seller_name,
        cropName: offer.crop_name,
        counterPrice: counter_price,
        unit: offer.unit,
        offerId: req.params.id,
        madeBy: 'seller',
        actorRole: offer.listing_type === 'buy' ? 'Alıcı' : 'Satıcı',
        listingId: offer.listing_id,
      }));
    }

    res.json(status === 'accepted' ? {
      ...rows[0],
      listing_fulfilled: acceptance.isFulfilled,
      listing_fulfilled_quantity: acceptance.listing.fulfilled_quantity,
      listing_remaining_quantity: acceptance.listing.remaining_quantity,
    } : rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally { client.release(); }
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
    const { status, counter_price, message } = req.body;
    let acceptance = null;

    const { rows: offerRows } = await client.query(`
      SELECT o.*, l.seller_id, l.crop_name, l.unit, l.listing_type,
             l.status AS listing_status,
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
    if (offer.counter_by !== 'seller') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Kendi son teklifinize yanıt veremezsiniz.' });
    }
    if (status === 'accepted' && offer.listing_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu ilan artık teklif kabul etmeye uygun değil.' });
    }
    if (status === 'countered' && !(Number(counter_price) > 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Geçerli bir son teklif fiyatı girin.' });
    }

    let rows;
    if (status === 'accepted') {
      acceptance = await acceptOffer(client, offer);
      rows = [acceptance.offer];
    } else {
      const counterBy = status === 'countered' ? 'buyer' : null;
      ({ rows } = await client.query(`
        UPDATE offers
        SET status=$1, counter_price=$2, counter_by=$3,
            rejection_source=$4, updated_at=NOW()
        WHERE id=$5 RETURNING *
      `, [
        status,
        status === 'countered' ? counter_price : null,
        counterBy,
        status === 'rejected' ? 'manual' : null,
        req.params.id,
      ]));
    }

    if (status === 'countered') {
      await insertOfferTimelineMessage(client, {
        offerId: req.params.id,
        senderId: req.user.id,
        text: message,
        actionType: 'buyer_counter',
        price: counter_price,
        quantity: offer.quantity,
        unit: offer.unit,
      });
    }

    await client.query('COMMIT');

    if (status === 'accepted') {
      sendNotification('offerAccepted', notify.offerAccepted({
        recipientId: offer.seller_id,
        actorName: offer.buyer_name,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
        acceptedCounter: true,
      }));
      acceptance.autoRejectedOffers.forEach((rejectedOffer) => {
        sendNotification('offerAutoRejected', notify.offerAutoRejected({
          recipientId: rejectedOffer.buyer_id,
          ownerName: offer.seller_name,
          cropName: offer.crop_name,
          offerId: rejectedOffer.id,
          listingId: offer.listing_id,
          reason: 'listing_fulfilled',
        }));
      });
    } else if (status === 'rejected') {
      sendNotification('offerRejected', notify.offerRejected({
        recipientId: offer.seller_id,
        cropName: offer.crop_name,
        offerId: req.params.id,
        listingId: offer.listing_id,
      }));
    } else if (status === 'countered') {
      sendNotification('finalOffer', notify.finalOffer({
        recipientId: offer.seller_id,
        proposerName: offer.buyer_name,
        cropName: offer.crop_name,
        finalPrice: counter_price,
        unit: offer.unit,
        offerId: req.params.id,
        listingId: offer.listing_id,
      }));
    }

    res.json(status === 'accepted' ? {
      ...rows[0],
      listing_fulfilled: acceptance.isFulfilled,
      listing_fulfilled_quantity: acceptance.listing.fulfilled_quantity,
      listing_remaining_quantity: acceptance.listing.remaining_quantity,
    } : rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally { client.release(); }
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
    const { counter_price, message } = req.body;
    const textProvided = Object.prototype.hasOwnProperty.call(req.body, 'message');
    const { rows: offerRows } = await client.query(
      'SELECT o.*, l.seller_id, l.unit FROM offers o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1',
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
    await upsertLatestOfferTimelineMessage(client, {
      offerId: req.params.id,
      senderId: req.user.id,
      text: message,
      textProvided,
      actionType: isSeller ? 'seller_counter' : 'buyer_counter',
      price: counter_price,
      quantity: offerRows[0].quantity,
      unit: offerRows[0].unit,
    });
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
      "UPDATE offers SET status='pending', counter_price=NULL, counter_by=NULL, rejection_source=NULL, updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    await client.query('COMMIT');

    const recipientId = isSeller ? offer.buyer_id : offer.seller_id;
    const senderName  = isSeller ? offer.seller_name : offer.buyer_name;
    sendNotification('counterCancelled', notify.counterCancelled({
      recipientId,
      senderName,
      cropName: offer.crop_name,
      offerId: req.params.id,
      listingId: offer.listing_id,
    }));

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
    SELECT o.id, o.buyer_id, l.seller_id, o.listing_id,
           buyer.name AS buyer_name, seller.name AS seller_name
    FROM offers o
    JOIN listings l ON l.id = o.listing_id
    JOIN users buyer ON buyer.id = o.buyer_id
    JOIN users seller ON seller.id = l.seller_id
    WHERE o.id=$1 AND o.status='accepted'
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks ub
        WHERE (
          ub.blocker_id = $2
          AND ub.blocked_id = CASE WHEN o.buyer_id = $2 THEN l.seller_id ELSE o.buyer_id END
        ) OR (
          ub.blocked_id = $2
          AND ub.blocker_id = CASE WHEN o.buyer_id = $2 THEN l.seller_id ELSE o.buyer_id END
        )
      )
  `, [offerId, userId]);
  if (!rows.length) return null;
  const offer = rows[0];
  if (offer.buyer_id !== userId && offer.seller_id !== userId) return null;
  return offer;
}

async function requireOfferParticipant(offerId, userId) {
  const { rows } = await query(`
    SELECT o.id, o.buyer_id, l.seller_id, o.listing_id,
           buyer.name AS buyer_name, seller.name AS seller_name
    FROM offers o
    JOIN listings l ON l.id = o.listing_id
    JOIN users buyer ON buyer.id = o.buyer_id
    JOIN users seller ON seller.id = l.seller_id
    WHERE o.id=$1
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks ub
        WHERE (
          ub.blocker_id = $2
          AND ub.blocked_id = CASE WHEN o.buyer_id = $2 THEN l.seller_id ELSE o.buyer_id END
        ) OR (
          ub.blocked_id = $2
          AND ub.blocker_id = CASE WHEN o.buyer_id = $2 THEN l.seller_id ELSE o.buyer_id END
        )
      )
  `, [offerId, userId]);
  if (!rows.length) return null;
  const offer = rows[0];
  if (offer.buyer_id !== userId && offer.seller_id !== userId) return null;
  return offer;
}

// GET /api/offers/:id/messages
router.get('/:id/messages', authMiddleware, async (req, res, next) => {
  try {
    const offer = await requireOfferParticipant(req.params.id, req.user.id);
    if (!offer) return res.status(404).json({ error: 'Mesaj geçmişi bulunamadı.' });

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
    const isBuyer = offer.buyer_id === req.user.id;
    sendNotification('chatMessage', notify.chatMessage({
      recipientId: isBuyer ? offer.seller_id : offer.buyer_id,
      senderName: isBuyer ? offer.buyer_name : offer.seller_name,
      text: req.body.text,
      offerId: req.params.id,
      listingId: offer.listing_id,
    }));
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
