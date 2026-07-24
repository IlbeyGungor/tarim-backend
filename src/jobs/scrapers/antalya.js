const axios = require("axios");
const puppeteer = require("puppeteer");

const PDF_API_URL =
  "https://gezipanel.antalya.bel.tr/Methods.aspx/GetGunlukHalFiyatPdf";
const PDF_BASE_URL = "https://gezipanel.antalya.bel.tr";
const PDF_VIEWER_ORIGIN =
  "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";
const MAX_LOOKBACK_DAYS = 7;
const PDF_LOAD_TIMEOUT_MS = 60 * 1000;
const PDF_TEXT_RETRY_COUNT = 3;

function parsePrice(value) {
  if (!value) return null;

  let cleaned = value
    .trim()
    .replace("₺", "")
    .replace("TL", "")
    .replace(/\s+/g, "");

  // Sadece sayı, nokta ve virgül kalsın
  cleaned = cleaned.replace(/[^\d.,-]/g, "");

  // TR format: 1.250,50 -> 1250.50
  if (cleaned.includes(",")) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }
  // Virgül yoksa ama 1.250 / 12.500 gibi binlik nokta varsa
  else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, "");
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

      return (
        word.charAt(0).toLocaleUpperCase("tr-TR") +
        word.slice(1)
      );
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDateForTurkeyDaysAgo(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = Number(
    parts.find((part) => part.type === "year").value
  );
  const month = Number(
    parts.find((part) => part.type === "month").value
  );
  const day = Number(
    parts.find((part) => part.type === "day").value
  );

  const date = new Date(Date.UTC(year, month - 1, day));

  date.setUTCDate(date.getUTCDate() - daysAgo);

  return date.toISOString().slice(0, 10);
}

function normalizePdfDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (!match) return null;

  const [, day, month, year] = match;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(
    2,
    "0"
  )}`;
}

function normalizePdfResponseData(value) {
  if (value && typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function fetchPdfInfoForDate(dateStr) {
  const response = await axios.post(
    PDF_API_URL,
    {
      tarih: dateStr,
    },
    {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "User-Agent": "Mozilla/5.0",
      },
      timeout: 30000,
    }
  );

  const data = normalizePdfResponseData(response.data?.d);
  const pdfPath = String(data?.PdfUrl || "").trim();
  const priceDate = normalizePdfDate(data?.PdfDate);

  if (!pdfPath || !priceDate) {
    return null;
  }

  const pdfUrl = new URL(pdfPath, PDF_BASE_URL).toString();

  if (
    !new URL(pdfUrl).pathname
      .toLocaleLowerCase("tr-TR")
      .endsWith(".pdf")
  ) {
    return null;
  }

  return {
    pdfUrl,
    priceDate,
  };
}

async function findLatestPdfInfo() {
  for (
    let daysAgo = 0;
    daysAgo <= MAX_LOOKBACK_DAYS;
    daysAgo++
  ) {
    const dateStr = getDateForTurkeyDaysAgo(daysAgo);

    try {
      const pdfInfo = await fetchPdfInfoForDate(dateStr);

      if (pdfInfo) {
        console.log(
          `[Antalya] PDF bulundu. İstenen tarih: ${dateStr}, fiyat tarihi: ${pdfInfo.priceDate}`
        );

        return pdfInfo;
      }

      console.log(
        `[Antalya] ${dateStr} için PDF bulunamadı.`
      );
    } catch (err) {
      console.warn(
        `[Antalya] ${dateStr} PDF sorgusu başarısız: ${err.message}`
      );
    }
  }

  return null;
}

async function waitForPdfViewerFrame(page) {
  const deadline = Date.now() + PDF_LOAD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const frame = page
      .frames()
      .find((candidate) =>
        candidate.url().startsWith(PDF_VIEWER_ORIGIN)
      );

    if (frame) {
      return frame;
    }

    await sleep(250);
  }

  throw new Error(
    "Chromium PDF görüntüleyicisi yüklenmedi"
  );
}

async function copyPdfText(page, viewerFrame) {
  await page.bringToFront();
  await page.mouse.click(600, 450);

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");

  await sleep(250);

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyC");
  await page.keyboard.up("Control");

  await sleep(500);

  return viewerFrame.evaluate(() =>
    navigator.clipboard.readText()
  );
}

async function extractPdfText(browser, pdfUrl) {
  const context = browser.defaultBrowserContext();

  await context.overridePermissions(PDF_VIEWER_ORIGIN, [
    "clipboard-read",
    "clipboard-write",
  ]);

  await context.overridePermissions(
    new URL(pdfUrl).origin,
    ["clipboard-read", "clipboard-write"]
  );

  const page = await browser.newPage();

  try {
    await page.setViewport({
      width: 1200,
      height: 900,
    });

    const response = await page.goto(pdfUrl, {
      waitUntil: "networkidle2",
      timeout: PDF_LOAD_TIMEOUT_MS,
    });

    if (!response || !response.ok()) {
      throw new Error(
        `PDF indirilemedi: HTTP ${
          response?.status() ?? "bilinmiyor"
        }`
      );
    }

    const viewerFrame =
      await waitForPdfViewerFrame(page);

    await sleep(3000);

    for (
      let attempt = 1;
      attempt <= PDF_TEXT_RETRY_COUNT;
      attempt++
    ) {
      try {
        await viewerFrame.evaluate(() =>
          navigator.clipboard.writeText("")
        );

        const text = (
          await copyPdfText(page, viewerFrame)
        ).trim();

        if (text) {
          return text;
        }
      } catch (err) {
        console.warn(
          `[Antalya] PDF metni kopyalama denemesi ${attempt} başarısız: ${err.message}`
        );
      }

      await sleep(1000);
    }

    throw new Error(
      "PDF metni Chromium görüntüleyicisinden alınamadı"
    );
  } finally {
    await page.close();
  }
}

function parseRowsFromPdfText(text, priceDate) {
  const rows = [];

  const priceToken =
    "-?\\d+(?:\\.\\d{3})*(?:,\\d+)?";

  const rowPattern = new RegExp(
    `^(?:\\d+\\s+)?(.+?)\\s+(Pk\\/125\\s*Gr|Kg|Bağ|Adet)\\s+(${priceToken})\\s+(${priceToken})(?:\\s+|$)`,
    "iu"
  );

  for (const line of text.split(/\r?\n/)) {
    let remaining = line.trim();

    while (remaining) {
      const match = remaining.match(rowPattern);

      if (!match) {
        break;
      }

      const productName = normalizeProduct(match[1]);
      const unit = normalizeUnit(match[2]);
      const minPrice = parsePrice(match[3]);
      const maxPrice = parsePrice(match[4]);

      if (
        productName &&
        unit &&
        minPrice !== null &&
        maxPrice !== null
      ) {
        rows.push({
          product: productName,
          scope: "market",
          market: "Antalya Hali",
          city: "Antalya",
          production_type: "Geleneksel",
          min_price: minPrice,
          max_price: maxPrice,
          avg_price: (minPrice + maxPrice) / 2,
          unit,
          icon: getIcon(productName),
          price_date: priceDate,
        });
      }

      remaining = remaining
        .slice(match[0].length)
        .trim();
    }
  }

  return rows;
}

async function fetchAntalyaRows() {
  let browser;

  try {
    const pdfInfo = await findLatestPdfInfo();

    if (!pdfInfo) {
      console.warn(
        `[Antalya] Son ${
          MAX_LOOKBACK_DAYS + 1
        } gün içinde PDF bulunamadı.`
      );

      return [];
    }

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--enable-features=SharedClipboard",
      ],
    });

    const pdfText = await extractPdfText(
      browser,
      pdfInfo.pdfUrl
    );

    const rows = parseRowsFromPdfText(
      pdfText,
      pdfInfo.priceDate
    );

    if (rows.length === 0) {
      throw new Error(
        "PDF içinde geçerli fiyat satırı bulunamadı"
      );
    }

    console.log(
      `[Antalya] Fiyat tarihi: ${pdfInfo.priceDate}, bulunan satır: ${rows.length}`
    );

    return rows;
  } catch (err) {
    console.warn(
      `[Antalya] PDF scrape edilemedi: ${err.message}`
    );

    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  fetchAntalyaRows,
};
