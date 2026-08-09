const test = require('node:test');
const assert = require('node:assert/strict');
const {
  areListingUnitsCompatible,
  listingTotalMultiplier,
} = require('../src/utils/listingUnits');

test('kg and ton price units are mutually compatible', () => {
  assert.equal(areListingUnitsCompatible('kg', 'kg'), true);
  assert.equal(areListingUnitsCompatible('kg', 'ton'), true);
  assert.equal(areListingUnitsCompatible('ton', 'kg'), true);
  assert.equal(areListingUnitsCompatible('ton', 'ton'), true);
});

test('piece-style units only match themselves', () => {
  assert.equal(areListingUnitsCompatible('adet', 'adet'), true);
  assert.equal(areListingUnitsCompatible('kasa', 'kasa'), true);
  assert.equal(areListingUnitsCompatible('çuval', 'çuval'), true);
  assert.equal(areListingUnitsCompatible('adet', 'kasa'), false);
  assert.equal(areListingUnitsCompatible('kg', 'adet'), false);
});

test('total multiplier converts kg and ton correctly', () => {
  assert.equal(listingTotalMultiplier('ton', 'kg'), 1000);
  assert.equal(listingTotalMultiplier('kg', 'ton'), 0.001);
  assert.equal(listingTotalMultiplier('kasa', 'kasa'), 1);
  assert.equal(listingTotalMultiplier('kasa', 'kg'), null);
});
