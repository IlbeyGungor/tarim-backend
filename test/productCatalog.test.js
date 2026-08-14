const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCatalogItems,
  normalizeTurkish,
  resolveProductIdentity,
} = require('../src/utils/productCatalog');

test('Turkish names normalize deterministically', () => {
  assert.equal(normalizeTurkish('  Şeftali / İZMİR '), 'seftali izmir');
});

test('lemon varieties share the lemon family', () => {
  for (const name of ['Limon', 'Mayer Limon', 'Yatak Limon', 'Enter Limon']) {
    assert.equal(resolveProductIdentity(name, 'fruit').product_family_key, 'limon');
  }
});

test('lemon grass is not matched to the lemon fruit family', () => {
  assert.equal(
    resolveProductIdentity('Limon Grass Limon Otu', 'other').product_family_key,
    'product:limon-otu'
  );
});

test('pistachio and peanut use distinct match families', () => {
  assert.equal(resolveProductIdentity('Fıstık', 'nut').product_family_key, 'fistik');
  assert.equal(
    resolveProductIdentity('Kavrulmuş Antep Fıstığı', 'nut').product_family_key,
    'antep-fistigi'
  );
  assert.equal(
    resolveProductIdentity('Kabuklu Yer Fıstığı', 'nut').product_family_key,
    'yer-fistigi'
  );
});

test('catalog deduplicates normalized product names', () => {
  const items = buildCatalogItems([
    { product: 'Limon' },
    { product: '  Limon  ' },
    { product: 'Mayer Limon' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].family_key, 'limon');
  assert.equal(items[1].family_key, 'limon');
});
