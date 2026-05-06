const puppeteer = require("puppeteer");

const URL = "https://www.antalya.bel.tr/tr/halden-gunluk-fiyatlar";

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
    .replace(".", "")
    .replace(/\s+/g, " ");
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
  if (p.includes("ANANAS")) return "🍍";
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

async function fetchAntalyaRows() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    );

    await page.goto(URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Tablo satırlarının oluşmasını bekle
    await page.waitForSelector("tr", {
      timeout: 30000,
    });

    // JS render tamamlasın diye küçük ekstra bekleme
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const rawRows = await page.evaluate(() => {
      const rows = [];

      document.querySelectorAll("tr").forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
          td.innerText.trim()
        );

        rows.push(cells);
      });

      return rows;
    });

    const data = [];

    for (const cells of rawRows) {
      // Antalya yapısı:
      // 0: resim/boş alan
      // 1: ürün
      // 2: min fiyat
      // 3: max fiyat
      // 4: birim
      if (cells.length < 5) continue;

      const productName = normalizeProduct(cells[1]);
      const minPrice = parsePrice(cells[2]);
      const maxPrice = parsePrice(cells[3]);
      const unit = normalizeUnit(cells[4]);

      if (!productName || !unit) continue;
      if (productName.includes("{{") || productName.includes("}}")) continue;
      if (minPrice === null || maxPrice === null) continue;

      data.push({
        product: productName,
        scope: "market",
        market: "Antalya Hali",
        city: "Antalya",
        production_type: "Geleneksel",
        min_price: minPrice,
        max_price: maxPrice,
        avg_price: (minPrice + maxPrice) / 2,
        unit: unit,
        icon: getIcon(productName),
      });
    }

    return data;
  } finally {
    await browser.close();
  }
}

module.exports = {
  fetchAntalyaRows
};