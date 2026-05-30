const cheerio = require("cheerio");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const URL = "https://www.adana.bel.tr/tr/hal-detay/2576";

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

  // Türkçe sayı formatı desteği:
  // 42,5      -> 42.5
  // 1.250,5   -> 1250.5
  // 1250      -> 1250
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

async function fetchAdanaRows() {
  const html = await fetchHtmlWithCurl(URL);
  const $ = cheerio.load(html);

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

    // Ürün ismine dokunmuyoruz. Sitede ne yazıyorsa o.
    const productName = rawProduct;

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

  console.log(`✅ Adana rows fetched: ${rows.length}`);

  return rows;
}

module.exports = {
  fetchAdanaRows,
};