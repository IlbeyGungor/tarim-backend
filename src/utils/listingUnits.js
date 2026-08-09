const LISTING_UNITS = Object.freeze(['kg', 'ton', 'adet', 'kasa', 'çuval']);
const WEIGHT_UNITS = new Set(['kg', 'ton']);

function isListingUnit(value) {
  return LISTING_UNITS.includes(String(value || '').trim().toLowerCase());
}

function areListingUnitsCompatible(quantityUnit, priceUnit) {
  const quantity = String(quantityUnit || '').trim().toLowerCase();
  const price = String(priceUnit || '').trim().toLowerCase();
  if (!isListingUnit(quantity) || !isListingUnit(price)) return false;
  if (WEIGHT_UNITS.has(quantity) && WEIGHT_UNITS.has(price)) return true;
  return quantity === price;
}

function listingTotalMultiplier(quantityUnit, priceUnit) {
  if (!areListingUnitsCompatible(quantityUnit, priceUnit)) return null;
  if (quantityUnit === 'ton' && priceUnit === 'kg') return 1000;
  if (quantityUnit === 'kg' && priceUnit === 'ton') return 1 / 1000;
  return 1;
}

module.exports = {
  LISTING_UNITS,
  isListingUnit,
  areListingUnitsCompatible,
  listingTotalMultiplier,
};
