const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { query, getClient } = require('../db');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const { firebaseAuth } = require('../services/firebaseAdmin');
const {
  sendFirebasePasswordResetEmail,
} = require('../services/firebasePasswordReset');
const { recordUserActivity } = require('../services/userActivity');

const USER_COLUMNS = `
  id,name,phone,phone_verified,email,city,district,bio,tc_verified,cks_verified,
  is_verified,rating,total_trades,profile_image,created_at,is_admin,account_status,
  has_local_password,auth_providers,token_version,firebase_uid,
  match_notifications_enabled,personalization_enabled,
  favorite_product_notifications_enabled
`;
const CHALLENGE_TTL_MINUTES = 10;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.' },
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  const phone = String(value || '').replace(/[\s()-]/g, '').trim();
  return PHONE_PATTERN.test(phone) ? phone : null;
}

function hashChallengeToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signUserToken(user) {
  return jwt.sign(
    {
      id: user.id,
      phone: user.phone,
      token_version: Number(user.token_version || 0),
    },
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
  const email = normalizeEmail(decoded.email);
  if (email.includes('@')) return email.split('@')[0];
  return 'Kullanıcı';
}

function firebaseProvider(decoded) {
  const provider = decoded.firebase?.sign_in_provider;
  if (provider === 'google.com') return 'google';
  if (provider === 'apple.com') return 'apple';
  if (provider === 'phone') return 'phone';
  if (provider === 'password') return 'email_password';
  return provider || 'firebase';
}

function mergeProviders(current, provider) {
  const providers = Array.isArray(current) ? current : [];
  return [...new Set([...providers, provider])];
}

function publicUser(user) {
  const { firebase_uid, token_version, ...safe } = user;
  return safe;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

async function createChallenge({ purpose, phone, userId = null }) {
  const recent = await query(`
    SELECT COUNT(*)::int AS count
    FROM auth_challenges
    WHERE phone=$1 AND purpose=$2 AND created_at > NOW() - INTERVAL '30 minutes'
  `, [phone, purpose]);
  if (recent.rows[0].count >= 5) {
    const error = new Error('Bu numara için çok fazla SMS denemesi yapıldı. Lütfen daha sonra tekrar deneyin.');
    error.status = 429;
    throw error;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const { rows } = await query(`
    INSERT INTO auth_challenges (purpose,phone,user_id,token_hash,expires_at)
    VALUES ($1,$2,$3,$4,NOW() + ($5 * INTERVAL '1 minute'))
    RETURNING id, expires_at
  `, [purpose, phone, userId, hashChallengeToken(token), CHALLENGE_TTL_MINUTES]);
  return {
    challengeId: rows[0].id,
    challengeToken: token,
    expiresAt: rows[0].expires_at,
  };
}

async function lockChallenge(client, { id, token, purpose, phone }) {
  const { rows } = await client.query(`
    SELECT * FROM auth_challenges WHERE id=$1 FOR UPDATE
  `, [id]);
  const challenge = rows[0];
  const suppliedHash = hashChallengeToken(String(token || ''));
  const tokenMatches = challenge &&
    challenge.token_hash.length === suppliedHash.length &&
    crypto.timingSafeEqual(
      Buffer.from(challenge.token_hash),
      Buffer.from(suppliedHash)
    );
  const valid = challenge &&
    challenge.purpose === purpose &&
    challenge.phone === phone &&
    tokenMatches &&
    !challenge.used_at &&
    new Date(challenge.expires_at).getTime() > Date.now() &&
    Number(challenge.attempts || 0) < 5;
  if (!valid) {
    const error = new Error('Doğrulama isteği geçersiz veya süresi dolmuş.');
    error.status = 400;
    error.code = 'INVALID_CHALLENGE';
    error.challengeId = id;
    throw error;
  }
  return challenge;
}

// Legacy SMS doğrulamasız kayıt yolu kapalıdır.
router.post('/register', (_req, res) => {
  res.status(410).json({
    error: 'Telefon kaydı için SMS doğrulamalı güncel kayıt akışını kullanın.',
  });
});

router.post('/phone/register/start', authLimiter, [
  body('phone').trim().notEmpty(),
], async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Geçerli bir telefon numarası girin.' });
    const existing = await query('SELECT id FROM users WHERE phone=$1 LIMIT 1', [phone]);
    if (existing.rows.length) {
      return res.status(409).json({
        error: 'Bu telefon numarası mevcut bir hesaba bağlı. O hesapla giriş yapın.',
      });
    }
    const challenge = await createChallenge({ purpose: 'phone_register', phone });
    res.json({ ...challenge, phone, expiresInSeconds: CHALLENGE_TTL_MINUTES * 60 });
  } catch (err) { next(err); }
});

router.post('/phone/register/complete', authLimiter, [
  body('challengeId').isUUID(),
  body('challengeToken').notEmpty(),
  body('idToken').notEmpty(),
  body('name').trim().notEmpty(),
  body('password').isLength({ min: 6 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  let client;
  try {
    const decoded = await firebaseAuth().verifyIdToken(req.body.idToken, true);
    const phone = normalizePhone(decoded.phone_number);
    if (!phone) return res.status(403).json({ error: 'Firebase telefon doğrulaması bulunamadı.' });

    client = await getClient();
    await client.query('BEGIN');
    await lockChallenge(client, {
      id: req.body.challengeId,
      token: req.body.challengeToken,
      purpose: 'phone_register',
      phone,
    });
    const duplicate = await client.query(
      'SELECT id FROM users WHERE phone=$1 OR firebase_uid=$2 LIMIT 1 FOR UPDATE',
      [phone, decoded.uid]
    );
    if (duplicate.rows.length) {
      const error = new Error('Bu telefon numarası mevcut bir hesaba bağlı.');
      error.status = 409;
      throw error;
    }

    const passwordHash = await bcrypt.hash(req.body.password, 12);
    const { rows } = await client.query(`
      INSERT INTO users (
        name,phone,phone_verified,password_hash,firebase_uid,
        has_local_password,auth_providers
      ) VALUES ($1,$2,true,$3,$4,true,'["phone","phone_password"]'::jsonb)
      RETURNING ${USER_COLUMNS}
    `, [req.body.name.trim(), phone, passwordHash, decoded.uid]);
    await client.query('UPDATE auth_challenges SET used_at=NOW() WHERE id=$1', [req.body.challengeId]);
    await client.query('COMMIT');

    const user = rows[0];
    res.status(201).json({ token: signUserToken(user), user: publicUser(user) });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    if (err.code === 'INVALID_CHALLENGE' && err.challengeId) {
      await query(`
        UPDATE auth_challenges SET attempts=attempts+1
        WHERE id=$1 AND used_at IS NULL
      `, [err.challengeId]);
    }
    next(err);
  } finally {
    client?.release();
  }
});

router.post('/login', authLimiter, [
  body('phone').trim().notEmpty(),
  body('password').notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(401).json({ error: 'Telefon veya şifre hatalı.' });
    const { rows } = await query(`
      SELECT ${USER_COLUMNS}, password_hash FROM users WHERE phone=$1 LIMIT 1
    `, [phone]);
    const user = rows[0];
    if (!user || !user.has_local_password || !user.phone_verified) {
      return res.status(401).json({ error: 'Telefon veya şifre hatalı.' });
    }
    if (user.account_status !== 'active') {
      return res.status(403).json({ error: 'Bu hesap şu anda aktif değil.' });
    }
    const valid = await bcrypt.compare(req.body.password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Telefon veya şifre hatalı.' });

    const firebaseCustomToken = user.firebase_uid
      ? await firebaseAuth().createCustomToken(user.firebase_uid)
      : null;
    res.json({
      token: signUserToken(user),
      firebaseCustomToken,
      user: publicUser(user),
    });
  } catch (err) { next(err); }
});

router.post('/firebase', authLimiter, [
  body('idToken').trim().notEmpty().withMessage('Firebase token zorunludur.'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const decoded = await firebaseAuth().verifyIdToken(req.body.idToken, true);
    if (!decoded.email_verified) {
      return res.status(403).json({ error: 'E-posta adresi doğrulanmamış.' });
    }
    const email = normalizeEmail(decoded.email);
    const legacyPhone = firebasePhoneKey(decoded.uid);
    const name = firebaseDisplayName(decoded, req.body.name);
    const provider = firebaseProvider(decoded);
    const shouldBeAdmin = adminMiddleware.configuredAdminEmails().has(email);

    const existing = await query(`
      SELECT ${USER_COLUMNS}
      FROM users
      WHERE firebase_uid=$1 OR phone=$2 OR (email IS NOT NULL AND LOWER(email)=$3)
      ORDER BY CASE WHEN firebase_uid=$1 THEN 0 ELSE 1 END
      LIMIT 1
    `, [decoded.uid, legacyPhone, email]);

    let user = existing.rows[0];
    if (user) {
      if (user.account_status !== 'active') {
        return res.status(403).json({ error: 'Bu hesap şu anda aktif değil.' });
      }
      const shouldClearLegacyPhone = user.phone === legacyPhone;
      const providers = mergeProviders(user.auth_providers, provider);
      const result = await query(`
        UPDATE users
        SET firebase_uid=$1, email=$2, is_admin=$3, auth_providers=$4::jsonb,
            phone=CASE WHEN $5 THEN NULL ELSE phone END,
            phone_verified=CASE WHEN $5 THEN false ELSE phone_verified END,
            updated_at=NOW()
        WHERE id=$6
        RETURNING ${USER_COLUMNS}
      `, [decoded.uid, email, shouldBeAdmin, JSON.stringify(providers), shouldClearLegacyPhone, user.id]);
      user = result.rows[0];
    } else {
      const result = await query(`
        INSERT INTO users (name,password_hash,firebase_uid,email,is_admin,auth_providers)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        RETURNING ${USER_COLUMNS}
      `, [name, `firebase:${decoded.uid}`, decoded.uid, email, shouldBeAdmin, JSON.stringify([provider])]);
      user = result.rows[0];
    }

    res.json({ token: signUserToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

router.post('/password-reset/start', authLimiter, [
  body('identifier').trim().notEmpty(),
], async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || '').trim();
    if (identifier.includes('@')) {
      const email = normalizeEmail(identifier);
      const { rows } = await query(`
        SELECT id,email,account_status FROM users WHERE LOWER(email)=$1 LIMIT 1
      `, [email]);
      if (!rows.length || rows[0].account_status !== 'active') {
        return res.json({ ok: true, channel: 'email', destination: maskEmail(email) });
      }
      await sendFirebasePasswordResetEmail(email);
      return res.json({ ok: true, channel: 'email', destination: maskEmail(email) });
    }

    const phone = normalizePhone(identifier);
    if (!phone) return res.status(400).json({ error: 'Geçerli bir e-posta veya telefon girin.' });
    const { rows } = await query(`
      SELECT id,account_status,has_local_password FROM users WHERE phone=$1 LIMIT 1
    `, [phone]);
    if (!rows.length || rows[0].account_status !== 'active' || !rows[0].has_local_password) {
      return res.status(404).json({ error: 'Bu telefonla şifreli bir hesap bulunamadı.' });
    }
    const challenge = await createChallenge({
      purpose: 'phone_password_reset',
      phone,
      userId: rows[0].id,
    });
    res.json({
      ok: true,
      channel: 'sms',
      phone,
      ...challenge,
      expiresInSeconds: CHALLENGE_TTL_MINUTES * 60,
    });
  } catch (err) { next(err); }
});

router.post('/password-reset/phone/complete', authLimiter, [
  body('challengeId').isUUID(),
  body('challengeToken').notEmpty(),
  body('idToken').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  let client;
  try {
    const decoded = await firebaseAuth().verifyIdToken(req.body.idToken, true);
    const phone = normalizePhone(decoded.phone_number);
    if (!phone) return res.status(403).json({ error: 'Firebase telefon doğrulaması bulunamadı.' });

    client = await getClient();
    await client.query('BEGIN');
    const challenge = await lockChallenge(client, {
      id: req.body.challengeId,
      token: req.body.challengeToken,
      purpose: 'phone_password_reset',
      phone,
    });
    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    const { rows } = await client.query(`
      UPDATE users
      SET password_hash=$1,has_local_password=true,token_version=token_version+1,updated_at=NOW()
      WHERE id=$2 AND phone=$3 AND account_status='active'
      RETURNING firebase_uid
    `, [passwordHash, challenge.user_id, phone]);
    if (!rows.length) {
      const error = new Error('Hesap bulunamadı veya aktif değil.');
      error.status = 404;
      throw error;
    }
    await client.query('UPDATE auth_challenges SET used_at=NOW() WHERE id=$1', [req.body.challengeId]);
    if (rows[0].firebase_uid) {
      await firebaseAuth().revokeRefreshTokens(rows[0].firebase_uid);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    if (err.code === 'INVALID_CHALLENGE' && err.challengeId) {
      await query(`
        UPDATE auth_challenges SET attempts=attempts+1
        WHERE id=$1 AND used_at IS NULL
      `, [err.challengeId]);
    }
    next(err);
  } finally {
    client?.release();
  }
});

router.post('/password/change', authMiddleware, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT ${USER_COLUMNS},password_hash FROM users WHERE id=$1 LIMIT 1 FOR UPDATE
    `, [req.user.id]);
    const user = rows[0];
    if (!user?.has_local_password) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu hesabın yerel şifresi bulunmuyor.' });
    }
    const valid = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Mevcut şifre hatalı.' });
    }
    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    const result = await client.query(`
      UPDATE users SET password_hash=$1,token_version=token_version+1,updated_at=NOW()
      WHERE id=$2 RETURNING ${USER_COLUMNS}
    `, [passwordHash, user.id]);
    const updated = result.rows[0];
    if (updated.firebase_uid) await firebaseAuth().revokeRefreshTokens(updated.firebase_uid);
    await client.query('COMMIT');
    res.json({ token: signUserToken(updated), user: publicUser(updated) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/password/change/firebase', authMiddleware, [
  body('idToken').trim().notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const decoded = await firebaseAuth().verifyIdToken(req.body.idToken, true);
    const { rows } = await query(`
      UPDATE users
      SET token_version=token_version+1,updated_at=NOW()
      WHERE id=$1 AND firebase_uid=$2 AND account_status='active'
      RETURNING ${USER_COLUMNS}
    `, [req.user.id, decoded.uid]);
    if (!rows.length) {
      return res.status(403).json({ error: 'Firebase hesabı bu kullanıcıyla eşleşmiyor.' });
    }
    const user = rows[0];
    await firebaseAuth().revokeRefreshTokens(decoded.uid);
    res.json({ token: signUserToken(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const result = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    res.json(publicUser(result.rows[0]));
  } catch (err) { next(err); }
});

router.post('/activity', authMiddleware, async (req, res, next) => {
  try {
    const activity = await recordUserActivity(req.user.id);
    if (!activity) {
      return res.status(404).json({ error: 'Aktif kullanıcı bulunamadı.' });
    }
    res.json({
      ok: true,
      last_active_at: activity.last_active_at,
      activity_date: activity.activity_date,
    });
  } catch (err) { next(err); }
});

router.testHelpers = {
  normalizeEmail,
  normalizePhone,
  hashChallengeToken,
  mergeProviders,
};

module.exports = router;
