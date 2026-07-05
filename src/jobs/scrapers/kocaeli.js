const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.kocaeli.bel.tr/hal-fiyatlari";
const MAX_LOOKBACK_DAYS = 6;

function getDateForTurkeyDaysAgo(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  const day = Number(parts.find((p) => p.type === "day").value);

  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - daysAgo);

  return date.toISOString().slice(0, 10);
}

function buildUrl(dateStr) {
  return `${BASE_URL}/d-${dateStr}-h-1.html`;
}

function parsePrice(value) {
  if (!value) return null;

  let cleaned = value
    .trim()
    .replace("₺", "")
    .replace("TL", "")
    .replace(/\s+/g, "");

  // TR format ihtimali: 1.250,50
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
  if (p.includes("ÜZÜM")) return "🍇";
  if (p.includes("KİRAZ")) return "🍒";
  if (p.includes("HAVUÇ")) return "🥕";
  if (p.includes("MISIR")) return "🌽";
  if (p.includes("SALATALIK")) return "🥒";
  if (p.includes("MARUL")) return "🥬";

  return null;
}

async function getHtml(url) {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    timeout: 20000,
  });

  return response.data;
}

function parseRowsFromPage($, priceDate) {
  const rows = [];

  $("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");

    if (cells.length < 5) return;

    // Header satırı:
    // Ürün Adı | Kategori | Birim | En az | En çok
    const firstCellText = $(cells[0]).text().replace(/\s+/g, " ").trim();

    if (!firstCellText || firstCellText.toLocaleLowerCase("tr-TR") === "ürün adı") {
      return;
    }

    const productName = firstCellText;
    const unit = normalizeUnit($(cells[2]).text());
    const minPrice = parsePrice($(cells[3]).text());
    const maxPrice = parsePrice($(cells[4]).text());

    if (!productName || !unit) return;
    if (minPrice === null || maxPrice === null) return;

    rows.push({
      product: productName,
      scope: "market",
      market: "Kocaeli Hali",
      city: "Kocaeli",
      production_type: "Geleneksel",
      min_price: minPrice,
      max_price: maxPrice,
      avg_price: (minPrice + maxPrice) / 2,
      unit: unit,
      icon: getIcon(productName),
      price_date: priceDate,
    });
  });

  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSleepMs(minSeconds = 2, maxSeconds = 5) {
  return Math.floor(
    (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000
  );
}

async function fetchKocaeliRowsForDate(dateStr) {
  const url = buildUrl(dateStr);

  console.log(`[Kocaeli] Denenen tarih: ${dateStr}`);
  console.log(`[Kocaeli] Scrape ediliyor: ${url}`);

  const html = await getHtml(url);
  const $ = cheerio.load(html);

  const rows = parseRowsFromPage($, dateStr);

  console.log(`[Kocaeli] Bulunan satır: ${rows.length}`);

  return rows;
}

async function fetchKocaeliRows() {
  for (let daysAgo = 0; daysAgo <= MAX_LOOKBACK_DAYS; daysAgo++) {
    const dateStr = getDateForTurkeyDaysAgo(daysAgo);

    try {
      const rows = await fetchKocaeliRowsForDate(dateStr);

      if (rows.length > 0) {
        console.log(
          `[Kocaeli] Veri bulundu. Seçilen fiyat tarihi: ${dateStr}, satır sayısı: ${rows.length}`
        );

        return rows;
      }

      console.log(`[Kocaeli] ${dateStr} için veri bulunamadı.`);
    } catch (err) {
      console.warn(`[Kocaeli] ${dateStr} scrape edilemedi: ${err.message}`);
    }

    if (daysAgo !== MAX_LOOKBACK_DAYS) {
      const waitMs = randomSleepMs(2, 5);
      console.log(`[Kocaeli] ${(waitMs / 1000).toFixed(1)} saniye bekleniyor...\n`);
      await sleep(waitMs);
    }
  }

  console.warn(`[Kocaeli] Son ${MAX_LOOKBACK_DAYS + 1} gün içinde veri bulunamadı.`);
  return [];
}

module.exports = {
  fetchKocaeliRows,
  fetchKocaeliRowsForDate,
};