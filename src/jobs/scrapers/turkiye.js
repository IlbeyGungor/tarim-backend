const fs = require("fs");
const path = require("path");
const os = require("os");
const puppeteer = require("puppeteer");
const XLSX = require("xlsx");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const PAGE_URL = "https://www.hal.gov.tr/Sayfalar/FiyatDetaylari.aspx";

const GET_BUTTON_SELECTOR =
  "#ctl00_ctl37_g_7e86b8d6_3aea_47cf_b1c1_939799a091e0_btnGet";

const ALL_PAGES_RADIO_SELECTOR =
  "#ctl00_ctl37_g_7e86b8d6_3aea_47cf_b1c1_939799a091e0_rblExcelOptions_1";

const EXCEL_BUTTON_SELECTOR =
  "#ctl00_ctl37_g_7e86b8d6_3aea_47cf_b1c1_939799a091e0_btnExcel";

const DOWNLOAD_DIR = path.join(os.tmpdir(), "hal_gov_downloads");


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSleepMs(minSeconds = 0.8, maxSeconds = 2.2) {
  return Math.floor(
    (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000
  );
}

async function humanSleep(minSeconds = 0.8, maxSeconds = 2.2) {
  await sleep(randomSleepMs(minSeconds, maxSeconds));
}

function parsePrice(value) {
  if (value === null || value === undefined) return null;

  let cleaned = String(value)
    .trim()
    .replace("₺", "")
    .replace("TL", "")
    .replace(/\s+/g, "");

  if (!cleaned) return null;

  // Türkçe sayı formatı: 1.250,50
  if (cleaned.includes(",")) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }

  const num = Number(cleaned);
  return Number.isNaN(num) ? null : num;
}

function normalizeUnit(unit) {
  if (!unit) return "";

  return String(unit)
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(".", "");
}

function toTitleCase(text) {
  return String(text)
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

  const cleaned = String(product).trim().replace(/\s+/g, " ");

  const match = cleaned.match(/^(.+?)\((.+?)\)$/);

  if (match) {
    const mainProduct = match[1].trim();
    const variety = match[2].trim();

    return toTitleCase(`${variety} ${mainProduct}`);
  }

  return toTitleCase(cleaned);
}

function buildProductName(productRaw, varietyRaw) {
  const product = normalizeProduct(productRaw);
  const variety = normalizeProduct(varietyRaw);

  if (!product) return "";
  if (!variety) return product;

  const productLower = product.toLocaleLowerCase("tr-TR");
  const varietyLower = variety.toLocaleLowerCase("tr-TR");

  if (productLower === varietyLower) return product;
  if (varietyLower === "diğer" || varietyLower === "diger") return product;

  return `${variety} ${product}`;
}

function normalizeProductionType(value) {
  if (!value) return "Geleneksel";

  const text = String(value).toLocaleLowerCase("tr-TR");

  if (text.includes("iyi")) return "İyi Tarım";
  if (text.includes("organik")) return "Organik Tarım";
  if (text.includes("geleneksel")) return "Geleneksel";

  return String(value).trim();
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

function cleanDownloadDir() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
    if (
      file.endsWith(".xls") ||
      file.endsWith(".xlsx") ||
      file.endsWith(".crdownload")
    ) {
      fs.unlinkSync(path.join(DOWNLOAD_DIR, file));
    }
  }
}

async function waitForDownloadedExcel(timeoutMs = 60000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(DOWNLOAD_DIR);

    const downloading = files.some((file) => file.endsWith(".crdownload"));

    const excelFile = files.find(
      (file) => file.endsWith(".xls") || file.endsWith(".xlsx")
    );

    if (excelFile && !downloading) {
      return path.join(DOWNLOAD_DIR, excelFile);
    }

    await sleep(1000);
  }

  throw new Error("Excel dosyası indirilemedi veya zaman aşımına uğradı.");
}

function decodeHtmlEntities(text) {
  if (!text) return "";

  const $ = cheerio.load(`<div>${text}</div>`, {
    decodeEntities: true,
  });

  return $("div").text();
}

function scoreDecodedText(text) {
  const trCount = (text.match(/<tr/gi) || []).length;
  const tdCount = (text.match(/<td/gi) || []).length;

  const knownWords = [
    "Bülten",
    "Ürün",
    "Fiyat",
    "Birim",
    "ACUR",
    "ANANAS",
  ];

  const knownWordScore = knownWords.reduce((score, word) => {
    return score + (text.includes(word) ? 50 : 0);
  }, 0);

  const replacementCharCount = (text.match(/�/g) || []).length;

  // Çok yüksek unicode karakterler genelde bozulmuş encoding göstergesi
  const weirdCharCount = Array.from(text).filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 0xffff;
  }).length;

  return trCount * 20 + tdCount * 5 + knownWordScore - replacementCharCount * 10 - weirdCharCount * 3;
}

function decodeBestText(buffer) {
  const candidates = [
    {
      name: "utf8",
      text: buffer.toString("utf8"),
    },
    {
      name: "windows-1254",
      text: iconv.decode(buffer, "windows-1254"),
    },
    {
      name: "iso-8859-9",
      text: iconv.decode(buffer, "iso-8859-9"),
    },
    {
      name: "latin1",
      text: iconv.decode(buffer, "latin1"),
    },
    {
      name: "utf16le",
      text: iconv.decode(buffer, "utf16le"),
    },
  ];

  candidates.sort((a, b) => scoreDecodedText(b.text) - scoreDecodedText(a.text));

  console.log("Seçilen decode:", candidates[0].name);

  return candidates[0].text;
}

function cleanCell(value) {
  if (value === null || value === undefined) return "";

  let text = String(value);

  text = text.replace(/<br\s*\/?>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\u00a0/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

function extractRowsFromDownloadedXlsText(text) {
  const rows = [];

  // Önce HTML <tr><td> yapısını yakalamayı dene
  const htmlTrMatches = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  if (htmlTrMatches.length > 0) {
    for (const trHtml of htmlTrMatches) {
      const cells = [];

      const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

      let match;
      while ((match = tdRegex.exec(trHtml)) !== null) {
        cells.push(cleanCell(match[1]));
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    console.log(`HTML içinden bulunan tablo satırı: ${rows.length}`);
    return rows;
  }

  // Eğer HTML gibi parse edilemezse, tab-separated text gibi oku
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const cells = line.split("\t").map(cleanCell);

    if (cells.some((cell) => cell !== "")) {
      rows.push(cells);
    }
  }

  console.log(`Text/TSV içinden bulunan tablo satırı: ${rows.length}`);
  return rows;
}

function parseExcelFileToRows(filePath) {
  const buffer = fs.readFileSync(filePath);

  const text = decodeBestText(buffer);
  const rawRows = extractRowsFromDownloadedXlsText(text);


  const rows = [];

  for (const cells of rawRows) {
    if (!Array.isArray(cells)) continue;

    const cleanCells = cells.map(cleanCell);

    if (cleanCells.length < 6) continue;

    const joined = cleanCells.join(" ").toLocaleLowerCase("tr-TR");

    if (
      joined.includes("bülten tarihi") ||
      joined.includes("bilgi amaçlı") ||
      joined.includes("ürün adı") ||
      joined.includes("urun adi") ||
      joined.includes("ürün cinsi") ||
      joined.includes("urun cinsi")
    ) {
      continue;
    }

    /*
      Gerçek veri yapısı:
      0 Ürün Adı
      1 Ürün Cinsi
      2 Ürün Türü
      3 Ortalama Fiyat   ← evet, başlıkta Minumum gibi kaymış ama gerçek avg_price
      4 İşlem Hacmi      ← ihtiyacımız yok
      5 Birim Adı
    */

    const productRaw = cleanCells[0];
    const varietyRaw = cleanCells[1];
    const productionTypeRaw = cleanCells[2];
    const avgRaw = cleanCells[3];
    const unitRaw = cleanCells[5];

    const productName = buildProductName(productRaw, varietyRaw);
    const productionType = normalizeProductionType(productionTypeRaw);
    const unit = normalizeUnit(unitRaw);
    const avgPrice = parsePrice(avgRaw);

    if (!productName || !unit) continue;
    if (avgPrice === null) continue;

    rows.push({
      product: productName,
      scope: "national",
      market: "Türkiye",
      city: "Türkiye",
      production_type: productionType,
      min_price: avgPrice,
      max_price: avgPrice,
      avg_price: avgPrice,
      unit: unit,
      icon: getIcon(productName),
    });
  }

  console.log(`Türkiye içinden bulunan temiz satır sayısı: ${rows.length}`);

  return rows;
}

async function fetchTurkeyRows() {
  cleanDownloadDir();

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

    const client = await page.createCDPSession();

    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DOWNLOAD_DIR,
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    );

    console.log("Türkiye genel fiyatları çekiliyor. Sayfadaki en güncel tarih kullanılacak.");

    await page.goto(PAGE_URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await humanSleep();

    // 1) Fiyat Bul
    await page.waitForSelector(GET_BUTTON_SELECTOR, {
      timeout: 30000,
    });

    await Promise.all([
      page.click(GET_BUTTON_SELECTOR),
      page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 15000,
      }).catch(() => null),
    ]);

    await humanSleep(1.5, 3);

    // 2) Tüm Sayfalar
    await page.waitForSelector(ALL_PAGES_RADIO_SELECTOR, {
      timeout: 30000,
    });

    await page.click(ALL_PAGES_RADIO_SELECTOR);

    await humanSleep();

    // 3) Excel'e Çıkar
    await page.waitForSelector(EXCEL_BUTTON_SELECTOR, {
      timeout: 30000,
    });

    console.log("Excel'e Çıkar butonuna basılıyor...");

    await page.click(EXCEL_BUTTON_SELECTOR);

    const downloadedFilePath = await waitForDownloadedExcel();

    console.log("İndirilen dosya:", downloadedFilePath);

    const rows = parseExcelFileToRows(downloadedFilePath);

    console.log(`Türkiye satır sayısı: ${rows.length}`);

    // İş bittikten sonra indirilen dosyaları temizle
    cleanDownloadDir();

    return rows;
  } finally {
    await browser.close();
  }
}

module.exports = {
  fetchTurkeyRows,
};


// Tek başına test için:
// node turkiye.js
if (require.main === module) {
  fetchTurkeyRows()
    .then((rows) => {
      console.log(rows);
      console.log("Toplam:", rows.length);
    })
    .catch((error) => {
      console.error("Türkiye scraper hatası:", error.message);
    });
}