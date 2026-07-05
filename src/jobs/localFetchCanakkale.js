const { fetchCanakkaleRows } = require("./scrapers/canakkale");

async function run() {
  // Scraper logları JSON çıktısını bozmasın diye console.log'u stderr'e yönlendiriyoruz.
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);

  const rows = await fetchCanakkaleRows();

  console.log = originalLog;

  process.stdout.write(JSON.stringify(rows));
}

run().catch((err) => {
  console.error("[Local Çanakkale] Fetch failed:", err);
  process.exitCode = 1;
});