const axios = require("axios");
const cheerio = require("cheerio");

const URL = "https://www.bursa.bel.tr/hal_fiyatlari?sayfa=hal_fiyatlari&tarih=";

function parseSinglePrice(value) {
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

function parsePriceRange(priceText) {
  if (!priceText) {
    return { minPrice: null, maxPrice: null };
  }

  const cleanText = priceText
    .replace("₺", "")
    .replace("TL", "")
    .replace(/\s+/g, " ")
    .trim();

  // Örnek: "120,00 - 130,00"
  const matches = cleanText.match(/\d+(?:\.\d{3})*(?:,\d+)?|\d+(?:\.\d+)?/g);

  if (!matches || matches.length === 0) {
    return { minPrice: null, maxPrice: null };
  }

  if (matches.length === 1) {
    const price = parseSinglePrice(matches[0]);
    return { minPrice: price, maxPrice: price };
  }

  return {
    minPrice: parseSinglePrice(matches[0]),
    maxPrice: parseSinglePrice(matches[1]),
  };
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

  const cleaned = product.trim().replace(/\s+/g, " ");

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
  if (p.includes("MANDALİNA")) return "🍊";
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

async function fetchBursaRows() {
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

    // Bursa yapısı:
    // 0: ürün
    // 1: birim
    // 2: min - max fiyat
    if (cells.length < 3) return;

    const rawProduct = $(cells[0]).text().trim();
    const rawUnit = $(cells[1]).text().trim();
    const rawPriceText = $(cells[2]).text().trim();

    const productName = normalizeProduct(rawProduct);
    const unit = normalizeUnit(rawUnit);

    const { minPrice, maxPrice } = parsePriceRange(rawPriceText);

    if (!productName || !unit) return;
    if (minPrice === null || maxPrice === null) return;

    rows.push({
      product: productName,
      scope: "market",
      market: "Bursa Hali",
      city: "Bursa",
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
  fetchBursaRows
};