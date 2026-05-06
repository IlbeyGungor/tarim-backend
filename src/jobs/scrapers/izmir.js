const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://eislem.izmir.bel.tr/tr/HalFiyatlari";

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

function buildUrl(pageNumber, dateStr) {
  return `${BASE_URL}?sayfa=${pageNumber}&date2=${dateStr}&tip=0`;
}

function parsePrice(value) {
  if (!value) return null;

  let cleaned = value
    .trim()
    .replace("₺", "")
    .replace("TL", "")
    .replace(/\s+/g, "");

  // TR format: 1.250,50
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

function toTitleCase(text) {
  return text
    .toLocaleLowerCase("tr-TR")
    .split(" ")
    .map((word) => {
      if (!word) return word;
      return word.charAt(0).toLocaleUpperCase("tr-TR") + word.slice(1);
    })
    .join(" ");
}

function normalizeProduct(product) {
  if (!product) return "";

  let cleaned = product.trim().replace(/\s+/g, " ");

  const match = cleaned.match(/^(.+?)\((.+?)\)$/);

  if (match) {
    const mainProduct = match[1].trim();
    const variety = match[2].trim();

    return toTitleCase(`${variety} ${mainProduct}`);
  }

  return toTitleCase(cleaned);
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

function extractTotalPages($) {
  const totalRecord = $("div.totalRecord");

  if (!totalRecord.length) {
    return 1;
  }

  const firstStrongText = totalRecord.find("strong").first().text().trim();
  const totalPages = Number(firstStrongText);

  if (!Number.isNaN(totalPages) && totalPages > 0) {
    return totalPages;
  }

  const text = totalRecord.text().replace(/\s+/g, " ").trim();
  const match = text.match(/(\d+)\s+sayfada/i);

  if (match) {
    return Number(match[1]);
  }

  return 1;
}

function parseRowsFromPage($, url) {
  const rows = [];

  $("tr").each((_, tr) => {
    const cells = $(tr).find("td");

    if (cells.length < 5) return;

    let productName;
    let unit;
    let minPrice;
    let maxPrice;

    // İzmir genelde 6 kolon:
    // 0: kategori/tip
    // 1: ürün
    // 2: birim
    // 3: min fiyat
    // 4: max fiyat
    // 5: ortalama fiyat
    if (cells.length >= 6) {
      productName = normalizeProduct($(cells[1]).text());
      unit = normalizeUnit($(cells[2]).text());
      minPrice = parsePrice($(cells[3]).text());
      maxPrice = parsePrice($(cells[4]).text());
    } else {
      // Yedek yapı
      productName = normalizeProduct($(cells[0]).text());
      unit = normalizeUnit($(cells[1]).text());
      minPrice = parsePrice($(cells[2]).text());
      maxPrice = parsePrice($(cells[3]).text());
    }

    if (!productName || !unit) return;
    if (minPrice === null || maxPrice === null) return;

    rows.push({
      product: productName,
      scope: "market",
      market: "İzmir Hali",
      city: "İzmir",
      production_type: "Geleneksel",
      min_price: minPrice,
      max_price: maxPrice,
      avg_price: (minPrice + maxPrice) / 2,
      unit: unit,
      icon: getIcon(productName),
    });
  });

  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSleepMs(minSeconds = 3, maxSeconds = 8) {
  return Math.floor((Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000);
}

async function fetchIzmirRows() {
  const today = getTodayDateForTurkey();

  const firstUrl = buildUrl(1, today);
  const firstHtml = await getHtml(firstUrl);
  const $first = cheerio.load(firstHtml);

  const totalPages = extractTotalPages($first);

  console.log(`Bugünün tarihi: ${today}`);
  console.log(`Toplam sayfa sayısı: ${totalPages}`);

  const allRows = [];

  for (let page = 1; page <= totalPages; page++) {
    const url = buildUrl(page, today);

    console.log(`[${page}/${totalPages}] Scrape ediliyor: ${url}`);

    const html = page === 1 ? firstHtml : await getHtml(url);
    const $ = cheerio.load(html);

    const pageRows = parseRowsFromPage($, url);
    allRows.push(...pageRows);

    console.log(`Bulunan satır: ${pageRows.length}`);

    if (page !== totalPages) {
      const waitMs = randomSleepMs(3, 8);
      console.log(`${(waitMs / 1000).toFixed(1)} saniye bekleniyor...\n`);
      await sleep(waitMs);
    }
  }

  return allRows;
}


module.exports = {
  fetchIzmirRows
};