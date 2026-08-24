const test = require('node:test');
const assert = require('node:assert/strict');
const {
  contactKey,
  pruneOldContactEvents,
  recordContactEvent,
  resolveCallTarget,
} = require('../src/services/contactAnalytics');

test('contact key is stable for the same listing and unordered user pair', () => {
  const first = contactKey('user-b', 'user-a', 'listing-1');
  const second = contactKey('user-a', 'user-b', 'listing-1');
  assert.equal(first, 'listing-1:user-a:user-b');
  assert.equal(second, first);
  assert.equal(contactKey(null, 'user-b', 'listing-1'), null);
});

test('authenticated contact records a deduplicated relationship key', async () => {
  const calls = [];
  const recorded = await recordContactEvent({
    eventId: 'call-event-1',
    channel: 'call',
    actorUserId: 'user-b',
    recipientUserId: 'user-a',
    listingId: 'listing-1',
    dbQuery: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 'contact-1' }] };
    },
  });
  assert.equal(recorded, true);
  assert.match(calls[0].sql, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.equal(calls[0].params[6], 'listing-1:user-a:user-b');
  assert.equal(calls[0].params[7], false);
});

test('guest call remains a raw click without user relationship key', async () => {
  let params;
  await recordContactEvent({
    eventId: 'guest-call-1',
    channel: 'call',
    recipientUserId: 'seller-1',
    listingId: 'listing-1',
    isGuest: true,
    dbQuery: async (_sql, values) => {
      params = values;
      return { rows: [{ id: 'contact-1' }] };
    },
  });
  assert.equal(params[2], null);
  assert.equal(params[6], null);
  assert.equal(params[7], true);
});

test('listing and accepted offer call targets are verified by backend queries', async () => {
  const listing = await resolveCallTarget({
    listingId: 'listing-1',
    actorUserId: 'buyer-1',
    dbQuery: async (sql, params) => {
      assert.match(sql, /seller\.account_status='active'/);
      assert.match(sql, /seller\.phone_verified=true/);
      assert.deepEqual(params, ['listing-1', 'buyer-1']);
      return { rows: [{ listing_id: 'listing-1', seller_id: 'seller-1' }] };
    },
  });
  assert.deepEqual(listing, {
    listingId: 'listing-1',
    offerId: null,
    recipientUserId: 'seller-1',
  });

  const offer = await resolveCallTarget({
    listingId: 'listing-1',
    offerId: 'offer-1',
    actorUserId: 'seller-1',
    dbQuery: async (sql) => {
      assert.match(sql, /o\.status='accepted'/);
      return {
        rows: [{
          offer_id: 'offer-1',
          listing_id: 'listing-1',
          buyer_id: 'buyer-1',
          seller_id: 'seller-1',
        }],
      };
    },
  });
  assert.equal(offer.recipientUserId, 'buyer-1');
  assert.equal(await resolveCallTarget({
    listingId: 'listing-1',
    offerId: 'offer-1',
    dbQuery: async () => ({ rows: [] }),
  }), null);
});

test('contact event pruning retains only the most recent 180 days', async () => {
  let statement = '';
  await pruneOldContactEvents(async (sql) => {
    statement = sql;
    return { rows: [] };
  });
  assert.match(statement, /INTERVAL '180 days'/);
});
