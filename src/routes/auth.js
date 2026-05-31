const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

const allowedRoles = ['farmer', 'middleman', 'trader'];

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

function signUserToken(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function firebasePhoneKey(uid) {
  const digest = crypto.createHash('sha256').update(uid).digest('hex');
  return `fb_${digest.slice(0, 17)}`;
}

function firebaseDisplayName(decoded, fallbackName) {
  const name = String(fallbackName || decoded.name || '').trim();
  if (name) return name;
  const email = String(decoded.email || '').trim();
  if (email && email.includes('@')) return email.split('@')[0];
  return 'Kullanıcı';
}

// POST /api/auth/register
router.post('/register', [
  body('name').trim().notEmpty().withMessage('İsim zorunludur.'),
  body('phone').trim().notEmpty().withMessage('Telefon zorunludur.'),
  body('password').isLength({ min: 6 }).withMessage('Şifre en az 6 karakter.'),
  body('role').isIn(['farmer','middleman','trader']).withMessage('Geçersiz rol.'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, phone, password, role, city, district, bio } = req.body;

    const existing = await query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Bu telefon numarası zaten kayıtlı.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await query(`
      INSERT INTO users (name,phone,password_hash,role,city,district,bio)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,name,phone,role,city,district,tc_verified,cks_verified,is_verified,rating,total_trades,created_at
    `, [name, phone, hash, role, city||null, district||null, bio||null]);

    const user = result.rows[0];
    const token = signUserToken(user);

    res.status(201).json({ token, user });
  } catch (err) { next(err); }
});

// POST /api/auth/login
router.post('/login', [
  body('phone').trim().notEmpty(),
  body('password').notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { phone, password } = req.body;
    const result = await query('SELECT * FROM users WHERE phone=$1', [phone]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Telefon veya şifre hatalı.' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Telefon veya şifre hatalı.' });

    const token = signUserToken(user);

    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) { next(err); }
});

// POST /api/auth/firebase
// Firebase email/password, Google ve ileride Apple girişlerini mevcut JWT akışına bağlar.
router.post('/firebase', [
  body('idToken').trim().notEmpty().withMessage('Firebase token zorunludur.'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    ensureFirebaseAdmin();

    const decoded = await admin.auth().verifyIdToken(req.body.idToken);
    if (!decoded.email_verified) {
      return res.status(403).json({ error: 'E-posta adresi doğrulanmamış.' });
    }
    const phone = firebasePhoneKey(decoded.uid);
    const role = allowedRoles.includes(req.body.role) ? req.body.role : 'farmer';
    const name = firebaseDisplayName(decoded, req.body.name);
    const city = String(req.body.city || '').trim() || null;

    const existing = await query(`
      SELECT id,name,phone,role,city,district,bio,tc_verified,cks_verified,
             is_verified,rating,total_trades,profile_image,created_at
      FROM users
      WHERE phone=$1
    `, [phone]);

    let user = existing.rows[0];
    if (!user) {
      const result = await query(`
        INSERT INTO users (name,phone,password_hash,role,city)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id,name,phone,role,city,district,bio,tc_verified,cks_verified,
                  is_verified,rating,total_trades,profile_image,created_at
      `, [name, phone, `firebase:${decoded.uid}`, role, city]);
      user = result.rows[0];
    }

    const token = signUserToken(user);
    res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me  (protected)
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT id,name,phone,role,city,district,bio,tc_verified,cks_verified,
             is_verified,rating,total_trades,profile_image,created_at
      FROM users WHERE id=$1
    `, [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
