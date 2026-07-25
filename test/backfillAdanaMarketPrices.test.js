const test = require("node:test");
const assert = require("node:assert/strict");

const {
  replaceAdanaHistoryDate,
  runBackfill,
} = require("../src/jobs/backfillAdanaMarketPrices");

function samplePage() {
  return {
    pageId: 2576,
    priceDate: "2026-05-06",
    rows: [
      {
        product: "ELMA",
        scope: "market",
        market: "Adana Hali",
        city: "Adana",
        production_type: "Geleneksel",
        icon: "🍎",
        min_price: 10,
        max_price: 20,
        avg_price: 15,
        unit: "kg",
        price_date: "2026-05-06",
      },
    ],
  };
}

const silentLog = {
  log() {},
  warn() {},
};

test("dry-run never opens a database connection", async () => {
  let connectionCount = 0;

  const result = await runBackfill({
    dryRun: true,
    today: "2026-05-06",
    fetchPage: async (pageId) =>
      pageId === 2576
        ? samplePage()
        : { pageId, priceDate: null, rows: [] },
    getClientFn: async () => {
      connectionCount += 1;
      throw new Error("dry-run must not connect");
    },
    requestDelayMs: 0,
    log: silentLog,
  });

  assert.equal(connectionCount, 0);
  assert.equal(result.pagesWithRows, 1);
  assert.equal(result.writtenRows, 0);
  assert.deepEqual(result.missingDates, []);
  assert.equal(result.hasFailures, false);
});

test("replaces one date transactionally and remains rerunnable", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
    },
  };

  await replaceAdanaHistoryDate(client, samplePage());
  await replaceAdanaHistoryDate(client, samplePage());

  assert.equal(queries.filter((item) => item.sql === "BEGIN").length, 2);
  assert.equal(queries.filter((item) => item.sql === "COMMIT").length, 2);

  const deletes = queries.filter((item) =>
    item.sql.startsWith("DELETE FROM market_price_history")
  );
  assert.equal(deletes.length, 2);
  assert.deepEqual(deletes[0].params, ["Adana Hali", "Adana", "2026-05-06"]);

  const inserts = queries.filter((item) =>
    item.sql.startsWith("INSERT INTO market_price_history")
  );
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].sql, /ON CONFLICT/);
  assert.equal(inserts[0].params.at(-1), "2026-05-06");
});

test("a page with no valid rows preserves existing database data", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
    },
  };

  await assert.rejects(
    replaceAdanaHistoryDate(client, {
      pageId: 2576,
      priceDate: "2026-05-06",
      rows: [],
    }),
    /empty page snapshot/
  );
  assert.deepEqual(queries, []);
});
