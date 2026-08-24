const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isListingFulfilled,
  normalizeListingLocation,
  normalizeListingQuantity,
} = require('../src/utils/listingScope');

test('legacy listing payload keeps a positive limited quantity', () => {
  assert.deepEqual(
    normalizeListingQuantity({ quantity: '12.5' }),
    { quantity: 12.5, quantityUnlimited: false },
  );
});

test('unlimited quantity is stored as zero without requiring an input', () => {
  assert.deepEqual(
    normalizeListingQuantity({ quantityUnlimited: true }),
    { quantity: 0, quantityUnlimited: true },
  );
});

test('limited quantity rejects blank and non-positive values', () => {
  for (const quantity of [undefined, '', 0, -1]) {
    assert.throws(
      () => normalizeListingQuantity({ quantity }),
      /Pozitif bir miktar/,
    );
  }
});

test('district is optional for a city listing', () => {
  assert.deepEqual(
    normalizeListingLocation({ city: 'Adana', district: '' }),
    { city: 'Adana', district: null, isNationwide: false },
  );
});

test('nationwide listing clears city and district', () => {
  assert.deepEqual(
    normalizeListingLocation({
      city: 'Adana',
      district: 'Seyhan',
      isNationwide: true,
    }),
    { city: null, district: null, isNationwide: true },
  );
});

test('a regular listing still requires a city', () => {
  assert.throws(
    () => normalizeListingLocation({ city: '', district: '' }),
    /İl seçimi zorunludur/,
  );
});

test('unlimited listings remain active after any accepted quantity', () => {
  assert.equal(
    isListingFulfilled({
      quantity: 0,
      fulfilledQuantity: 5000,
      quantityUnlimited: true,
    }),
    false,
  );
  assert.equal(
    isListingFulfilled({
      quantity: 100,
      fulfilledQuantity: 100,
      quantityUnlimited: false,
    }),
    true,
  );
});
