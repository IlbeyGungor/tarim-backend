require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function calcTrend(currentAvg, previousAvg) {
  if (!previousAvg || Number(previousAvg) === 0) return 0;
  return Number(((currentAvg - previousAvg) / previousAvg).toFixed(4));
}

async function fetchSourceRows() {
  // Burayı kendi veri kaynağına göre doldur
  return [
    {
      product: 'Mayer Limon',
      scope: 'market',
      market: 'Mersin Hali',
      city: 'Mersin',
      production_type: 'Geleneksel',
      min_price: 22,
      max_price: 28,
      avg_price: 25,
      unit: 'kg',
      icon: '🍋'
    },

    // Türkiye ortalaması verisi
    {
      product: 'Mayer Limon',
      scope: 'national',
      market: 'Türkiye',
      city: 'Türkiye',
      production_type: 'Geleneksel',
      min_price: null,
      max_price: null,
      avg_price: 25,
      unit: 'kg',
      icon: '🍋'
    }
  ];
}

async function run() {
  const client = await pool.connect();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await fetchSourceRows();

    await client.query('BEGIN');

    for (const row of rows) {
      await client.query(`
        INSERT INTO market_price_history
          (product, scope, market, city, production_type, min_price, max_price, avg_price, unit, price_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (product, market, city, production_type, price_date)
        DO UPDATE SET
          min_price = EXCLUDED.min_price,
          max_price = EXCLUDED.max_price,
          avg_price = EXCLUDED.avg_price,
          unit = EXCLUDED.unit
      `, [
          row.product,
          row.scope,
          row.market,
          row.city,
          row.production_type ?? 'Geleneksel',
          row.min_price,
          row.max_price,
          row.avg_price,
          row.unit,
          today
      ]);

      const prev = await client.query(`
        SELECT price_date, avg_price
        FROM market_price_history
        WHERE product = $1
          AND market = $2
          AND city = $3
          AND price_date < $4
        ORDER BY price_date DESC
        LIMIT 1
      `, [row.product, row.market, row.city, today]);

      const prevRow = prev.rows[0];
      const trend = calcTrend(Number(row.avg_price), prevRow ? Number(prevRow.avg_price) : null);

      await client.query(`
        INSERT INTO market_price_latest
          (product, scope, market, city, production_type, min_price, max_price, avg_price, unit, latest_price_date, prev_price_date, trend, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (product, market, cit, production_type)
        DO UPDATE SET
          min_price = EXCLUDED.min_price,
          max_price = EXCLUDED.max_price,
          avg_price = EXCLUDED.avg_price,
          unit = EXCLUDED.unit,
          latest_price_date = EXCLUDED.latest_price_date,
          prev_price_date = EXCLUDED.prev_price_date,
          trend = EXCLUDED.trend,
          updated_at = NOW()
      `, [
        row.product, row.scope, row.market, row.city, row.production_type ?? 'Geleneksel',
        row.min_price, row.max_price, row.avg_price, row.unit,
        today, prevRow?.price_date ?? null, trend
      ]);
    }

    await client.query('COMMIT');
    console.log(`market prices updated for ${today}: ${rows.length} rows`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();