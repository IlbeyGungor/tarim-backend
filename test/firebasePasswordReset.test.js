const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PASSWORD_RESET_ENDPOINT,
  sendFirebasePasswordResetEmail,
} = require('../src/services/firebasePasswordReset');

function jsonResponse({ ok, payload }) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

test('sends a localized Firebase password reset request', async () => {
  let request;
  const sent = await sendFirebasePasswordResetEmail('user@example.com', {
    apiKey: 'firebase-api-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ ok: true, payload: { email: 'user@example.com' } });
    },
  });

  assert.equal(sent, true);
  assert.equal(
    request.url,
    `${PASSWORD_RESET_ENDPOINT}?key=firebase-api-key`
  );
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Firebase-Locale'], 'tr');
  assert.deepEqual(JSON.parse(request.options.body), {
    requestType: 'PASSWORD_RESET',
    email: 'user@example.com',
  });
});

test('does not reveal that an email account is missing', async () => {
  const sent = await sendFirebasePasswordResetEmail('missing@example.com', {
    apiKey: 'firebase-api-key',
    fetchImpl: async () =>
      jsonResponse({
        ok: false,
        payload: { error: { message: 'EMAIL_NOT_FOUND' } },
      }),
  });

  assert.equal(sent, false);
});

test('fails clearly when the Firebase web API key is missing', async () => {
  await assert.rejects(
    sendFirebasePasswordResetEmail('user@example.com', {
      apiKey: '',
      fetchImpl: async () => jsonResponse({ ok: true, payload: {} }),
    }),
    /FIREBASE_WEB_API_KEY/
  );
});
