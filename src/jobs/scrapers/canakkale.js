const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.canakkale.bel.tr/tr/sayfa/1481-hal-fiyat-listesi";

function parsePrice(value) {
  if (!value) return null;

  let cleaned = value
    .trim()
    .replace("₺", "")
    .replace(/TL/gi, "")
    .replace(/\s+/g, "");

  if (!cleaned || cleaned === "---") return null;

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

function cleanText(value) {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPriceDate($) {
  const html = $.html();
  const text = $.root().text();

  const match =
    html.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/) ||
    text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);

  if (!match) {
    throw new Error("Fiyat tarihi bulunamadı.");
  }

  const [, rawDay, rawMonth, year] = match;

  const day = rawDay.padStart(2, "0");
  const month = rawMonth.padStart(2, "0");

  return `${year}-${month}-${day}`;
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
  let currentSection = null;

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((_, td) => cleanText($(td).text()))
      .get();

    const nonEmptyCells = cells.filter(Boolean);
    if (nonEmptyCells.length === 0) return;

    const rowText = nonEmptyCells.join(" ");

    if (nonEmptyCells.length === 1 && nonEmptyCells[0] === "SEBZE") {
      currentSection = "sebze";
      return;
    }

    if (nonEmptyCells.length === 1 && nonEmptyCells[0] === "MEYVE") {
      currentSection = "meyve";
      return;
    }

    // Daha güvenli tercih: balık bölümünü hiç almıyoruz.
    if (rowText.includes("ÇANAKKALE BALIK HALİ FİYAT LİSTESİ")) {
      currentSection = null;
      return;
    }

    if (
      rowText.includes("TOPTANCI HALİ") ||
      rowText.includes("MALZEMENİN ADI") ||
      rowText.includes("ASGARİ SATIŞ FİYATI") ||
      rowText.includes("AZAMİ SATIŞ FİYATI") ||
      /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(nonEmptyCells[0])
    ) {
      return;
    }

    if (currentSection !== "sebze" && currentSection !== "meyve") {
      return;
    }

    const productName = cleanText(cells[0]);
    const unit = normalizeUnit(cells[1]);
    const minPrice = parsePrice(cells[2]);
    const maxPrice = parsePrice(cells[3]);

    if (!productName || !unit) return;
    if (minPrice === null || maxPrice === null) return;

    rows.push({
      product: productName,
      scope: "market",
      market: "Çanakkale Hali",
      city: "Çanakkale",
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

async function fetchCanakkaleRows() {
  try {
    const html = await getHtml(BASE_URL);
    const $ = cheerio.load(html);

    const priceDate = extractPriceDate($);
    const rows = parseRowsFromPage($, priceDate);

    console.log(`[Çanakkale] Fiyat tarihi: ${priceDate}`);
    console.log(`[Çanakkale] Bulunan satır: ${rows.length}`);

    return rows;
  } catch (err) {
    console.warn(`[Çanakkale] Scrape edilemedi: ${err.message}`);
    return [];
  }
}

module.exports = {
  fetchCanakkaleRows,
};