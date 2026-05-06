const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../db');

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  // Excel hücresi gerçekten number ise direkt kullan
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value.toFixed(2));
  }

  let str = String(value).trim();

  if (!str) return null;

  // Para birimi / boşluk temizliği
  str = str.replace(/[₺TLtl\s]/g, '');

  // Türkçe sayı formatı: 1.234,56
  if (str.includes(',') && str.includes('.')) {
    str = str.replace(/\./g, '').replace(',', '.');
  }
  // Sadece virgül varsa: 123,45
  else if (str.includes(',')) {
    str = str.replace(',', '.');
  }
  // Sadece nokta varsa olduğu gibi bırak: 1234.56

  const num = Number(str);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

function normalizeDate(value) {
  if (value == null || value === '') return null;

  // Excel true date hücresi -> JS Date
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  // Excel serial number -> date
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const jsDate = new Date(excelEpoch.getTime() + value * 86400000);

    if (!isNaN(jsDate.getTime())) {
      return jsDate.toISOString().slice(0, 10);
    }
    return null;
  }

  const str = String(value).trim();

  // String olarak gelen Excel serial
  if (/^\d{5}(\.\d+)?$/.test(str)) {
    const serial = Number(str);
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const jsDate = new Date(excelEpoch.getTime() + serial * 86400000);

    if (!isNaN(jsDate.getTime())) {
      return jsDate.toISOString().slice(0, 10);
    }
    return null;
  }

  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy
  const parts = str.split(/[.\-/]/);
  if (parts.length === 3) {
    const [day, month, year] = parts;
    if (year.length === 4) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  return null;
}

function normalizeProductionType(value) {
  const v = String(value ?? '').trim().toLowerCase();

  if (
    v === '' ||
    v === 'geleneksel' ||
    v === 'geleneksel (konvansiyonel)' ||
    v === 'konvansiyonel'
  ) {
    return 'Geleneksel';
  }

  if (v === 'iyi tarım' || v === 'iyi tarim') {
    return 'İyi Tarım';
  }

  if (v === 'organik' || v === 'organik tarım' || v === 'organik tarim') {
    return 'Organik Tarım';
  }

  return 'Geleneksel';
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function run() {
  const filePath = path.resolve(process.cwd(), 'data', 'market_price_history.xlsx');
  console.log('📘 Excel okunuyor:', filePath);

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const client = await pool.connect();
  console.log('✅ DB connection established');

  console.log(`📊 Toplam satır: ${rows.length}`);

  const validRows = [];
  let skippedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const product = normalizeText(row.product);
    const scope = normalizeText(row.scope || 'market').toLowerCase();
    const market = normalizeText(row.market);
    const city = normalizeText(row.city);
    const productionType = normalizeProductionType(row.production_type);
    const icon = normalizeText(row.icon || '');

    let minPrice = normalizeNumber(row.min_price);
    let maxPrice = normalizeNumber(row.max_price);
    const avgPrice = normalizeNumber(row.avg_price);

    const unit = normalizeText(row.unit || 'kg');
    const priceDate = normalizeDate(row.price_date);

    if (!product || !scope || !market || !city || !productionType || !unit || !priceDate) {
  skippedCount++;
  if (skippedCount <= 50) {
    console.log('⚠️ Skipping invalid row:', {
      product,
      scope,
      market,
      city,
      productionType,
      unit,
      rawPriceDate: row.price_date,
      normalizedPriceDate: priceDate,
      row
    });
  }
  continue;
}

    if (!['market', 'national'].includes(scope)) {
      skippedCount++;
      if (skippedCount <= 20) {
        console.log('⚠️ Skipping row with invalid scope:', row);
      }
      continue;
    }

    // avg_price zorunlu
    if (avgPrice == null) {
      skippedCount++;
      if (skippedCount <= 20) {
        console.log('⚠️ Skipping row with invalid avg_price:', row);
      }
      continue;
    }

    const tooLarge =
      (minPrice != null && Math.abs(minPrice) >= 100000000) ||
      (maxPrice != null && Math.abs(maxPrice) >= 100000000) ||
      (avgPrice != null && Math.abs(avgPrice) >= 100000000);

    if (tooLarge) {
      skippedCount++;
      if (skippedCount <= 50) {
        console.log('⚠️ Skipping row with overflow-sized number:', {
          rawRow: row,
          parsed: { minPrice, maxPrice, avgPrice }
        });
      }
      continue;
    }

    // Türkiye verisinde min/max yoksa null bırak
    if (minPrice == null) minPrice = null;
    if (maxPrice == null) maxPrice = null;

    validRows.push({
      product,
      scope,
      market,
      city,
      productionType,
      icon: icon || null,
      minPrice,
      maxPrice,
      avgPrice,
      unit,
      priceDate
    });

    if ((i + 1) % 10000 === 0) {
      console.log(`🔄 Normalize edilen satır: ${i + 1}/${rows.length}`);
    }
  }

  console.log(`✅ Geçerli satır: ${validRows.length}`);
  console.log(`⏭️ Atlanan satır: ${skippedCount}`);

  if (!validRows.length) {
    console.log('❌ Import edilecek geçerli satır yok.');
    process.exit(1);
  }

  const dedupedMap = new Map();

  for (const row of validRows) {
    const key = [
      row.product,
      row.market,
      row.city,
      row.productionType,
      row.priceDate
    ].join('||');

    dedupedMap.set(key, row);
  }

  const dedupedRows = Array.from(dedupedMap.values());

  console.log(`🧹 Duplicate temizliği sonrası satır: ${dedupedRows.length}`);
  console.log(`🗑️ Temizlenen duplicate sayısı: ${validRows.length - dedupedRows.length}`);  


  try {
    const batchSize = 1000;
    const batches = chunkArray(dedupedRows, batchSize);

    console.log(`📦 Batch sayısı: ${batches.length} (batch size: ${batchSize})`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      const placeholders = batch
        .map((_, rowIndex) => {
          const base = rowIndex * 11;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
        })
        .join(', ');

      const values = batch.flatMap(row => [
        row.product,
        row.scope,
        row.market,
        row.city,
        row.productionType,
        row.icon,
        row.minPrice,
        row.maxPrice,
        row.avgPrice,
        row.unit,
        row.priceDate
      ]);

      await client.query(
        `
        INSERT INTO market_price_history
          (product, scope, market, city, production_type, icon, min_price, max_price, avg_price, unit, price_date)
        VALUES
          ${placeholders}
        ON CONFLICT (product, market, city, production_type, price_date)
        DO UPDATE SET
          scope = EXCLUDED.scope,
          icon = EXCLUDED.icon,
          min_price = EXCLUDED.min_price,
          max_price = EXCLUDED.max_price,
          avg_price = EXCLUDED.avg_price,
          unit = EXCLUDED.unit
        `,
        values
      );

      console.log(`✅ Batch ${i + 1}/${batches.length} tamamlandı (${batch.length} satır)`);
    }

    console.log(`🎉 Import tamamlandı. Toplam import edilen/geçilen satır: ${validRows.length}`);
  } catch (err) {
    console.error('❌ Import failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();