const cheerio = require("cheerio");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const BASE_PAGE_ID = 2576;
const BASE_PRICE_DATE = "2026-05-06";
const MAX_FORWARD_PAGE_SEARCH = 5;
const DETAIL_URL_BASE = "https://www.adana.bel.tr/tr/hal-detay";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function fetchHtmlWithCurl(url) {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-4",
        "-L",
        "-sS",
        "--compressed",
        "--connect-timeout",
        "20",
        "--max-time",
        "60",
        "--retry",
        "3",
        "--retry-delay",
        "3",
        "-A",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "-H",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H",
        "Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        url,
      ],
      {
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    return stdout;
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    throw new Error(
      `Adana curl request failed: ${err.message}${stderr ? ` | ${stderr}` : ""}`
    );
  }
}

function parsePrice(value) {
  if (!value) return null;

  let cleaned = value
    .trim()
    .replace("₺", "")
    .replace("TL", "")
    .replace(/\s+/g, "");

  // Turkish number formats: 42,5; 1.250,5; 1250.
  if (cleaned.includes(",")) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }

  const num = Number(cleaned);

  return Number.isNaN(num) ? null : num;
}

function normalizeUnit(unit) {
  if (!unit) return "";

  return unit
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(".", "");
}

function getIcon(productName) {
  const p = productName.toLocaleUpperCase("tr-TR");

  if (p.includes("LİMON")) return "🍋";
  if (p.includes("ŞEFTALİ")) return "🍑";
  if (p.includes("ELMA")) return "🍎";
  if (p.includes("MUZ")) return "🍌";
  if (p.includes("ÇİLEK")) return "🍓";
  if (p.includes("KARPUZ")) return "🍉";
  if (p.includes("PORTAKAL")) return "🍊";
  if (p.includes("DOMATES")) return "🍅";
  if (p.includes("BİBER")) return "🫑";
  if (p.includes("PATATES")) return "🥔";
  if (p.includes("SOĞAN")) return "🧅";

  return null;
}

function getTodayDateForTurkey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year").value;
  const month = parts.find((part) => part.type === "month").value;
  const day = parts.find((part) => part.type === "day").value;

  return `${year}-${month}-${day}`;
}

function isoDateToUtcTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return timestamp;
}

function calculateEstimatedPageId(targetDate) {
  const baseTimestamp = isoDateToUtcTimestamp(BASE_PRICE_DATE);
  const targetTimestamp = isoDateToUtcTimestamp(targetDate);

  if (targetTimestamp === null) {
    throw new Error(`Invalid Adana target date: ${targetDate}`);
  }

  const dayDifference = Math.round(
    (targetTimestamp - baseTimestamp) / ONE_DAY_MS
  );

  if (dayDifference < 0) {
    throw new Error(
      `Adana target date cannot be before ${BASE_PRICE_DATE}: ${targetDate}`
    );
  }

  return BASE_PAGE_ID + dayDifference;
}

function parsePageDateFromHtml(html) {
  const $ = cheerio.load(html || "");
  const heading = $("div.title-main h4").first().text().replace(/\s+/g, " ").trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+Tarihli Günlük Raiç Bedeli$/i.exec(
    heading
  );

  if (!match) return null;

  const isoDate = `${match[3]}-${match[2]}-${match[1]}`;
  return isoDateToUtcTimestamp(isoDate) === null ? null : isoDate;
}

function parseRowsFromHtml(html, priceDate) {
  const $ = cheerio.load(html || "");
  const rows = [];

  $("tr").each((_, tr) => {
    const cells = $(tr).find("td");

    // Adana columns: product, unit, minimum price, maximum price.
    if (cells.length !== 4) return;

    const productName = $(cells[0]).text().trim();
    const unit = normalizeUnit($(cells[1]).text().trim());
    const minPrice = parsePrice($(cells[2]).text().trim());
    const maxPrice = parsePrice($(cells[3]).text().trim());

    if (!productName || !unit) return;
    if (minPrice === null || maxPrice === null) return;

    rows.push({
      product: productName,
      scope: "market",
      market: "Adana Hali",
      city: "Adana",
      production_type: "Geleneksel",
      min_price: minPrice,
      max_price: maxPrice,
      avg_price: (minPrice + maxPrice) / 2,
      unit,
      icon: getIcon(productName),
      price_date: priceDate,
    });
  });

  return rows;
}

async function fetchAdanaPage(pageId, { fetchHtml = fetchHtmlWithCurl } = {}) {
  if (!Number.isInteger(pageId) || pageId < BASE_PAGE_ID) {
    throw new Error(`Invalid Adana page ID: ${pageId}`);
  }

  const html = await fetchHtml(`${DETAIL_URL_BASE}/${pageId}`);
  const priceDate = parsePageDateFromHtml(html);

  return {
    pageId,
    priceDate,
    rows: priceDate ? parseRowsFromHtml(html, priceDate) : [],
  };
}

async function findAdanaPageForDate(
  targetDate,
  {
    fetchPage = fetchAdanaPage,
    maxForwardSearch = MAX_FORWARD_PAGE_SEARCH,
  } = {}
) {
  const estimatedPageId = calculateEstimatedPageId(targetDate);

  for (let offset = 0; offset <= maxForwardSearch; offset += 1) {
    const pageId = estimatedPageId + offset;

    try {
      const page = await fetchPage(pageId);

      if (page.priceDate === targetDate) return page;
      if (page.priceDate && page.priceDate > targetDate) break;
    } catch (err) {
      console.warn(`Adana page ${pageId} skipped: ${err.message}`);
    }
  }

  return null;
}

async function fetchAdanaRows() {
  const today = getTodayDateForTurkey();

  try {
    const page = await findAdanaPageForDate(today);

    if (!page) {
      console.warn(
        `Adana prices skipped: no page dated ${today} within the +${MAX_FORWARD_PAGE_SEARCH} search window`
      );
      return [];
    }

    if (page.rows.length === 0) {
      console.warn(
        `Adana prices skipped: page ${page.pageId} is dated ${today} but contains no valid rows`
      );
      return [];
    }

    console.log(
      `✅ Adana rows fetched: ${page.rows.length} (page ${page.pageId}, ${page.priceDate})`
    );
    return page.rows;
  } catch (err) {
    console.warn(`Adana prices skipped: ${err.message}`);
    return [];
  }
}

module.exports = {
  BASE_PAGE_ID,
  BASE_PRICE_DATE,
  MAX_FORWARD_PAGE_SEARCH,
  calculateEstimatedPageId,
  fetchAdanaPage,
  fetchAdanaRows,
  findAdanaPageForDate,
  getTodayDateForTurkey,
  parsePageDateFromHtml,
  parseRowsFromHtml,
};
