const test = require('node:test');
const assert = require('node:assert/strict');
const { buildListingUpdate } = require('../src/services/listingUpdates');

function listing(overrides = {}) {
  return {
    id: 'listing-1',
    listing_type: 'sell',
    crop_name: 'Limon',
    category: 'fruit',
    catalog_product_key: 'limon',
    product_key: 'limon',
    product_family_key: 'limon',
    quantity: '100',
    quantity_unlimited: false,
    fulfilled_quantity: '20',
    unit: 'kg',
    price_per_unit: '12',
    price_unit: 'kg',
    price_type: 'fixed',
    city: 'Adana',
    district: 'Seyhan',
    is_nationwide: false,
    address: null,
    description: 'Taze ürün',
    harvest_date: '2026-08-20',
    ...overrides,
  };
}

test('listing type remains immutable while other commercial fields can change', () => {
  assert.throws(
    () => buildListingUpdate(listing(), { listing_type: 'buy', description: 'Yeni' }),
    /İlan tipi düzenlenemez/,
  );

  const result = buildListingUpdate(listing(), {
    crop_name: 'Mayer Limon',
    category: 'fruit',
    quantity: 150,
    price_per_unit: 15,
    city: 'Mersin',
    district: '',
  });
  assert.equal(result.updates.crop_name, 'Mayer Limon');
  assert.equal(result.updates.quantity, 150);
  assert.equal(result.updates.district, null);
  assert.equal(result.updates.product_family_key, 'limon');
  assert.equal(result.productFamilyChanged, false);
  assert.equal(result.visibleChanged, true);
});

test('category and catalog changes recompute product identity', () => {
  const result = buildListingUpdate(listing(), {
    crop_name: 'Yer Fıstığı',
    category: 'nut',
    catalog_product_key: 'yer-fistigi',
  });
  assert.equal(result.updates.product_family_key, 'yer-fistigi');
  assert.equal(result.updates.category, 'nut');
  assert.equal(result.productFamilyChanged, true);
});

test('limited quantity must remain above fulfilled quantity', () => {
  assert.throws(
    () => buildListingUpdate(listing(), { quantity: 20 }),
    /kabul edilmiş miktardan büyük/,
  );
  assert.equal(
    buildListingUpdate(listing(), { quantity_unlimited: true }).updates.quantity,
    0,
  );
});

test('empty price becomes negotiable and nationwide clears location', () => {
  const result = buildListingUpdate(listing(), {
    price_per_unit: null,
    price_type: 'fixed',
    is_nationwide: true,
  });
  assert.equal(result.updates.price_per_unit, null);
  assert.equal(result.updates.price_type, 'negotiate');
  assert.equal(result.updates.city, null);
  assert.equal(result.updates.district, null);
});

test('unchanged payload is a no-op and internal identity repair is not visible', () => {
  const unchanged = buildListingUpdate(listing(), { description: 'Taze ürün' });
  assert.equal(unchanged.hasChanges, false);
  assert.equal(unchanged.visibleChanged, false);

  const repaired = buildListingUpdate(
    listing({ product_key: 'eski-yanlis-deger' }),
    { crop_name: 'Limon' },
  );
  assert.equal(repaired.hasChanges, true);
  assert.equal(repaired.visibleChanged, false);
});
