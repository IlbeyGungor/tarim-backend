// ── Market Prices ──────────────────────────────────────────────────────────
const pricesRouter = require('express').Router();
const admin = require('firebase-admin');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { rateLimit } = require('express-rate-limit');
const mailer = require('../services/mailer');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Sadece görsel dosyaları kabul edilir.'));
  },
});

function ensureFirebaseAdmin() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT tanımlı değil.');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// GET /api/prices  (public)
// Ana liste için: her ürün + hal kombinasyonunun son mümkün fiyatı
// GET /api/prices  (public)
pricesRouter.get('/', async (req, res, next) => {
  try {
    const scope = String(req.query.scope || 'national').trim().toLowerCase();
    const productionType = String(req.query.production_type || 'Geleneksel').trim();

    const search = String(req.query.search || '').trim();
    const city = String(req.query.city || '').trim();
    const product = String(req.query.product || '').trim();

    const loadAllRaw = String(req.query.all || 'false').trim().toLowerCase();
    const loadAll = loadAllRaw === 'true' || loadAllRaw === '1';

    // App ilk açıldığında bunu kullanır:
    // /api/prices?production_type=Geleneksel&all=true
    //
    // Burada scope filtresi YOK.
    // Hem national hem market kayıtları döner.
    if (loadAll) {
      const { rows } = await query(`
        SELECT
          id::text AS id,
          product,
          TRIM(scope) AS scope,
          market,
          city,
          TRIM(production_type) AS production_type,
          icon,
          min_price,
          max_price,
          avg_price,
          unit,
          trend,
          latest_price_date
        FROM market_price_latest
        WHERE LOWER(TRIM(production_type)) = LOWER(TRIM($1))
          AND LOWER(TRIM(scope)) IN ('national', 'market')
        ORDER BY
          CASE
            WHEN icon IS NULL OR TRIM(icon) = '' THEN 1
            ELSE 0
          END,
          icon ASC,
          product ASC,
          city ASC,
          market ASC
        LIMIT 10000
      `, [productionType]);

      console.log("🚨 /api/prices all=true total:", rows.length);
      console.log("🚨 national count:", rows.filter(r => r.scope === "national").length);
      console.log("🚨 market count:", rows.filter(r => r.scope === "market").length);

      return res.json(rows);
    }

    // Eski filtreli endpoint desteği.
    const params = [];
    const conditions = [];
    let i = 1;

    conditions.push(`LOWER(TRIM(production_type)) = LOWER(TRIM($${i}))`);
    params.push(productionType);
    i++;

    conditions.push(`LOWER(TRIM(scope)) = LOWER(TRIM($${i}))`);
    params.push(scope);
    i++;

    const hasSearch =
      scope === 'national'
        ? search.length > 0
        : city.length > 0 || product.length > 0;

    // İlk açılışta sadece icon'u olanlar
    if (!hasSearch) {
      conditions.push(`icon IS NOT NULL`);
      conditions.push(`TRIM(icon) <> ''`);
    }

    if (scope === 'national' && search) {
      conditions.push(`
        (
          product ILIKE $${i}
          OR city ILIKE $${i}
          OR market ILIKE $${i}
        )
      `);
      params.push(`%${search}%`);
      i++;
    }

    if (scope === 'market') {
      if (city) {
        conditions.push(`
          (
            city ILIKE $${i}
            OR market ILIKE $${i}
          )
        `);
        params.push(`%${city}%`);
        i++;
      }

      if (product) {
        conditions.push(`product ILIKE $${i}`);
        params.push(`%${product}%`);
        i++;
      }
    }

    const { rows } = await query(`
      SELECT
        id::text AS id,
        product,
        TRIM(scope) AS scope,
        market,
        city,
        TRIM(production_type) AS production_type,
        icon,
        min_price,
        max_price,
        avg_price,
        unit,
        trend,
        latest_price_date
      FROM market_price_latest
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE
          WHEN icon IS NULL OR TRIM(icon) = '' THEN 1
          ELSE 0
        END,
        icon ASC,
        product ASC,
        city ASC,
        market ASC
      LIMIT 10000
    `, params);

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

// GET /api/prices/:id/history-1y
// Detay ekranı için sadece açılan ürünün 1 yıllık özet geçmişini döndürür.
pricesRouter.get('/:id/history-1y', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT COALESCE(history_1y, '[]'::jsonb) AS history_1y
      FROM market_price_latest
      WHERE id = $1
      LIMIT 1
    `, [req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Hal fiyatı bulunamadı.' });
    }

    res.json(rows[0].history_1y || []);
  } catch (err) {
    next(err);
  }
});

// ── Users ──────────────────────────────────────────────────────────────────
const usersRouter = require('express').Router();

const USER_LISTING_SELECT = `
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
  JOIN users u ON u.id=l.seller_id
`;

// POST /api/users/me/profile-image  (auth required)
usersRouter.post(
  '/me/profile-image',
  authMiddleware,
  profileImageUpload.single('image'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Görsel seçilmedi.' });
      }

      const imageUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `tarim-pazar/users/${req.user.id}`,
            transformation: [
              { width: 512, height: 512, crop: 'fill', gravity: 'auto' },
              { quality: 'auto:good' },
              { fetch_format: 'auto' },
            ],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        stream.end(req.file.buffer);
      });

      const { rows } = await query(
        `UPDATE users
         SET profile_image=$1, updated_at=NOW()
         WHERE id=$2
         RETURNING id,name,phone,phone_verified,city,district,bio,tc_verified,cks_verified,
                   is_verified,rating,total_trades,profile_image,created_at`,
        [imageUrl, req.user.id]
      );

      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

const userReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Çok fazla bildirim denemesi yapıldı. Lütfen daha sonra tekrar deneyin.',
  },
});

// POST /api/users/:id/block  (auth required)
usersRouter.post('/:id/block', authMiddleware, async (req, res, next) => {
  try {
    const blockedId = req.params.id;
    if (blockedId === req.user.id) {
      return res.status(400).json({ error: 'Kendinizi engelleyemezsiniz.' });
    }

    const { rows } = await query('SELECT id FROM users WHERE id=$1', [blockedId]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    await query(`
      INSERT INTO user_blocks (blocker_id, blocked_id)
      VALUES ($1, $2)
      ON CONFLICT (blocker_id, blocked_id) DO NOTHING
    `, [req.user.id, blockedId]);

    try {
      await mailer.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.REPORT_TO_EMAIL || 'ilbey.gungor@outlook.com',
        subject: 'Tarım Pazar Kullanıcı Engelleme Bildirimi',
        text: `
Engelleyen kullanıcı ID: ${req.user.id}
Engellenen kullanıcı ID: ${blockedId}
Tarih: ${new Date().toISOString()}
Sebep: Diğer
Açıklama: Kullanıcı engelleme aksiyonu
        `,
      });
    } catch (mailErr) {
      console.error('User block notification mail error:', mailErr);
    }

    res.json({ ok: true, blocked_user_id: blockedId });
  } catch (err) { next(err); }
});

// DELETE /api/users/:id/block  (auth required)
usersRouter.delete('/:id/block', authMiddleware, async (req, res, next) => {
  try {
    await query(
      'DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2',
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, blocked_user_id: req.params.id });
  } catch (err) { next(err); }
});

// POST /api/users/:id/reports  (public)
usersRouter.post('/:id/reports', userReportLimiter, async (req, res, next) => {
  try {
    const { reason, description, reportedUser, reporter } = req.body;

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error: 'Bildirim sebebi zorunludur.',
      });
    }

    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.REPORT_TO_EMAIL || 'ilbey.gungor@outlook.com',
      subject: 'Tarım Pazar Kullanıcı Bildirimi',
      text: `
Sebep: ${reason}
Açıklama: ${description || '-'}

Bildirilen Kullanıcı ID: ${req.params.id}
Ad Soyad: ${reportedUser?.name || '-'}
Telefon: ${reportedUser?.phone || '-'}
Şehir: ${reportedUser?.city || '-'}
İlçe: ${reportedUser?.district || '-'}
Rol: ${reportedUser?.role || '-'}

Bildiren: ${reporter?.name || 'Misafir'} (${reporter?.id || '-'})
Telefon: ${reporter?.phone || '-'}

Profil Fotoğrafı:
${reportedUser?.profile_image || '-'}
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('User report mail error:', err);
    next(err);
  }
});

// GET /api/users/:id/listings  (public; owner may include reserved listings)
usersRouter.get('/:id/listings', authMiddleware.optional, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = (page - 1) * limit;
    const includeInactive = String(req.query.include_inactive || '').toLowerCase() === 'true';
    const isOwner = req.user?.id === req.params.id;

    if (includeInactive && !isOwner) {
      return res.status(403).json({ error: 'Aktif olmayan ilanları yalnız ilan sahibi görebilir.' });
    }

    const { rows: userRows } = await query(
      "SELECT id FROM users WHERE id=$1 AND account_status='active'",
      [req.params.id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    if (req.user && !isOwner) {
      const { rows: blockRows } = await query(`
        SELECT 1 FROM user_blocks
        WHERE (blocker_id=$1 AND blocked_id=$2)
           OR (blocker_id=$2 AND blocked_id=$1)
        LIMIT 1
      `, [req.user.id, req.params.id]);
      if (blockRows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    }

    const params = [req.params.id];
    const conditions = ['l.seller_id=$1', "u.account_status='active'"];
    conditions.push(includeInactive ? "l.status IN ('active','reserved')" : "l.status='active'");

    const excludeListingId = String(req.query.exclude_listing_id || '').trim();
    if (excludeListingId) {
      params.push(excludeListingId);
      conditions.push(`l.id <> $${params.length}::uuid`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const countParams = [...params];
    params.push(limit, offset);

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `${USER_LISTING_SELECT} ${where} ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(`SELECT COUNT(*) FROM listings l JOIN users u ON u.id=l.seller_id ${where}`, countParams),
    ]);
    const total = Number(countRows[0]?.count || 0);
    res.json({ listings: rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// GET /api/users/:id  (public profile)
usersRouter.get('/:id', authMiddleware.optional, async (req, res, next) => {
  try {
    const requesterEmail = String(req.user?.email || '').trim().toLowerCase();
    const canSeeAdminFields = Boolean(
      req.user?.is_admin &&
      requesterEmail &&
      adminMiddleware.configuredAdminEmails().has(requesterEmail)
    );
    const { rows } = await query(`
      SELECT id,name,phone_verified,city,district,bio,tc_verified,cks_verified,
             is_verified,rating,total_trades,profile_image,created_at,
             CASE WHEN $3::boolean THEN account_status ELSE NULL END AS account_status,
             CASE WHEN $3::boolean THEN is_admin ELSE false END AS is_admin,
             CASE
               WHEN $2::uuid IS NULL THEN false
               ELSE EXISTS (
                 SELECT 1 FROM user_blocks ub
                 WHERE ub.blocker_id = $2 AND ub.blocked_id = users.id
               )
             END AS is_blocked
      FROM users WHERE id=$1
    `, [req.params.id, req.user?.id || null, canSeeAdminFields]);
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/users/:id/reviews
usersRouter.get('/:id/reviews', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT r.*,
        json_build_object('id', reviewer.id, 'name', reviewer.name) AS reviewer,
        json_build_object('id', reviewee.id, 'name', reviewee.name) AS reviewee
      FROM reviews r
      JOIN users reviewer ON reviewer.id = r.reviewer_id
      JOIN users reviewee ON reviewee.id = r.reviewee_id
      WHERE r.reviewee_id=$1
      ORDER BY r.created_at DESC
    `, [req.params.id]);
    res.json(rows);
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
       RETURNING id,name,phone,phone_verified,city,district,bio,tc_verified,cks_verified,is_verified,rating,total_trades,profile_image,created_at`,
      params
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/users/me/phone-verification-attempts — SMS başlamadan önce aylık limit kontrolü
usersRouter.post('/me/phone-verification-attempts', authMiddleware, async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Telefon numarası zorunludur.' });

    const { rows } = await query(`
      WITH recent AS (
        SELECT COUNT(*)::int AS attempt_count
        FROM phone_verification_attempts
        WHERE user_id=$1
          AND created_at >= NOW() - INTERVAL '30 days'
      ),
      inserted AS (
        INSERT INTO phone_verification_attempts (user_id, phone)
        SELECT $1, $2
        FROM recent
        WHERE attempt_count < 5
        RETURNING id
      )
      SELECT recent.attempt_count, inserted.id
      FROM recent
      LEFT JOIN inserted ON true
    `, [req.user.id, phone]);

    const result = rows[0];
    if (!result?.id) {
      return res.status(429).json({
        error: 'Telefon numarası doğrulama SMS limitiniz doldu. Bir hesap 30 gün içinde en fazla 5 kez telefon doğrulama SMS’i başlatabilir.',
      });
    }

    res.json({
      ok: true,
      remaining: Math.max(0, 4 - Number(result.attempt_count || 0)),
    });
  } catch (err) { next(err); }
});

// PATCH /api/users/me/phone — Firebase SMS ile doğrulanmış telefonu kaydet
usersRouter.patch('/me/phone', authMiddleware, async (req, res, next) => {
  try {
    ensureFirebaseAdmin();
    const idToken = String(req.body.idToken || '').trim();
    if (!idToken) return res.status(400).json({ error: 'Firebase token zorunludur.' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const phone = String(decoded.phone_number || '').trim();
    if (!phone) return res.status(400).json({ error: 'Doğrulanmış telefon bulunamadı.' });

    const current = await query('SELECT firebase_uid FROM users WHERE id=$1', [req.user.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    const currentFirebaseUid = current.rows[0].firebase_uid;
    if (currentFirebaseUid && currentFirebaseUid !== decoded.uid) {
      return res.status(403).json({ error: 'Firebase oturumu bu hesapla eşleşmiyor.' });
    }

    const { rows } = await query(`
      UPDATE users
      SET phone=$1, phone_verified=true, firebase_uid=COALESCE(firebase_uid, $2), updated_at=NOW()
      WHERE id=$3
      RETURNING id,name,phone,phone_verified,city,district,bio,tc_verified,cks_verified,
                is_verified,rating,total_trades,profile_image,created_at
    `, [phone, decoded.uid, req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Bu telefon numarası başka bir hesapta kayıtlı.' });
    }
    next(err);
  }
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
