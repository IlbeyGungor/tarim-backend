function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeListingQuantity({ quantity, quantityUnlimited = false }) {
  if (quantityUnlimited) {
    return { quantity: 0, quantityUnlimited: true };
  }
  const normalized = Number(quantity);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw inputError('Pozitif bir miktar girin veya miktar sınırı olmadığını seçin.');
  }
  return { quantity: normalized, quantityUnlimited: false };
}

function normalizeListingLocation({ city, district, isNationwide = false }) {
  if (isNationwide) {
    return { city: null, district: null, isNationwide: true };
  }
  const normalizedCity = String(city || '').trim();
  if (!normalizedCity) {
    throw inputError('İl seçimi zorunludur veya Türkiye geneli seçilmelidir.');
  }
  const normalizedDistrict = String(district || '').trim();
  return {
    city: normalizedCity,
    district: normalizedDistrict || null,
    isNationwide: false,
  };
}

function isListingFulfilled({ quantity, fulfilledQuantity, quantityUnlimited = false }) {
  if (quantityUnlimited) return false;
  return Number(fulfilledQuantity) >= Number(quantity);
}

module.exports = {
  isListingFulfilled,
  normalizeListingLocation,
  normalizeListingQuantity,
};
