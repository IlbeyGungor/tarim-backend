const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimListingMatchJobs,
  claimPendingNotifications,
  cleanupListingMatchRecords,
  expandListingMatchJob,
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
    match_revision: 3,
  });
  assert.equal(queued, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO listing_match_jobs/);
  assert.match(calls[0].sql, /ON CONFLICT \(listing_id,match_revision\)/);
  assert.deepEqual(calls[0].params, ['listing-1', 3]);
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

test('match expansion combines opposite listings and favorite subscribers', async () => {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      if (/SELECT id,seller_id,listing_type,product_family_key/.test(sql)) {
        return {
          rows: [{
            id: 'listing-1',
            seller_id: 'seller-1',
            listing_type: 'sell',
            product_family_key: 'limon',
            match_revision: 2,
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  await expandListingMatchJob(
    { listing_id: 'listing-1', match_revision: 2, attempts: 1 },
    { getClientFn: async () => client, queryFn: async () => ({ rows: [] }) },
  );
  const expansion = statements.find((sql) => /raw_candidates/.test(sql));
  assert.ok(expansion);
  assert.match(expansion, /WITH opposite_candidates AS/);
  assert.match(
    expansion,
    /opposite_candidates AS[\s\S]*ORDER BY l\.seller_id,l\.created_at DESC[\s\S]*raw_candidates AS/
  );
  assert.match(
    expansion,
    /FROM opposite_candidates oc\s+UNION ALL\s+SELECT fp\.user_id/
  );
  assert.doesNotMatch(
    expansion,
    /ORDER BY l\.seller_id,l\.created_at DESC\s+UNION ALL/
  );
  assert.match(expansion, /user_favorite_products/);
  assert.match(expansion, /favorite_product_notifications_enabled/);
  assert.match(expansion, /favorite_product/);
  assert.match(expansion, /listing_match_daily_counts/);
  assert.match(expansion, /match_revision/);
  assert.match(expansion, /ON CONFLICT \(new_listing_id,recipient_id,match_revision\)/);
});
