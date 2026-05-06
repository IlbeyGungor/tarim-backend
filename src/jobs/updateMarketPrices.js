require('dotenv').config();
const { Pool } = require('pg');
const { fetchAdanaRows } = require("./scrapers/adana");
const { fetchIzmirRows } = require("./scrapers/izmir");
const { fetchBursaRows } = require("./scrapers/bursa");
const { fetchAntalyaRows } = require("./scrapers/antalya");
const { fetchTurkeyRows } = require("./scrapers/turkiye");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function calcTrend(currentAvg, previousAvg) {
  if (!previousAvg || Number(previousAvg) === 0) return 0;
  return Number(((currentAvg - previousAvg) / previousAvg).toFixed(4));
}

async function fetchSourceRows() {
  const adanaRows = await fetchAdanaRows();
  const izmirRows = await fetchIzmirRows();
  const bursaRows = await fetchBursaRows();
  const antalyaRows = await fetchAntalyaRows();
  const turkeyRows = await fetchTurkeyRows();

  return [
    ...adanaRows,
    ...izmirRows,
    ...bursaRows,
    ...antalyaRows,
    ...turkeyRows
  ];
}

async function run() {
  const client = await pool.connect();

  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await fetchSourceRows();

    await client.query('BEGIN');

    for (const row of rows) {
      const productionType = row.production_type ?? 'Geleneksel';

      await client.query(`
        INSERT INTO market_price_history
          (
            product,
            scope,
            market,
            city,
            production_type,
            icon,
            min_price,
            max_price,
            avg_price,
            unit,
            price_date
          )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (product, market, city, production_type, price_date)
        DO UPDATE SET
          scope = EXCLUDED.scope,
          icon = EXCLUDED.icon,
          min_price = EXCLUDED.min_price,
          max_price = EXCLUDED.max_price,
          avg_price = EXCLUDED.avg_price,
          unit = EXCLUDED.unit
      `, [
        row.product,
        row.scope,
        row.market,
        row.city,
        productionType,
        row.icon,
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
          AND scope = $2
          AND market = $3
          AND city = $4
          AND production_type = $5
          AND price_date < $6
        ORDER BY price_date DESC
        LIMIT 1
      `, [
        row.product,
        row.scope,
        row.market,
        row.city,
        productionType,
        today
      ]);

      const prevRow = prev.rows[0];

      const trend = calcTrend(
        Number(row.avg_price),
        prevRow ? Number(prevRow.avg_price) : null
      );

      await client.query(`
        INSERT INTO market_price_latest
          (
            product,
            scope,
            market,
            city,
            production_type,
            icon,
            min_price,
            max_price,
            avg_price,
            unit,
            latest_price_date,
            prev_price_date,
            trend,
            updated_at
          )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT (product, market, city, production_type)
        DO UPDATE SET
          scope = EXCLUDED.scope,
          icon = EXCLUDED.icon,
          min_price = EXCLUDED.min_price,
          max_price = EXCLUDED.max_price,
          avg_price = EXCLUDED.avg_price,
          unit = EXCLUDED.unit,
          latest_price_date = EXCLUDED.latest_price_date,
          prev_price_date = EXCLUDED.prev_price_date,
          trend = EXCLUDED.trend,
          updated_at = NOW()
      `, [
        row.product,
        row.scope,
        row.market,
        row.city,
        productionType,
        row.icon,
        row.min_price,
        row.max_price,
        row.avg_price,
        row.unit,
        today,
        prevRow?.price_date ?? null,
        trend
      ]);
    }

    await client.query('COMMIT');

    console.log(`market prices updated for ${today}: ${rows.length} rows`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();