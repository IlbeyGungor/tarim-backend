require('dotenv').config();
const { Pool } = require('pg');
const { fetchAdanaRows } = require("./scrapers/adana");
const { fetchIzmirRows } = require("./scrapers/izmir");
const { fetchBursaRows } = require("./scrapers/bursa");
const { fetchAntalyaRows } = require("./scrapers/antalya");
const { fetchCanakkaleRows } = require("./scrapers/canakkale");
const { fetchTurkeyRows } = require("./scrapers/turkiye");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function getTodayDateForTurkey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;

  return `${year}-${month}-${day}`;
}

function normalizePriceDate(value, fallbackDate) {
  if (!value) return fallbackDate;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const str = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  return fallbackDate;
}

function calcTrend(currentAvg, previousAvg) {
  if (!previousAvg || Number(previousAvg) === 0) return 0;
  return Number(((currentAvg - previousAvg) / previousAvg).toFixed(4));
}

async function fetchSourceRows() {
  const adanaRows = await fetchAdanaRows();
  console.log(`Adana rows: ${adanaRows.length}`);

  const izmirRows = await fetchIzmirRows();
  console.log(`Izmir rows: ${izmirRows.length}`);
  console.log(`Izmir selected price_date: ${izmirRows[0]?.price_date ?? 'no rows'}`);

  const bursaRows = await fetchBursaRows();
  console.log(`Bursa rows: ${bursaRows.length}`);

  const antalyaRows = await fetchAntalyaRows();
  console.log(`Antalya rows: ${antalyaRows.length}`);

  const turkeyRows = await fetchTurkeyRows();
  console.log(`Turkey rows: ${turkeyRows.length}`);

  const canakkaleRows = await fetchCanakkaleRows();
  console.log(`Canakkale rows: ${canakkaleRows.length}`);
  console.log(`Canakkale selected price_date: ${canakkaleRows[0]?.price_date ?? 'no rows'}`);

  return [
    ...adanaRows,
    ...izmirRows,
    ...bursaRows,
    ...antalyaRows,
    ...turkeyRows,
    ...canakkaleRows
  ];
}

async function run() {
  const client = await pool.connect();

  try {
    const today = getTodayDateForTurkey();
    const rows = await fetchSourceRows();

    await client.query('BEGIN');

    for (const row of rows) {
      const productionType = String(row.production_type ?? '').trim() || 'Geleneksel';
      const priceDate = normalizePriceDate(row.price_date, today);

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
        priceDate
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
        priceDate
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
        WHERE market_price_latest.latest_price_date IS NULL
           OR EXCLUDED.latest_price_date >= market_price_latest.latest_price_date
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
        priceDate,
        prevRow?.price_date ?? null,
        trend
      ]);
    }

    await client.query('COMMIT');

    console.log(`market prices updated at ${today}: ${rows.length} rows`);
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