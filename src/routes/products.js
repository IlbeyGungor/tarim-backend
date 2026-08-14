const router = require('express').Router();
const { query } = require('../db');
const { buildCatalogItems } = require('../utils/productCatalog');

router.get('/catalog', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT DISTINCT product
      FROM market_price_latest
      WHERE scope='national' AND BTRIM(product)<>''
      ORDER BY product
    `);
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.json({ products: buildCatalogItems(rows), updated_at: new Date().toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;
