const assert = require('node:assert/strict');
const test = require('node:test');

const adminMiddleware = require('../src/middleware/admin');

function runMiddleware(user) {
  let statusCode;
  let body;
  let allowed = false;
  const req = { user };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  adminMiddleware(req, res, () => {
    allowed = true;
  });
  return { statusCode, body, allowed };
}

test('requires both the database admin flag and configured email', () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'ilbey.gungor@outlook.com';
  try {
    const missingFlag = runMiddleware({
      email: 'ilbey.gungor@outlook.com',
      is_admin: false,
    });
    assert.equal(missingFlag.allowed, false);
    assert.equal(missingFlag.statusCode, 403);

    const missingAllowlist = runMiddleware({
      email: 'other@example.com',
      is_admin: true,
    });
    assert.equal(missingAllowlist.allowed, false);
    assert.equal(missingAllowlist.statusCode, 403);

    const allowed = runMiddleware({
      email: 'ILBEY.GUNGOR@OUTLOOK.COM',
      is_admin: true,
    });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.statusCode, undefined);
  } finally {
    if (previous == null) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});
