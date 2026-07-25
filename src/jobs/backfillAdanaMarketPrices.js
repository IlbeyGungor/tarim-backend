require("dotenv").config();

const { getClient, pool } = require("../db");
const {
  BASE_PAGE_ID,
  BASE_PRICE_DATE,
  MAX_FORWARD_PAGE_SEARCH,
  calculateEstimatedPageId,
  fetchAdanaPage,
  getTodayDateForTurkey,
} = require("./scrapers/adana");

const REQUEST_DELAY_MS = 250;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enumerateIsoDates(startDate, endDate) {
  const dates = [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error(`Invalid Adana backfill date range: ${startDate}..${endDate}`);
  }

  for (let timestamp = start; timestamp <= end; timestamp += ONE_DAY_MS) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }

  return dates;
}

async function replaceAdanaHistoryDate(client, page) {
  if (!page.priceDate || !Array.isArray(page.rows) || page.rows.length === 0) {
    throw new Error("Cannot replace Adana history with an empty page snapshot");
  }

  await client.query("BEGIN");

  try {
    await client.query(
      `
        DELETE FROM market_price_history
        WHERE market = $1
          AND city = $2
          AND price_date = $3
      `,
      ["Adana Hali", "Adana", page.priceDate]
    );

    for (const row of page.rows) {
      const productionType =
        String(row.production_type ?? "").trim() || "Geleneksel";

      await client.query(
        `
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
        `,
        [
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
          page.priceDate,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function runBackfill({
  dryRun = false,
  today = getTodayDateForTurkey(),
  fetchPage = fetchAdanaPage,
  getClientFn = getClient,
  requestDelayMs = REQUEST_DELAY_MS,
  log = console,
} = {}) {
  const lastPageId =
    calculateEstimatedPageId(today) + MAX_FORWARD_PAGE_SEARCH;
  const expectedDates = enumerateIsoDates(BASE_PRICE_DATE, today);
  const successfulDates = new Set();
  const parseFailures = [];
  const requestFailures = [];
  let pagesWithRows = 0;
  let writtenRows = 0;

  log.log(
    `Adana backfill ${dryRun ? "dry-run " : ""}started: pages ${BASE_PAGE_ID}-${lastPageId}, dates ${BASE_PRICE_DATE}-${today}`
  );

  for (let pageId = BASE_PAGE_ID; pageId <= lastPageId; pageId += 1) {
    let page;

    try {
      page = await fetchPage(pageId);
    } catch (err) {
      requestFailures.push({ pageId, message: err.message });
      log.warn(`Adana page ${pageId} request failed: ${err.message}`);
      if (requestDelayMs > 0 && pageId < lastPageId) {
        await sleep(requestDelayMs);
      }
      continue;
    }

    if (!page.priceDate) {
      if (requestDelayMs > 0 && pageId < lastPageId) {
        await sleep(requestDelayMs);
      }
      continue;
    }

    if (page.priceDate < BASE_PRICE_DATE || page.priceDate > today) {
      if (requestDelayMs > 0 && pageId < lastPageId) {
        await sleep(requestDelayMs);
      }
      continue;
    }

    if (successfulDates.has(page.priceDate)) {
      log.warn(
        `Adana page ${pageId} skipped: duplicate date ${page.priceDate}`
      );
      if (requestDelayMs > 0 && pageId < lastPageId) {
        await sleep(requestDelayMs);
      }
      continue;
    }

    if (!Array.isArray(page.rows) || page.rows.length === 0) {
      parseFailures.push({ pageId, priceDate: page.priceDate });
      log.warn(
        `Adana page ${pageId} (${page.priceDate}) contains no valid rows; existing DB data was preserved`
      );
      if (requestDelayMs > 0 && pageId < lastPageId) {
        await sleep(requestDelayMs);
      }
      continue;
    }

    log.log(
      `${dryRun ? "[dry-run] " : ""}Adana page ${pageId}: ${page.priceDate}, ${page.rows.length} rows`
    );

    if (!dryRun) {
      const client = await getClientFn();
      try {
        await replaceAdanaHistoryDate(client, page);
      } finally {
        client.release();
      }
      writtenRows += page.rows.length;
    }

    successfulDates.add(page.priceDate);
    pagesWithRows += 1;

    if (requestDelayMs > 0 && pageId < lastPageId) {
      await sleep(requestDelayMs);
    }
  }

  const missingDates = expectedDates.filter(
    (priceDate) => !successfulDates.has(priceDate)
  );

  log.log(
    `Adana backfill summary: ${pagesWithRows}/${expectedDates.length} dates, ${dryRun ? "0 rows written (dry-run)" : `${writtenRows} rows written`}`
  );

  if (missingDates.length > 0) {
    log.warn(`Missing Adana dates (${missingDates.length}): ${missingDates.join(", ")}`);
  }

  if (parseFailures.length > 0) {
    log.warn(
      `Adana pages with unparsable rows: ${parseFailures
        .map((item) => `${item.pageId}:${item.priceDate}`)
        .join(", ")}`
    );
  }

  if (requestFailures.length > 0) {
    log.warn(
      `Adana request failures: ${requestFailures
        .map((item) => item.pageId)
        .join(", ")}`
    );
  }

  return {
    dryRun,
    pagesWithRows,
    writtenRows,
    missingDates,
    parseFailures,
    requestFailures,
    hasFailures:
      missingDates.length > 0 ||
      parseFailures.length > 0 ||
      requestFailures.length > 0,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  try {
    const result = await runBackfill({ dryRun });
    if (result.hasFailures) process.exitCode = 1;
  } catch (err) {
    console.error("Adana backfill failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  enumerateIsoDates,
  replaceAdanaHistoryDate,
  runBackfill,
};
