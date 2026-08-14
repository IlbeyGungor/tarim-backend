const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listingIdForEvent,
  runInTransaction,
  scoreForEvent,
} = require('../src/services/productInterest');

test('listing view score enforces duration floor and cap', () => {
  assert.equal(scoreForEvent('listing_view', 2), 0);
  assert.equal(scoreForEvent('listing_view', 15), 2);
  assert.equal(scoreForEvent('listing_view', 999), 9);
});

test('explicit or related listing id wins over an offer id', () => {
  const offerRow = { id: 'offer-id', listing_id: 'listing-id' };
  assert.equal(listingIdForEvent(offerRow), 'listing-id');
  assert.equal(listingIdForEvent(offerRow, 'explicit-listing-id'), 'explicit-listing-id');
  assert.equal(listingIdForEvent({ id: 'plain-listing-id' }), 'plain-listing-id');
});

test('transaction helper commits successful interest writes', async () => {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      return { rows: [] };
    },
    release: () => statements.push('RELEASE'),
  };
  const result = await runInTransaction(async () => 'recorded', async () => client);
  assert.equal(result, 'recorded');
  assert.deepEqual(statements, ['BEGIN', 'COMMIT', 'RELEASE']);
});

test('transaction helper rolls back a partial interest write', async () => {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      return { rows: [] };
    },
    release: () => statements.push('RELEASE'),
  };
  await assert.rejects(
    runInTransaction(async () => { throw new Error('aggregate failed'); }, async () => client),
    /aggregate failed/
  );
  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK', 'RELEASE']);
});
