const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPromotionProduct,
  listPromotionProducts,
} = require('../src/services/promotionProducts');
const { purchaseTokenHash } = require('../src/services/storeVerification');
const {
  grantVerifiedPurchase,
  revokePurchaseByTransaction,
} = require('../src/services/promotionGrants');
const listingsRouter = require('../src/routes/listings');
const promotionsRoute = require('../src/routes/promotions');

test('promotion products use the store identifiers and configured durations', () => {
  assert.deepEqual(
    listPromotionProducts().map(({ productId, durationDays }) => [productId, durationDays]),
    [
      ['listing_boost_1d', 1],
      ['listing_boost_3d', 3],
      ['listing_boost_7d', 7],
    ],
  );
  assert.equal(getPromotionProduct('unknown'), null);
});

test('Google purchase tokens are represented by a stable one-way digest', () => {
  const token = 'private-google-purchase-token';
  const hash = purchaseTokenHash(token);
  assert.equal(hash.length, 64);
  assert.equal(hash, purchaseTokenHash(token));
  assert.doesNotMatch(hash, /private-google/);
});

test('promotion sort values are selected from a fixed SQL allowlist', () => {
  const helper = listingsRouter.testHelpers.promotionSortSql;
  assert.match(helper('price_asc'), /price_per_unit/);
  assert.match(helper('quantity_desc'), /quantity_unlimited/);
  assert.equal(helper('malicious sql'), helper('created_desc'));
});

test('Google pending cancellation is not treated as a completed purchase refund', () => {
  const action = promotionsRoute.testHelpers.googleNotificationAction;
  assert.equal(action({
    oneTimeProductNotification: { notificationType: 2, purchaseToken: 'pending' },
  }), 'pending_cancelled');
  assert.equal(action({
    voidedPurchaseNotification: { productType: 2, purchaseToken: 'refunded' },
  }), 'voided');
  assert.equal(action({
    oneTimeProductNotification: { notificationType: 1, purchaseToken: 'paid' },
  }), 'purchased');
});

test('an already granted store purchase never adds duration twice', async () => {
  const calls = [];
  const existingGrant = { id: 'grant-1', status: 'active' };
  const client = {
    async query(sql) {
      calls.push(sql.trim());
      if (/SELECT sp\.\*/.test(sql)) {
        return { rows: [{ id: 'purchase-1', status: 'verified', product_id: 'listing_boost_1d' }] };
      }
      if (/SELECT \* FROM promotion_grants/.test(sql)) return { rows: [existingGrant] };
      return { rows: [] };
    },
    release() {},
  };
  const result = await grantVerifiedPurchase('purchase-1', {
    getClientImpl: async () => client,
  });
  assert.equal(result, existingGrant);
  assert.equal(calls.some((sql) => /UPDATE listings/.test(sql)), false);
  assert.equal(calls.at(-1), 'COMMIT');
});

test('a refund removes only the unused part of its promotion grant', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: sql.trim(), params });
      if (/UPDATE store_purchases/.test(sql)) {
        return { rows: [{ id: 'purchase-1' }] };
      }
      if (/SELECT \* FROM promotion_grants/.test(sql)) {
        return {
          rows: [{
            id: 'grant-1',
            status: 'active',
            listing_id: 'listing-1',
            ends_at: '2026-08-26T12:00:00.000Z',
          }],
        };
      }
      if (/remaining_seconds/.test(sql)) {
        return { rows: [{ remaining_seconds: 3600 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  await revokePurchaseByTransaction(
    { platform: 'ios', transactionKey: 'transaction-1' },
    { getClientImpl: async () => client },
  );
  const listingUpdate = calls.find(({ sql }) => /UPDATE listings/.test(sql));
  assert.equal(listingUpdate.params[0], 3600);
  assert.match(listingUpdate.sql, /INTERVAL '1 second'/);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
