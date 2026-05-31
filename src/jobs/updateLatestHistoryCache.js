const { query } = require('../db');

async function updateLatestHistoryCache() {
  console.log(`📊 Updating market_price_latest.history_1y started at ${new Date().toISOString()}`);

  const { rowCount } = await query(`
    UPDATE market_price_latest l
    SET history_1y = COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'price_date', h.price_date,
            'min_price', h.min_price,
            'max_price', h.max_price,
            'avg_price', h.avg_price,
            'unit', h.unit
          )
          ORDER BY h.price_date
        )
        FROM market_price_history h
        WHERE h.product = l.product
          AND h.scope = l.scope
          AND h.market = l.market
          AND h.city = l.city
          AND h.production_type = l.production_type
          AND h.price_date >= CURRENT_DATE - INTERVAL '1 year'
      ),
      '[]'::jsonb
    )
  `);

  console.log(`✅ market_price_latest.history_1y updated for ${rowCount} rows`);
}

async function run() {
  try {
    await updateLatestHistoryCache();
    process.exit(0);
  } catch (err) {
    console.error('❌ updateLatestHistoryCache failed:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  updateLatestHistoryCache,
};