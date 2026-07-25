const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateEstimatedPageId,
  fetchAdanaPage,
  findAdanaPageForDate,
  parsePageDateFromHtml,
  parseRowsFromHtml,
} = require("../src/jobs/scrapers/adana");

function pageHtml(dateHeading, rows = "") {
  return `
    <html>
      <body>
        <div class="title-main"><h4>${dateHeading}</h4></div>
        <table>${rows}</table>
      </body>
    </html>
  `;
}

test("estimates Adana page IDs from the 2576 baseline", () => {
  assert.equal(calculateEstimatedPageId("2026-05-06"), 2576);
  assert.equal(calculateEstimatedPageId("2026-07-24"), 2655);
  assert.equal(calculateEstimatedPageId("2026-07-25"), 2656);
});

test("reads the price date only from the expected title", () => {
  assert.equal(
    parsePageDateFromHtml(
      pageHtml("25/07/2026 Tarihli Günlük Raiç Bedeli")
    ),
    "2026-07-25"
  );
  assert.equal(
    parsePageDateFromHtml("<h4>25/07/2026 Tarihli Günlük Raiç Bedeli</h4>"),
    null
  );
  assert.equal(
    parsePageDateFromHtml(pageHtml("31/02/2026 Tarihli Günlük Raiç Bedeli")),
    null
  );
  assert.equal(parsePageDateFromHtml(pageHtml("Fiyat listesi")), null);
});

test("keeps the Adana row contract and adds the verified price date", () => {
  const rows = parseRowsFromHtml(
    pageHtml(
      "25/07/2026 Tarihli Günlük Raiç Bedeli",
      "<tr><td>DOMATES</td><td>Kg.</td><td>1.250,50 TL</td><td>1.500,50 TL</td></tr>"
    ),
    "2026-07-25"
  );

  assert.deepEqual(rows, [
    {
      product: "DOMATES",
      scope: "market",
      market: "Adana Hali",
      city: "Adana",
      production_type: "Geleneksel",
      min_price: 1250.5,
      max_price: 1500.5,
      avg_price: 1375.5,
      unit: "kg",
      icon: "🍅",
      price_date: "2026-07-25",
    },
  ]);
});

test("maps verified page headings to their actual dates", async () => {
  const actualDates = new Map([
    [2576, "06/05/2026"],
    [2656, "24/07/2026"],
    [2657, "25/07/2026"],
  ]);

  for (const [pageId, displayDate] of actualDates) {
    const result = await fetchAdanaPage(pageId, {
      fetchHtml: async (url) => {
        assert.equal(url.endsWith(`/${pageId}`), true);
        return pageHtml(
          `${displayDate} Tarihli Günlük Raiç Bedeli`,
          "<tr><td>ELMA</td><td>Kg</td><td>10</td><td>20</td></tr>"
        );
      },
    });

    const [day, month, year] = displayDate.split("/");
    const expectedDate = `${year}-${month}-${day}`;
    assert.equal(result.pageId, pageId);
    assert.equal(result.priceDate, expectedDate);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].price_date, expectedDate);
  }
});

test("finds today's page after a skipped page ID", async () => {
  const calls = [];
  const page = await findAdanaPageForDate("2026-07-25", {
    fetchPage: async (pageId) => {
      calls.push(pageId);
      return {
        pageId,
        priceDate: pageId === 2657 ? "2026-07-25" : "2026-07-24",
        rows: [{ product: "ELMA" }],
      };
    },
  });

  assert.equal(page.pageId, 2657);
  assert.deepEqual(calls, [2656, 2657]);
});

test("stops after the configured +5 search window", async () => {
  const calls = [];
  const page = await findAdanaPageForDate("2026-07-25", {
    fetchPage: async (pageId) => {
      calls.push(pageId);
      return { pageId, priceDate: "2026-07-24", rows: [] };
    },
  });

  assert.equal(page, null);
  assert.deepEqual(calls, [2656, 2657, 2658, 2659, 2660, 2661]);
});
