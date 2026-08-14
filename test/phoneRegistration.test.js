const test = require('node:test');
const assert = require('node:assert/strict');

const authRoutes = require('../src/routes/auth');

const {
  hasLegacyPhoneChallenge,
  isRecentFirebasePhoneAuth,
  phoneAlreadyRegisteredError,
} = authRoutes.testHelpers;

test('new phone registration accepts a recent Firebase auth time without challenge', () => {
  assert.equal(hasLegacyPhoneChallenge({ idToken: 'token' }), false);
  assert.equal(isRecentFirebasePhoneAuth({ auth_time: 1_000 }, 1_599), true);
});

test('legacy phone registration keeps challenge compatibility', () => {
  assert.equal(
    hasLegacyPhoneChallenge({
      challengeId: 'challenge-id',
      challengeToken: 'challenge-token',
    }),
    true,
  );
});

test('challenge-free phone registration rejects stale or missing auth time', () => {
  assert.equal(isRecentFirebasePhoneAuth({}, 2_000), false);
  assert.equal(isRecentFirebasePhoneAuth({ auth_time: 1_000 }, 1_601), false);
  assert.equal(isRecentFirebasePhoneAuth({ auth_time: 2_061 }, 2_000), false);
});

test('duplicate phone errors expose a stable API code', () => {
  const error = phoneAlreadyRegisteredError();
  assert.equal(error.status, 409);
  assert.equal(error.apiCode, 'PHONE_ALREADY_REGISTERED');
});
