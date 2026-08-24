function parseRetainedImageUrls(rawValue) {
  if (rawValue == null || rawValue === '') return [];
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    try {
      parsed = JSON.parse(rawValue);
    } catch (_) {
      const error = new Error('Korunacak fotoğraf listesi geçersiz.');
      error.status = 400;
      throw error;
    }
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    const error = new Error('Korunacak fotoğraf listesi geçersiz.');
    error.status = 400;
    throw error;
  }
  return [...new Set(parsed.map((value) => value.trim()).filter(Boolean))];
}

function cloudinaryPublicId(imageUrl, listingId) {
  try {
    const url = new URL(imageUrl);
    const marker = '/image/upload/';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    const segments = url.pathname.slice(markerIndex + marker.length).split('/');
    const versionIndex = segments.findIndex((segment) => /^v\d+$/.test(segment));
    const assetSegments = versionIndex >= 0
      ? segments.slice(versionIndex + 1)
      : segments.filter((segment) => !segment.includes(','));
    const publicId = decodeURIComponent(assetSegments.join('/')).replace(/\.[^.\/]+$/, '');
    const expectedPrefix = `tarim-pazar/listings/${listingId}/`;
    return publicId.startsWith(expectedPrefix) ? publicId : null;
  } catch (_) {
    return null;
  }
}

function validateRetainedImageUrls(existingUrls, retainedUrls) {
  const existing = new Set(existingUrls || []);
  const invalid = retainedUrls.filter((url) => !existing.has(url));
  if (invalid.length) {
    const error = new Error('Korunacak fotoğraflardan biri bu ilana ait değil.');
    error.status = 400;
    throw error;
  }
}

module.exports = {
  cloudinaryPublicId,
  parseRetainedImageUrls,
  validateRetainedImageUrls,
};
