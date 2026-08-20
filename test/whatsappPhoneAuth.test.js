const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  codeHash,
  ensureRegistrationFirebaseUser,
  startWhatsAppChallenge,
  verifyWebhookSignature,
  verifyWhatsAppChallenge,
  whatsappConfig,
  whatsappTemplatePayload,
} = require('../src/services/whatsappPhoneAuth');

const enabledEnv = {
  WHATSAPP_PHONE_AUTH_ENABLED: 'true',
  WHATSAPP_PHONE_NUMBER_ID: 'phone-id',
  WHATSAPP_ACCESS_TOKEN: 'access-token',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_AUTH_TEMPLATE_NAME: 'tarim_pazar_dogrulama',
  WHATSAPP_AUTH_TEMPLATE_LANGUAGE: 'tr',
  WHATSAPP_GRAPH_API_VERSION: 'v23.0',
};

test('WhatsApp channel stays disabled until all send settings exist', () => {
  assert.equal(whatsappConfig({}).available, false);
  assert.equal(whatsappConfig(enabledEnv).available, true);
});

test('authentication template sends the same OTP in body and copy-code button', () => {
  const payload = whatsappTemplatePayload('+905321234567', '123456', whatsappConfig(enabledEnv));
  assert.equal(payload.to, '905321234567');
  assert.equal(payload.template.name, 'tarim_pazar_dogrulama');
  assert.equal(payload.template.components[0].parameters[0].text, '123456');
  assert.equal(payload.template.components[1].parameters[0].text, '123456');
});

test('challenge start stores hashes and records the provider message id', async () => {
  const statements = [];
  let sentPayload;
  const queryFn = async (sql, params) => {
    statements.push({ sql, params });
    if (/COUNT\(\*\) FILTER/.test(sql)) return { rows: [{ daily_count: 0, latest_at: null }] };
    if (/INSERT INTO whatsapp_phone_challenges/.test(sql)) {
      return { rows: [{ id: 'challenge-id', expires_at: '2026-08-20T12:00:00Z' }] };
    }
    return { rows: [], rowCount: 1 };
  };
  const client = { query: queryFn, release() {} };
  const fetchFn = async (_url, options) => {
    sentPayload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
  };
  const result = await startWhatsAppChallenge({
    purpose: 'phone_register',
    phone: '+90 532 123 45 67',
    queryFn,
    getClientFn: async () => client,
    fetchFn,
    env: enabledEnv,
  });
  assert.equal(result.phone, '+905321234567');
  assert.equal(result.channel, 'whatsapp');
  assert.match(sentPayload.template.components[0].parameters[0].text, /^\d{6}$/);
  const insert = statements.find((item) => /INSERT INTO whatsapp_phone_challenges/.test(item.sql));
  assert.equal(insert.params[3].length, 64);
  assert.equal(insert.params[4].length, 64);
  assert.notEqual(insert.params[4], sentPayload.template.components[0].parameters[0].text);
  assert.ok(statements.some((item) => item.params?.includes('wamid.1')));
});

test('verified challenge can be retried without requesting another code', async () => {
  process.env.JWT_SECRET = 'test-secret';
  const clientToken = 'client-token';
  const code = '654321';
  const row = {
    id: 'challenge-id',
    purpose: 'phone_register',
    phone: '+905321234567',
    user_id: null,
    client_token_hash: crypto.createHash('sha256').update(clientToken).digest('hex'),
    code_hash: codeHash(clientToken, code),
    attempts: 0,
    expires_at: new Date(Date.now() - 60000).toISOString(),
    verified_at: new Date().toISOString(),
    used_at: null,
  };
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      if (/SELECT \*/.test(sql)) return { rows: [row] };
      return { rows: [], rowCount: 1 };
    },
    release() { statements.push('RELEASE'); },
  };
  const verified = await verifyWhatsAppChallenge({
    challengeId: row.id,
    challengeToken: clientToken,
    code,
    purpose: 'phone_register',
    getClientFn: async () => client,
  });
  assert.equal(verified.id, row.id);
  assert.ok(statements.includes('COMMIT'));
  assert.equal(statements.some((sql) => /attempts=attempts\+1/.test(sql)), false);
});

test('an unlinked Firebase phone user is reused safely', async () => {
  const firebaseUser = { uid: 'firebase-phone-user', phoneNumber: '+905321234567' };
  const auth = { getUserByPhoneNumber: async () => firebaseUser };
  const queryFn = async () => ({ rows: [] });
  const result = await ensureRegistrationFirebaseUser({
    phone: firebaseUser.phoneNumber,
    name: 'Test User',
    challengeId: 'challenge-id',
    queryFn,
    auth,
  });
  assert.equal(result.uid, firebaseUser.uid);
});

test('webhook signature is verified against the raw body', () => {
  const body = Buffer.from('{"entry":[]}');
  const secret = 'app-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, 'sha256=00', secret), false);
});
