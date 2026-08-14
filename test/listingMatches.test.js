const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimListingMatchJobs,
  claimPendingNotifications,
  cleanupListingMatchRecords,
  queueListingMatches,
} = require('../src/services/listingMatches');

test('listing creation only queues one asynchronous match job', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ listing_id: params[0] }] };
    },
  };
  const queued = await queueListingMatches(client, {
    id: 'listing-1',
    product_family_key: 'limon',
  });
  assert.equal(queued, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO listing_match_jobs/);
});

test('job and notification claims use skip locked for multiple workers', async () => {
  const statements = [];
  const queryFn = async (sql) => {
    statements.push(sql);
    return { rows: [] };
  };
  await claimListingMatchJobs({ queryFn });
  await claimPendingNotifications({ queryFn });
  assert.equal(statements.length, 2);
  for (const sql of statements) {
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /status='processing'/);
  }
});

test('terminal match records are retained for seven days', async () => {
  const statements = [];
  await cleanupListingMatchRecords(async (sql) => {
    statements.push(sql);
    return { rows: [] };
  });
  assert.equal(statements.length, 3);
  assert.match(statements[0], /INTERVAL '7 days'/);
  assert.match(statements[0], /permanent_failed/);
  assert.match(statements[1], /INTERVAL '7 days'/);
});
