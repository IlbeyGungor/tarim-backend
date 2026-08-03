const test = require('node:test');
const assert = require('node:assert/strict');
const authRouter = require('../src/routes/auth');

const {
  normalizeEmail,
  normalizePhone,
  hashChallengeToken,
  mergeProviders,
} = authRouter.testHelpers;

test('normalizes verified identity values deterministically', () => {
  assert.equal(normalizeEmail('  ILBEY@Example.COM '), 'ilbey@example.com');
  assert.equal(normalizePhone('+90 532 123 45 67'), '+905321234567');
  assert.equal(normalizePhone('05321234567'), null);
  assert.equal(normalizePhone('+4915212345678'), '+4915212345678');
});

test('challenge token is stored as a one-way digest', () => {
  const token = 'single-use-random-token';
  const digest = hashChallengeToken(token);
  assert.notEqual(digest, token);
  assert.equal(digest.length, 64);
  assert.equal(digest, hashChallengeToken(token));
});

test('auth providers remain unique when login is repeated', () => {
  assert.deepEqual(mergeProviders(['google'], 'google'), ['google']);
  assert.deepEqual(mergeProviders(['google'], 'apple'), ['google', 'apple']);
});
