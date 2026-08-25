const PRODUCTS = Object.freeze({
  listing_boost_1d: Object.freeze({
    productId: 'listing_boost_1d',
    durationDays: 1,
    configuredPriceTry: 49,
  }),
  listing_boost_3d: Object.freeze({
    productId: 'listing_boost_3d',
    durationDays: 3,
    configuredPriceTry: 99,
  }),
  listing_boost_7d: Object.freeze({
    productId: 'listing_boost_7d',
    durationDays: 7,
    configuredPriceTry: 179,
  }),
});

function getPromotionProduct(productId) {
  return PRODUCTS[String(productId || '').trim()] || null;
}

function listPromotionProducts() {
  return Object.values(PRODUCTS);
}

function promotionsEnabled() {
  return String(process.env.PROMOTIONS_ENABLED || '').toLowerCase() === 'true';
}

module.exports = {
  PRODUCTS,
  getPromotionProduct,
  listPromotionProducts,
  promotionsEnabled,
};
