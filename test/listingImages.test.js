const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cloudinaryPublicId,
  parseRetainedImageUrls,
  validateRetainedImageUrls,
} = require('../src/services/listingImages');

test('retained image input is parsed and deduplicated', () => {
  assert.deepEqual(
    parseRetainedImageUrls('["https://example.com/a.jpg","https://example.com/a.jpg"]'),
    ['https://example.com/a.jpg'],
  );
  assert.throws(() => parseRetainedImageUrls('{bad json'), /geçersiz/);
});

test('retained images must already belong to the listing', () => {
  assert.doesNotThrow(() => validateRetainedImageUrls(['a', 'b'], ['b']));
  assert.throws(() => validateRetainedImageUrls(['a'], ['other']), /ait değil/);
});

test('Cloudinary public id is accepted only from the listing folder', () => {
  const url = 'https://res.cloudinary.com/demo/image/upload/c_limit,w_1200/v1786980496/tarim-pazar/listings/listing-1/photo.jpg';
  assert.equal(
    cloudinaryPublicId(url, 'listing-1'),
    'tarim-pazar/listings/listing-1/photo',
  );
  assert.equal(cloudinaryPublicId(url, 'listing-2'), null);
  assert.equal(cloudinaryPublicId('https://example.com/photo.jpg', 'listing-1'), null);
});
