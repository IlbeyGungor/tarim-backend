const axios = require("axios");
const cheerio = require("cheerio");

const URL = "https://www.adana.bel.tr/tr/hal-detay/2576";

function parsePrice(value) {
  if (!value) return null;

  const cleaned = value
    .trim()
    .replace("₺", "")
    .replace("TL", "")
    .replace(",", ".")
    .replace(/\s+/g, "");

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

function normalizeProduct(product) {
  if (!product) return "";

  let cleaned = product.trim().replace(/\s+/g, " ");

  // Örn: LİMON(MAYER) -> Mayer Limon
  const match = cleaned.match(/^(.+?)\((.+?)\)$/);

  if (match) {
    const mainProduct = match[1].trim();
    const variety = match[2].trim();

    return toTitleCase(`${variety} ${mainProduct}`);
  }

  return toTitleCase(cleaned);
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

async function fetchAdanaRows() {
  const response = await axios.get(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    timeout: 20000,
  });

  const $ = cheerio.load(response.data);

  const rows = [];

  $("tr").each((_, tr) => {
    const cells = $(tr).find("td");

    // Adana yapısı:
    // 0: ürün
    // 1: birim
    // 2: min fiyat
    // 3: max fiyat
    if (cells.length !== 4) return;

    const rawProduct = $(cells[0]).text().trim();
    const rawUnit = $(cells[1]).text().trim();
    const rawMinPrice = $(cells[2]).text().trim();
    const rawMaxPrice = $(cells[3]).text().trim();

    const productName = normalizeProduct(rawProduct);
    const unit = normalizeUnit(rawUnit);
    const minPrice = parsePrice(rawMinPrice);
    const maxPrice = parsePrice(rawMaxPrice);

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
      unit: unit,
      icon: getIcon(productName),
    });
  });

  return rows;
}


module.exports = {
  fetchAdanaRows
};