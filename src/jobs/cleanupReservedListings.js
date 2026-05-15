const { query, pool } = require('../db');

async function cleanupExpiredReservedListings() {
  const { rowCount } = await query(`
    DELETE FROM listings
    WHERE status = 'reserved'
      AND reserved_until IS NOT NULL
      AND reserved_until <= NOW()
  `);

  if (rowCount > 0) {
    console.log(`Expired reserved listings deleted: ${rowCount}`);
  }

  return rowCount;
}

function scheduleReservedListingCleanup() {
  cleanupExpiredReservedListings().catch((error) => {
    console.error('Reserved listing cleanup failed:', error);
  });

  const timer = setInterval(() => {
    cleanupExpiredReservedListings().catch((error) => {
      console.error('Reserved listing cleanup failed:', error);
    });
  }, 60 * 60 * 1000);

  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

if (require.main === module) {
  cleanupExpiredReservedListings()
    .then((count) => {
      console.log(`Cleanup complete. Deleted listings: ${count}`);
    })
    .catch((error) => {
      console.error('Cleanup failed:', error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  cleanupExpiredReservedListings,
  scheduleReservedListingCleanup,
};
