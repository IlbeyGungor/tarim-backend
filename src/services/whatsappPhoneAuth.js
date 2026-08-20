const crypto = require('crypto');
const { query, getClient } = require('../db');
const { firebaseAuth } = require('./firebaseAdmin');

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const OTP_TTL_MINUTES = 5;
const VERIFIED_RETRY_MINUTES = 30;
const MAX_ATTEMPTS = 5;
const DAILY_SEND_LIMIT = 5;
const RESEND_SECONDS = 60;

function normalizePhone(value) {
  const phone = String(value || '').replace(/[\s()-]/g, '').trim();
  return PHONE_PATTERN.test(phone) ? phone : null;
}

function whatsappConfig(env = process.env) {
  const enabled = String(env.WHATSAPP_PHONE_AUTH_ENABLED || '').toLowerCase() === 'true';
  const config = {
    enabled,
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    accessToken: String(env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    appSecret: String(env.WHATSAPP_APP_SECRET || '').trim(),
    webhookVerifyToken: String(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim(),
    templateName: String(env.WHATSAPP_AUTH_TEMPLATE_NAME || 'tarim_pazar_dogrulama').trim(),
    templateLanguage: String(env.WHATSAPP_AUTH_TEMPLATE_LANGUAGE || 'tr').trim(),
    graphVersion: String(env.WHATSAPP_GRAPH_API_VERSION || 'v23.0').trim(),
  };
  config.available = Boolean(
    enabled &&
    config.phoneNumberId &&
    config.accessToken &&
    config.appSecret &&
    config.webhookVerifyToken &&
    config.templateName
  );
  return config;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function codeHash(clientToken, code) {
  return crypto
    .createHmac('sha256', String(process.env.JWT_SECRET || ''))
    .update(`${clientToken}:${code}`)
    .digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function apiError(message, status, apiCode) {
  const error = new Error(message);
  error.status = status;
  error.apiCode = apiCode;
  return error;
}

function requireWhatsAppConfig(env = process.env) {
  const config = whatsappConfig(env);
  if (!config.available) {
    throw apiError(
      'WhatsApp doğrulaması şu anda kullanılamıyor.',
      503,
      'WHATSAPP_AUTH_UNAVAILABLE',
    );
  }
  return config;
}

function whatsappTemplatePayload(phone, code, config) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: config.templateName,
      language: { code: config.templateLanguage },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: code }],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: code }],
        },
      ],
    },
  };
}

async function sendWhatsAppOtp({ phone, code, config, fetchFn = fetch }) {
  const response = await fetchFn(
    `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(whatsappTemplatePayload(phone, code, config)),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerCode = body?.error?.code;
    const error = apiError(
      'WhatsApp doğrulama mesajı gönderilemedi. Lütfen daha sonra tekrar deneyin.',
      502,
      'WHATSAPP_SEND_FAILED',
    );
    error.providerCode = providerCode;
    throw error;
  }
  const messageId = body?.messages?.[0]?.id;
  if (!messageId) {
    throw apiError(
      'WhatsApp mesaj servisi geçersiz yanıt verdi.',
      502,
      'WHATSAPP_SEND_FAILED',
    );
  }
  return messageId;
}

async function startWhatsAppChallenge({
  purpose,
  phone: rawPhone,
  userId = null,
  queryFn = query,
  getClientFn = getClient,
  fetchFn = fetch,
  env = process.env,
}) {
  const config = requireWhatsAppConfig(env);
  const phone = normalizePhone(rawPhone);
  if (!phone) throw apiError('Geçerli bir telefon numarası girin.', 400, 'INVALID_PHONE');
  if (!['phone_register', 'profile_phone'].includes(purpose)) {
    throw apiError('Geçersiz doğrulama amacı.', 400, 'INVALID_CHALLENGE_PURPOSE');
  }
  if (purpose === 'profile_phone' && !userId) {
    throw apiError('Oturum doğrulaması gerekli.', 401, 'AUTH_REQUIRED');
  }

  const clientToken = crypto.randomBytes(32).toString('hex');
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  const client = await getClientFn();
  let challenge;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`${purpose}:${phone}`],
    );
    const recent = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS daily_count,
        MAX(created_at) AS latest_at
      FROM whatsapp_phone_challenges
      WHERE phone=$1 AND purpose=$2
    `, [phone, purpose]);
    const stats = recent.rows[0] || {};
    if (Number(stats.daily_count || 0) >= DAILY_SEND_LIMIT) {
      throw apiError(
        'Bu numara için günlük WhatsApp doğrulama sınırına ulaşıldı.',
        429,
        'WHATSAPP_DAILY_LIMIT',
      );
    }
    if (stats.latest_at) {
      const elapsed = Date.now() - new Date(stats.latest_at).getTime();
      if (elapsed < RESEND_SECONDS * 1000) {
        throw apiError(
          'Yeni kod istemeden önce lütfen bir dakika bekleyin.',
          429,
          'WHATSAPP_RESEND_COOLDOWN',
        );
      }
    }
    await client.query(`
      UPDATE whatsapp_phone_challenges
      SET used_at=NOW(),delivery_status='superseded',updated_at=NOW()
      WHERE phone=$1 AND purpose=$2 AND used_at IS NULL AND verified_at IS NULL
    `, [phone, purpose]);
    const inserted = await client.query(`
      INSERT INTO whatsapp_phone_challenges (
        purpose,phone,user_id,client_token_hash,code_hash,expires_at
      ) VALUES ($1,$2,$3,$4,$5,NOW() + ($6 * INTERVAL '1 minute'))
      RETURNING id,expires_at
    `, [purpose, phone, userId, sha256(clientToken), codeHash(clientToken, code), OTP_TTL_MINUTES]);
    challenge = inserted.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }

  try {
    const messageId = await sendWhatsAppOtp({ phone, code, config, fetchFn });
    await queryFn(`
      UPDATE whatsapp_phone_challenges
      SET provider_message_id=$1,delivery_status='accepted',updated_at=NOW()
      WHERE id=$2
    `, [messageId, challenge.id]);
  } catch (error) {
    await queryFn(`
      UPDATE whatsapp_phone_challenges
      SET delivery_status='failed',provider_error=$1,used_at=NOW(),updated_at=NOW()
      WHERE id=$2
    `, [String(error.providerCode || error.apiCode || 'send_failed'), challenge.id]);
    throw error;
  }

  return {
    challengeId: challenge.id,
    challengeToken: clientToken,
    phone,
    expiresAt: challenge.expires_at,
    expiresInSeconds: OTP_TTL_MINUTES * 60,
    channel: 'whatsapp',
  };
}

async function verifyWhatsAppChallenge({
  challengeId,
  challengeToken,
  code,
  purpose,
  userId = null,
  getClientFn = getClient,
}) {
  const client = await getClientFn();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT * FROM whatsapp_phone_challenges WHERE id=$1 FOR UPDATE
    `, [challengeId]);
    const challenge = result.rows[0];
    const tokenMatches = challenge && secureEqual(
      challenge.client_token_hash,
      sha256(challengeToken),
    );
    const codeMatches = challenge && secureEqual(
      challenge.code_hash,
      codeHash(challengeToken, String(code || '').trim()),
    );
    const identityMatches = challenge && challenge.purpose === purpose &&
      (purpose !== 'profile_phone' || challenge.user_id === userId);
    const verifiedRetryIsValid = challenge?.verified_at &&
      new Date(challenge.verified_at).getTime() > Date.now() - VERIFIED_RETRY_MINUTES * 60 * 1000;
    const freshCodeIsValid = challenge && !challenge.verified_at &&
      new Date(challenge.expires_at).getTime() > Date.now();
    const valid = challenge && !challenge.used_at && tokenMatches && identityMatches &&
      Number(challenge.attempts || 0) < MAX_ATTEMPTS &&
      (verifiedRetryIsValid || freshCodeIsValid);

    if (!valid || !codeMatches) {
      if (challenge && tokenMatches && !challenge.used_at) {
        await client.query(`
          UPDATE whatsapp_phone_challenges
          SET attempts=attempts+1,updated_at=NOW() WHERE id=$1
        `, [challengeId]);
      }
      await client.query('COMMIT');
      throw apiError(
        'WhatsApp doğrulama kodu geçersiz veya süresi dolmuş.',
        400,
        'INVALID_WHATSAPP_CODE',
      );
    }

    if (!challenge.verified_at) {
      const verified = await client.query(`
        UPDATE whatsapp_phone_challenges
        SET verified_at=NOW(),delivery_status='verified',updated_at=NOW()
        WHERE id=$1 RETURNING *
      `, [challengeId]);
      await client.query('COMMIT');
      return verified.rows[0];
    }
    await client.query('COMMIT');
    return challenge;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function markWhatsAppChallengeUsed(client, challengeId) {
  const result = await client.query(`
    UPDATE whatsapp_phone_challenges
    SET used_at=NOW(),delivery_status='completed',updated_at=NOW()
    WHERE id=$1 AND used_at IS NULL AND verified_at IS NOT NULL
    RETURNING id
  `, [challengeId]);
  if (!result.rowCount) {
    throw apiError('Doğrulama daha önce kullanılmış.', 409, 'WHATSAPP_CODE_USED');
  }
}

function isFirebaseUserNotFound(error) {
  return error?.code === 'auth/user-not-found';
}

async function firebaseUserByPhone(auth, phone) {
  try {
    return await auth.getUserByPhoneNumber(phone);
  } catch (error) {
    if (isFirebaseUserNotFound(error)) return null;
    throw error;
  }
}

async function ensureRegistrationFirebaseUser({
  phone,
  name,
  challengeId,
  queryFn = query,
  auth = firebaseAuth(),
}) {
  let firebaseUser = await firebaseUserByPhone(auth, phone);
  if (firebaseUser) {
    const linked = await queryFn(
      'SELECT id FROM users WHERE firebase_uid=$1 OR phone=$2 LIMIT 1',
      [firebaseUser.uid, phone],
    );
    if (linked.rows.length) {
      throw apiError(
        'Bu telefon numarası mevcut bir hesaba bağlı. Bu numarayla giriş yapın.',
        409,
        'PHONE_ALREADY_REGISTERED',
      );
    }
    return firebaseUser;
  }

  const uid = `wa_${String(challengeId).replace(/-/g, '')}`;
  try {
    return await auth.createUser({ uid, phoneNumber: phone, displayName: name });
  } catch (error) {
    if (error?.code === 'auth/phone-number-already-exists') {
      firebaseUser = await firebaseUserByPhone(auth, phone);
      if (firebaseUser) return firebaseUser;
    }
    throw error;
  }
}

async function ensureProfileFirebaseUser({
  phone,
  name,
  userId,
  currentFirebaseUid,
  queryFn = query,
  auth = firebaseAuth(),
}) {
  const phoneOwner = await firebaseUserByPhone(auth, phone);
  if (phoneOwner && phoneOwner.uid !== currentFirebaseUid) {
    const linked = await queryFn(
      'SELECT id FROM users WHERE firebase_uid=$1 OR phone=$2 LIMIT 1',
      [phoneOwner.uid, phone],
    );
    if (linked.rows.some((row) => row.id !== userId)) {
      throw apiError('Bu telefon numarası başka bir hesapta kayıtlı.', 409, 'PHONE_ALREADY_REGISTERED');
    }
    if (!currentFirebaseUid) return phoneOwner;
    throw apiError('Bu telefon numarası başka bir Firebase hesabına bağlı.', 409, 'FIREBASE_PHONE_CONFLICT');
  }
  if (currentFirebaseUid) {
    return auth.updateUser(currentFirebaseUid, { phoneNumber: phone });
  }
  if (phoneOwner) return phoneOwner;
  const uid = `tp_${String(userId).replace(/-/g, '')}`;
  return auth.createUser({ uid, phoneNumber: phone, displayName: name });
}

function verifyWebhookSignature(rawBody, signature, appSecret) {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = String(signature).replace(/^sha256=/, '');
  return secureEqual(expected, received);
}

async function recordWebhookStatuses(payload, queryFn = query) {
  const statuses = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const status of change?.value?.statuses || []) statuses.push(status);
    }
  }
  for (const status of statuses) {
    const errorCode = status?.errors?.[0]?.code;
    await queryFn(`
      UPDATE whatsapp_phone_challenges
      SET delivery_status=$1,provider_error=$2,updated_at=NOW()
      WHERE provider_message_id=$3
    `, [String(status.status || 'unknown'), errorCode ? String(errorCode) : null, status.id]);
  }
  return statuses.length;
}

module.exports = {
  OTP_TTL_MINUTES,
  codeHash,
  ensureProfileFirebaseUser,
  ensureRegistrationFirebaseUser,
  markWhatsAppChallengeUsed,
  normalizePhone,
  recordWebhookStatuses,
  sendWhatsAppOtp,
  startWhatsAppChallenge,
  verifyWebhookSignature,
  verifyWhatsAppChallenge,
  whatsappConfig,
  whatsappTemplatePayload,
};
