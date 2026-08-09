const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeAnalyticsDays,
  recordUserActivity,
} = require('../src/services/userActivity');

test('analytics day range is clamped to 7-90 days', () => {
  assert.equal(normalizeAnalyticsDays(undefined), 30);
  assert.equal(normalizeAnalyticsDays('3'), 7);
  assert.equal(normalizeAnalyticsDays('30'), 30);
  assert.equal(normalizeAnalyticsDays('120'), 90);
});

test('activity recorder uses one atomic query and returns the recorded day', async () => {
  let captured;
  const result = await recordUserActivity('user-1', async (sql, params) => {
    captured = { sql, params };
    return {
      rows: [{ last_active_at: '2026-08-09T12:00:00Z', activity_date: '2026-08-09' }],
    };
  });

  assert.deepEqual(captured.params, ['user-1']);
  assert.match(captured.sql, /UPDATE users/);
  assert.match(captured.sql, /ON CONFLICT \(user_id,activity_date\)/);
  assert.equal(result.activity_date, '2026-08-09');
});
