const { resolveProductIdentity } = require('../utils/productCatalog');
const { isListingUnit, areListingUnitsCompatible } = require('../utils/listingUnits');
const { normalizeListingLocation, normalizeListingQuantity } = require('../utils/listingScope');

const EDITABLE_FIELDS = new Set([
  'crop_name', 'category', 'catalog_product_key', 'quantity',
  'quantity_unlimited', 'unit', 'price_per_unit', 'price_unit',
  'price_type', 'city', 'district', 'is_nationwide', 'address',
  'description', 'harvest_date',
]);

function httpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizedComparable(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value == null) return null;
  return String(value).trim();
}

function buildListingUpdate(existing, input) {
  if (has(input, 'listing_type') && input.listing_type !== existing.listing_type) {
    throw httpError('İlan tipi düzenlenemez.', 400, 'LISTING_TYPE_IMMUTABLE');
  }
  if (!Object.keys(input).some((key) => EDITABLE_FIELDS.has(key))) {
    throw httpError('Güncellenecek alan yok.');
  }
  for (const key of ['quantity_unlimited', 'is_nationwide']) {
    if (has(input, key) && typeof input[key] !== 'boolean') {
      throw httpError('İlan kapsamı seçimi geçersiz.');
    }
  }

  const cropName = has(input, 'crop_name')
    ? String(input.crop_name || '').trim()
    : existing.crop_name;
  if (!cropName) throw httpError('Ürün adı zorunludur.');

  const category = has(input, 'category') ? input.category : existing.category;
  if (!['grain', 'vegetable', 'fruit', 'nut', 'legume', 'other'].includes(category)) {
    throw httpError('Geçersiz kategori.');
  }

  const quantityScope = normalizeListingQuantity({
    quantity: has(input, 'quantity') ? input.quantity : existing.quantity,
    quantityUnlimited: has(input, 'quantity_unlimited')
      ? input.quantity_unlimited
      : existing.quantity_unlimited,
  });
  if (!quantityScope.quantityUnlimited &&
      quantityScope.quantity <= Number(existing.fulfilled_quantity || 0)) {
    throw httpError('Hedef miktar kabul edilmiş miktardan büyük olmalıdır.');
  }

  const locationScope = normalizeListingLocation({
    city: has(input, 'city') ? input.city : existing.city,
    district: has(input, 'district') ? input.district : existing.district,
    isNationwide: has(input, 'is_nationwide')
      ? input.is_nationwide
      : existing.is_nationwide,
  });

  const unit = has(input, 'unit') ? input.unit : existing.unit;
  const priceUnit = has(input, 'price_unit')
    ? input.price_unit
    : (existing.price_unit || unit);
  if (!isListingUnit(unit) || !isListingUnit(priceUnit) ||
      !areListingUnitsCompatible(unit, priceUnit)) {
    throw httpError('Miktar ve fiyat birimleri birbiriyle uyumlu değil.');
  }

  const rawPrice = has(input, 'price_per_unit')
    ? input.price_per_unit
    : existing.price_per_unit;
  const price = rawPrice == null || rawPrice === '' ? null : Number(rawPrice);
  if (price != null && !(price > 0)) {
    throw httpError('Birim fiyat sıfırdan büyük olmalıdır.');
  }
  const requestedPriceType = has(input, 'price_type')
    ? input.price_type
    : existing.price_type;
  if (!['fixed', 'negotiate'].includes(requestedPriceType)) {
    throw httpError('Geçersiz fiyat tipi.');
  }

  const catalogProductKey = has(input, 'catalog_product_key')
    ? (input.catalog_product_key || null)
    : existing.catalog_product_key;
  const identity = resolveProductIdentity(cropName, category, catalogProductKey);
  const updates = {
    crop_name: cropName,
    category,
    quantity: quantityScope.quantity,
    quantity_unlimited: quantityScope.quantityUnlimited,
    unit,
    price_per_unit: price,
    price_unit: priceUnit,
    price_type: price == null ? 'negotiate' : requestedPriceType,
    city: locationScope.city,
    district: locationScope.district,
    is_nationwide: locationScope.isNationwide,
    address: has(input, 'address') ? (input.address || null) : existing.address,
    description: has(input, 'description')
      ? (input.description || null)
      : existing.description,
    harvest_date: has(input, 'harvest_date')
      ? (input.harvest_date || null)
      : existing.harvest_date,
    product_key: identity.product_key,
    product_family_key: identity.product_family_key,
    catalog_product_key: identity.catalog_product_key,
  };

  const changedFields = Object.keys(updates).filter(
    (key) => normalizedComparable(updates[key]) !== normalizedComparable(existing[key]),
  );
  const visibleChanged = changedFields.some(
    (key) => !['product_key', 'product_family_key', 'catalog_product_key'].includes(key),
  );
  return {
    updates,
    changedFields,
    hasChanges: changedFields.length > 0,
    visibleChanged,
    productFamilyChanged: updates.product_family_key !== existing.product_family_key,
  };
}

module.exports = { buildListingUpdate };
