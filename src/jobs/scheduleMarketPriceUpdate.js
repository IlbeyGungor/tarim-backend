const cron = require('node-cron');
const path = require('node:path');
const { spawn } = require('node:child_process');

let isRunning = false;

function runMarketPriceUpdate() {
  if (isRunning) {
    console.log('⏳ Market price update already running, skipping this run.');
    return;
  }

  isRunning = true;

  const scriptPath = path.join(__dirname, 'updateMarketPrices.js');

  console.log(`\n🚜 Market price update started at ${new Date().toISOString()}`);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '../..'),
    env: process.env,
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    isRunning = false;

    if (code === 0) {
      console.log(`✅ Market price update completed at ${new Date().toISOString()}\n`);
    } else {
      console.error(`❌ Market price update failed with code ${code} at ${new Date().toISOString()}\n`);
    }
  });

  child.on('error', (err) => {
    isRunning = false;
    console.error('❌ Failed to start market price update:', err);
  });
}

function scheduleMarketPriceUpdate() {
  if (process.env.ENABLE_MARKET_PRICE_SCHEDULER === 'false') {
    console.log('⏸️ Market price scheduler disabled.');
    return;
  }

  const timezone = process.env.MARKET_PRICE_JOB_TZ || 'Europe/Istanbul';

  // Her gün 11:00
  cron.schedule(
    '0 11 * * *',
    () => {
      runMarketPriceUpdate();
    },
    {
      timezone,
    }
  );

  console.log(`🕚 Market price scheduler active: every day at 11:00 (${timezone})`);
}

module.exports = {
  scheduleMarketPriceUpdate,
};
