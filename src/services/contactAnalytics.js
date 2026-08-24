const { query } = require('../db');

function contactKey(firstUserId, secondUserId, listingId) {
  if (!firstUserId || !secondUserId || !listingId) return null;
  const users = [String(firstUserId), String(secondUserId)].sort();
  return `${listingId}:${users[0]}:${users[1]}`;
}

async function recordContactEvent({
  eventId,
  channel,
  actorUserId = null,
  recipientUserId,
  listingId,
  offerId = null,
  isGuest = false,
  dbQuery = query,
}) {
  const key = isGuest
    ? null
    : contactKey(actorUserId, recipientUserId, listingId);
  const { rows } = await dbQuery(`
    INSERT INTO contact_events (
      event_id,channel,actor_user_id,recipient_user_id,listing_id,offer_id,
      contact_key,is_guest
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  `, [
    eventId,
    channel,
    actorUserId,
    recipientUserId,
    listingId,
    offerId,
    key,
    isGuest,
  ]);
  return rows.length > 0;
}

async function resolveCallTarget({
  listingId,
  offerId = null,
  actorUserId = null,
  dbQuery = query,
}) {
  if (offerId) {
    if (!actorUserId) return null;
    const { rows } = await dbQuery(`
      SELECT o.id AS offer_id,o.listing_id,o.buyer_id,l.seller_id
      FROM offers o
      JOIN listings l ON l.id=o.listing_id
      WHERE o.id=$1 AND o.listing_id=$2 AND o.status='accepted'
        AND ($3::uuid=o.buyer_id OR $3::uuid=l.seller_id)
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id=$3 AND ub.blocked_id=CASE WHEN o.buyer_id=$3 THEN l.seller_id ELSE o.buyer_id END)
             OR (ub.blocked_id=$3 AND ub.blocker_id=CASE WHEN o.buyer_id=$3 THEN l.seller_id ELSE o.buyer_id END)
        )
      LIMIT 1
    `, [offerId, listingId, actorUserId]);
    const offer = rows[0];
    if (!offer) return null;
    return {
      listingId: offer.listing_id,
      offerId: offer.offer_id,
      recipientUserId: offer.buyer_id === actorUserId
        ? offer.seller_id
        : offer.buyer_id,
    };
  }

  const params = [listingId];
  let actorGuard = '';
  if (actorUserId) {
    params.push(actorUserId);
    actorGuard = `
      AND l.seller_id<>$2
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks ub
        WHERE (ub.blocker_id=$2 AND ub.blocked_id=l.seller_id)
           OR (ub.blocked_id=$2 AND ub.blocker_id=l.seller_id)
      )`;
  }
  const { rows } = await dbQuery(`
    SELECT l.id AS listing_id,l.seller_id
    FROM listings l
    JOIN users seller ON seller.id=l.seller_id
    WHERE l.id=$1 AND seller.account_status='active'
      AND seller.phone_verified=true
      ${actorGuard}
    LIMIT 1
  `, params);
  if (!rows.length) return null;
  return {
    listingId: rows[0].listing_id,
    offerId: null,
    recipientUserId: rows[0].seller_id,
  };
}

async function pruneOldContactEvents(dbQuery = query) {
  await dbQuery(`
    DELETE FROM contact_events
    WHERE created_at < NOW() - INTERVAL '180 days'
  `);
}

module.exports = {
  contactKey,
  pruneOldContactEvents,
  recordContactEvent,
  resolveCallTarget,
};
