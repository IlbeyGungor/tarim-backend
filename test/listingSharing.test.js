const test = require('node:test');
const assert = require('node:assert/strict');

const { listingUrl, withListingShareUrls } = require('../src/routes/listingPages');
const {
  ANDROID_CERTIFICATES,
  ANDROID_PACKAGE,
  APPLE_APP_ID,
  androidAssociation,
  androidAssetLinks,
  appleAppSiteAssociation,
  appleAssociation,
} = require('../src/routes/appAssociations');

const listing = {
  id: '6fb265a4-3d01-4d67-911b-f47e97b00663',
  crop_name: 'Çengelköy Salatalığı',
  city: 'Sakarya',
  district: 'Geyve',
  seller: { id: 'seller-1', name: 'Tuncay Şorguç' },
};

test('listingUrl uses the canonical www origin and Turkish-safe slug', () => {
  assert.equal(
    listingUrl(listing),
    'https://www.tarim-pazar.com/ilan/tuncay-sorguc-sakarya-geyve-cengelkoy-salataligi-6fb265a4-3d01-4d67-911b-f47e97b00663/'
  );
});

test('withListingShareUrls enriches direct and embedded listings', () => {
  const createdAt = new Date('2026-08-15T10:00:00.000Z');
  const result = withListingShareUrls({
    listings: [{ ...listing, created_at: createdAt }],
    offer: { listing },
  });
  assert.equal(result.listings[0].share_url, listingUrl(listing));
  assert.equal(result.offer.listing.share_url, listingUrl(listing));
  assert.equal(result.listings[0].created_at, createdAt);
  assert.equal(listing.share_url, undefined);
});

test('association documents contain the production app identities', () => {
  assert.deepEqual(appleAssociation.applinks.details[0].appIDs, [APPLE_APP_ID]);
  assert.deepEqual(appleAssociation.applinks.details[0].components, [{ '/': '/ilan/*' }]);
  assert.equal(androidAssociation[0].target.package_name, ANDROID_PACKAGE);
  assert.deepEqual(
    androidAssociation[0].target.sha256_cert_fingerprints,
    ANDROID_CERTIFICATES
  );
});

test('association handlers respond with cacheable JSON and no redirect', () => {
  for (const [handler, expected] of [
    [appleAppSiteAssociation, appleAssociation],
    [androidAssetLinks, androidAssociation],
  ]) {
    const response = {
      headers: null,
      statusCode: null,
      body: null,
      set(headers) { this.headers = headers; return this; },
      status(statusCode) { this.statusCode = statusCode; return this; },
      send(body) { this.body = body; return this; },
    };
    handler({}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(response.body), expected);
  }
});
