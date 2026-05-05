const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../db');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  const cleaned = String(value)
    .replace(/[₺TLtl\s]/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .trim();

  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const str = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  const parts = str.split(/[./-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (c.length === 4) {
      return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    }
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function normalizeProductionType(value) {
  const v = String(value || '').trim().toLowerCase();

  if (
    v === 'geleneksel' ||
    v === 'geleneksel (konvansiyonel)' ||
    v === 'konvansiyonel'
  ) {
    return 'Geleneksel';
  }

  if (
    v === 'iyi tarım' ||
    v === 'iyi tarim'
  ) {
    return 'İyi Tarım';
  }

  if (
    v === 'organik' ||
    v === 'organik tarım' ||
    v === 'organik tarim'
  ) {
    return 'Organik Tarım';
  }

  return null;
}

async function run() {
  const filePath = path.resolve(process.cwd(), 'data', 'market_price_history.xlsx');
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const row of rows) {
      const product = normalizeText(row.product);
      const scope = normalizeText(row.scope || 'market').toLowerCase();
      const market = normalizeText(row.market);
      const city = normalizeText(row.city);
      const productionType = normalizeProductionType(row.production_type);
      const icon = normalizeText(row.icon || '');
      const minPrice = normalizeNumber(row.min_price);
      const maxPrice = normalizeNumber(row.max_price);
      const avgPrice = normalizeNumber(row.avg_price) ??
        (minPrice != null && maxPrice != null
          ? Number(((minPrice + maxPrice) / 2).toFixed(2))
          : null);
      const unit = normalizeText(row.unit || 'kg');
      const priceDate = normalizeDate(row.price_date);

      if (!product || !scope || !market || !city || !productionType || !unit || !priceDate) {
        console.log('Skipping invalid row:', row);
        continue;
      }

      if (!['market', 'national'].includes(scope)) {
        console.log('Skipping row with invalid scope:', row);
        continue;
      }

      if (minPrice == null || maxPrice == null || avgPrice == null) {
        console.log('Skipping row with invalid prices:', row);
        continue;
      }

      await client.query(`
        INSERT INTO market_price_history
          (product, scope, market, city, production_type, icon, min_price, max_price, avg_price, unit, price_date)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (product, market, city, production_type, price_date)
        DO UPDATE SET
          scope = EXCLUDED.scope,
          icon = EXCLUDED.icon,
          min_price = EXCLUDED.min_price,
          max_price = EXCLUDED.max_price,
          avg_price = EXCLUDED.avg_price,
          unit = EXCLUDED.unit
      `, [
        product,
        scope,
        market,
        city,
        productionType,
        icon || null,
        minPrice,
        maxPrice,
        avgPrice,
        unit,
        priceDate
      ]);
    }

    await client.query('COMMIT');
    console.log(`✅ Excel verileri market_price_history tablosuna aktarıldı. Satır sayısı: ${rows.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Import failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();