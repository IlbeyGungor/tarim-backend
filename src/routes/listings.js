const router = require('express').Router();
const { body, query: qv, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const { rateLimit } = require('express-rate-limit');
const mailer = require('../services/mailer');
const notify = require('../utils/notify');
const {
  isListingUnit,
  areListingUnitsCompatible,
} = require('../utils/listingUnits');

function sendNotification(type, promise) {
  promise.catch((err) => {
    console.error(`[notification] ${type} failed:`, err);
  });
}

// Reusable query to get full listing with seller info
const LISTING_SELECT = `
  SELECT
    l.*,
    GREATEST(l.quantity - l.fulfilled_quantity, 0) AS remaining_quantity,
    json_build_object(
      'id', u.id, 'name', u.name, 'phone', u.phone,
      'phone_verified', u.phone_verified, 'city', u.city, 'district', u.district,
      'tc_verified', u.tc_verified, 'cks_verified', u.cks_verified,
      'is_verified', u.is_verified, 'rating', u.rating,
      'total_trades', u.total_trades, 'profile_image', u.profile_image
    ) AS seller
  FROM listings l
  JOIN users u ON u.id = l.seller_id
`;

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Çok fazla bildirim denemesi yapıldı. Lütfen daha sonra tekrar deneyin.',
  },
});

// GET /api/listings  (public, with optional filters)
router.get('/', authMiddleware.optional, async (req, res, next) => {
  try {
    const { search, category, city, listing_type, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = ["l.status = 'active'", "u.account_status = 'active'"];

    if (status && status !== 'active') {
      return res.json({
        listings: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
      });
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(l.crop_name ILIKE $${params.length} OR l.city ILIKE $${params.length} OR l.district ILIKE $${params.length})`);
    }
    if (category) { params.push(category); conditions.push(`l.category = $${params.length}`); }
    if (city)     { params.push(city);     conditions.push(`l.city = $${params.length}`); }
    if (listing_type) {
      if (!['sell', 'buy'].includes(listing_type)) {
        return res.status(400).json({ error: 'Geçersiz ilan tipi.' });
      }
      params.push(listing_type);
      conditions.push(`l.listing_type = $${params.length}`);
    }
    if (req.user) {
      params.push(req.user.id);
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM user_blocks ub
        WHERE (ub.blocker_id = $${params.length} AND ub.blocked_id = l.seller_id)
           OR (ub.blocker_id = l.seller_id AND ub.blocked_id = $${params.length})
      )`);
    }

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
router.get('/:id', authMiddleware.optional, async (req, res, next) => {
  try {
    const { rows } = await query(
      `${LISTING_SELECT} WHERE l.id=$1 AND u.account_status='active'`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'İlan bulunamadı.' });

    const listing = rows[0];
    if (req.user && listing.seller_id !== req.user.id) {
      const { rows: blockRows } = await query(`
        SELECT 1 FROM user_blocks
        WHERE (blocker_id=$1 AND blocked_id=$2)
           OR (blocker_id=$2 AND blocked_id=$1)
        LIMIT 1
      `, [req.user.id, listing.seller_id]);
      if (blockRows.length) {
        return res.status(404).json({ error: 'İlan bulunamadı.' });
      }
    }
    if (listing.status === 'reserved') {
      if (!req.user) return res.status(404).json({ error: 'İlan bulunamadı.' });

      const { rows: accessRows } = await query(
        `SELECT 1 FROM offers
         WHERE listing_id=$1 AND buyer_id=$2 AND status='accepted'
         LIMIT 1`,
        [req.params.id, req.user.id]
      );
      const canAccessReserved =
        listing.seller_id === req.user.id || accessRows.length > 0;
      if (!canAccessReserved) {
        return res.status(404).json({ error: 'İlan bulunamadı.' });
      }
    } else if (listing.status !== 'active') {
      const isOwner = req.user && listing.seller_id === req.user.id;
      if (!isOwner) return res.status(404).json({ error: 'İlan bulunamadı.' });
    }

    // Increment view count
    await query('UPDATE listings SET view_count = view_count + 1 WHERE id=$1', [req.params.id]);
    res.json(listing);
  } catch (err) { next(err); }
});

// POST /api/listings/:id/reports  (public)
router.post('/:id/reports', reportLimiter, async (req, res, next) => {
  try {
    const { reason, description, listing, reporter } = req.body;

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error: 'Bildirim sebebi zorunludur.',
      });
    }

    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.REPORT_TO_EMAIL || 'ilbey.gungor@outlook.com',
      subject: 'Tarım Pazar Uygunsuz İçerik Bildirimi',
      text: `
Sebep: ${reason}
Açıklama: ${description || '-'}

İlan ID: ${req.params.id}
Ürün: ${listing?.crop_name || '-'}
Fiyat: ${listing?.price || listing?.price_per_unit || '-'}
Miktar: ${listing?.quantity || '-'}
Konum: ${listing?.location_display || [listing?.city, listing?.district].filter(Boolean).join(' / ') || '-'}
İlan tipi: ${listing?.listing_type === 'buy' ? 'Aranıyor' : 'Satılık'}
İlan sahibi: ${listing?.seller_name || listing?.seller?.name || '-'} (${listing?.seller_id || listing?.seller?.id || '-'})

Bildiren: ${reporter?.name || 'Misafir'} (${reporter?.id || '-'})
Telefon: ${reporter?.phone || '-'}

Fotoğraflar:
${(listing?.image_urls || []).join('\n') || '-'}
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Report mail error:', err);
    next(err);
  }
});

// POST /api/listings  (auth required)
router.post('/', authMiddleware, [
  body('listing_type').optional().isIn(['sell','buy']),
  body('crop_name').trim().notEmpty().withMessage('Ürün adı zorunludur.'),
  body('category').isIn(['grain','vegetable','fruit','nut','legume','other']),
  body('quantity').isFloat({ gt: 0 }),
  body('unit').optional().custom(isListingUnit),
  body('price_unit').optional().custom(isListingUnit),
  body('price_per_unit').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('price_type').optional().isIn(['fixed','negotiate']),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const {
      listing_type = 'sell', crop_name, category, quantity, unit = 'kg',
      price_per_unit, price_unit = unit, price_type = 'negotiate',
      city, district, address, description, harvest_date
    } = req.body;

    if (!areListingUnitsCompatible(unit, price_unit)) {
      return res.status(400).json({ error: 'Miktar ve fiyat birimleri birbiriyle uyumlu değil.' });
    }
    const normalizedPrice = price_per_unit == null || price_per_unit === ''
      ? null
      : Number(price_per_unit);
    const normalizedPriceType = normalizedPrice == null ? 'negotiate' : price_type;

    const { rows } = await query(`
      INSERT INTO listings
        (seller_id,listing_type,crop_name,category,quantity,unit,price_per_unit,price_unit,price_type,city,district,address,description,harvest_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [req.user.id, listing_type, crop_name, category, quantity, unit, normalizedPrice, price_unit, normalizedPriceType,
        city||null, district||null, address||null, description||null, harvest_date||null]);

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/listings/:id/close  (auth, owner only)
router.post('/:id/close', authMiddleware, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows: listingRows } = await client.query(`
      SELECT l.*, u.name AS owner_name
      FROM listings l
      JOIN users u ON u.id=l.seller_id
      WHERE l.id=$1
      FOR UPDATE OF l
    `, [req.params.id]);
    if (!listingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'İlan bulunamadı.' });
    }
    const listing = listingRows[0];
    if (listing.seller_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Yetki yok.' });
    }
    if (listing.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Yalnızca aktif ilan kapatılabilir.' });
    }

    const { rows: rejectedOffers } = await client.query(`
      UPDATE offers
      SET status='rejected', rejection_source='listing_closed',
          counter_price=NULL, counter_by=NULL, updated_at=NOW()
      WHERE listing_id=$1 AND status IN ('pending','countered')
      RETURNING id, buyer_id
    `, [req.params.id]);
    const { rows } = await client.query(`
      UPDATE listings
      SET status='reserved', reserved_at=NOW(),
          reserved_until=NOW() + INTERVAL '7 days', updated_at=NOW()
      WHERE id=$1
      RETURNING *, GREATEST(quantity - fulfilled_quantity, 0) AS remaining_quantity
    `, [req.params.id]);
    await client.query('COMMIT');

    rejectedOffers.forEach((offer) => {
      sendNotification('offerAutoRejected', notify.offerAutoRejected({
        recipientId: offer.buyer_id,
        ownerName: listing.owner_name,
        cropName: listing.crop_name,
        offerId: offer.id,
        listingId: listing.id,
        reason: 'listing_closed',
      }));
    });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/listings/:id  (auth, owner only)
router.patch('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { rows: existing } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (existing[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });
    if (req.body.quantity !== undefined) {
      const quantity = Number(req.body.quantity);
      if (!Number.isFinite(quantity) || quantity <= Number(existing[0].fulfilled_quantity)) {
        return res.status(400).json({
          error: 'Hedef miktar kabul edilmiş miktardan büyük olmalıdır.',
        });
      }
    }
    if (req.body.price_per_unit !== undefined && req.body.price_per_unit !== null &&
        req.body.price_per_unit !== '' && !(Number(req.body.price_per_unit) > 0)) {
      return res.status(400).json({ error: 'Birim fiyat sıfırdan büyük olmalıdır.' });
    }
    if (req.body.price_type !== undefined &&
        !['fixed', 'negotiate'].includes(req.body.price_type)) {
      return res.status(400).json({ error: 'Geçersiz fiyat tipi.' });
    }

    const nextUnit = req.body.unit ?? existing[0].unit;
    const nextPriceUnit = req.body.price_unit ?? existing[0].price_unit ?? nextUnit;
    if (!isListingUnit(nextUnit) || !isListingUnit(nextPriceUnit) ||
        !areListingUnitsCompatible(nextUnit, nextPriceUnit)) {
      return res.status(400).json({ error: 'Miktar ve fiyat birimleri birbiriyle uyumlu değil.' });
    }

    const priceWasProvided = Object.prototype.hasOwnProperty.call(req.body, 'price_per_unit');
    const finalPrice = priceWasProvided
      ? (req.body.price_per_unit === '' ? null : req.body.price_per_unit)
      : existing[0].price_per_unit;
    if (finalPrice == null) {
      req.body.price_per_unit = null;
      req.body.price_type = 'negotiate';
    }

    const allowed = ['crop_name','quantity','unit','price_per_unit','price_unit','price_type','description','harvest_date'];
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
