const { getClient, query } = require('../db');
const { resolveProductIdentity } = require('../utils/productCatalog');

const SCORES = {
  search: 1,
  message_sent: 3,
  call_button_click: 5,
  listing_create: 6,
  offer_create: 8,
};

function scoreForEvent(eventType, activeSeconds = 0) {
  if (eventType === 'listing_view') {
    const seconds = Math.max(0, Math.min(120, Number(activeSeconds) || 0));
    return seconds < 3 ? 0 : 1 + seconds / 15;
  }
  return SCORES[eventType] || 0;
}

function listingIdForEvent(listing, explicitListingId = null) {
  return explicitListingId || listing?.listing_id || listing?.id || null;
}

async function recordProductInterestWithClient({
  client, userId, eventId, eventType, listing = null,
  productName, category, listingType = 'sell', listingId = null,
  catalogProductKey = null, activeSeconds = 0, sessionId = null,
}) {
  if (!userId || !eventId) return false;
  const score = scoreForEvent(eventType, activeSeconds);
  if (score <= 0) return false;

  const preference = await client.query(
    'SELECT personalization_enabled FROM users WHERE id=$1 AND account_status=\'active\' FOR SHARE',
    [userId]
  );
  if (!preference.rows[0]?.personalization_enabled) return false;

  const sourceName = listing?.crop_name || productName;
  if (!sourceName) return false;
  const sourceCategory = listing?.category || category || 'other';
  const sourceType = listing?.listing_type || listingType || 'sell';
  // Some offer/chat queries expose the offer as `id` and the related listing
  // as `listing_id`. An explicit listingId must therefore take precedence.
  const sourceListingId = listingIdForEvent(listing, listingId);
  const identity = resolveProductIdentity(
    sourceName,
    sourceCategory,
    listing?.catalog_product_key || catalogProductKey
  );

  const inserted = await client.query(`
    INSERT INTO product_interest_events
      (event_id,user_id,event_type,product_key,product_family_key,product_name,
       category,listing_type,listing_id,active_seconds,score,session_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [eventId, userId, eventType, identity.product_key,
    identity.product_family_key, identity.display_name, sourceCategory,
    sourceType, sourceListingId, Math.max(0, Math.min(120, Number(activeSeconds) || 0)),
    score, sessionId]);
  if (!inserted.rows.length) return false;

  await client.query(`
    INSERT INTO user_product_interests
      (user_id,product_family_key,listing_type,product_name,category,score,event_count,last_event_at)
    VALUES ($1,$2,$3,$4,$5,$6,1,NOW())
    ON CONFLICT (user_id,product_family_key,listing_type) DO UPDATE SET
      score=(user_product_interests.score * POWER(0.5,
        EXTRACT(EPOCH FROM (NOW()-user_product_interests.last_event_at))/2592000.0)) + EXCLUDED.score,
      product_name=EXCLUDED.product_name,
      category=EXCLUDED.category,
      event_count=user_product_interests.event_count+1,
      last_event_at=NOW()
  `, [userId, identity.product_family_key, sourceType, identity.display_name,
    sourceCategory, score]);
  return true;
}

async function runInTransaction(work, clientFactory = getClient) {
  const client = await clientFactory();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function recordProductInterest(options) {
  if (options.client) {
    return recordProductInterestWithClient(options);
  }
  return runInTransaction((client) =>
    recordProductInterestWithClient({ ...options, client })
  );
}

async function pruneOldInterestEvents() {
  await query(`DELETE FROM product_interest_events WHERE created_at < NOW() - INTERVAL '180 days'`);
}

function scheduleProductInterestPruning() {
  if (process.env.DISABLE_PRODUCT_INTEREST_SCHEDULER === 'true') return;
  const timer = setInterval(() => {
    pruneOldInterestEvents().catch((err) =>
      console.error('[analytics] product interest pruning failed:', err)
    );
  }, 24 * 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = {
  pruneOldInterestEvents,
  recordProductInterest,
  recordProductInterestWithClient,
  runInTransaction,
  scheduleProductInterestPruning,
  listingIdForEvent,
  scoreForEvent,
};
