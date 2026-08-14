const { getClient, query } = require('../db');
const notify = require('../utils/notify');

const JOB_BATCH_SIZE = 20;
const OUTBOX_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

async function queueListingMatches(client, listing) {
  if (!listing?.id || !listing.product_family_key) return false;
  const result = await client.query(`
    INSERT INTO listing_match_jobs (listing_id)
    VALUES ($1)
    ON CONFLICT (listing_id) DO NOTHING
    RETURNING listing_id
  `, [listing.id]);
  return result.rowCount > 0;
}

async function claimListingMatchJobs({
  listingId = null,
  limit = JOB_BATCH_SIZE,
  queryFn = query,
} = {}) {
  const params = [];
  let listingFilter = '';
  if (listingId) {
    params.push(listingId);
    listingFilter = `AND j.listing_id=$${params.length}`;
  }
  params.push(limit);
  const { rows } = await queryFn(`
    WITH exhausted AS (
      UPDATE listing_match_jobs
      SET status='permanent_failed',claimed_at=NULL,
          last_error=COALESCE(last_error,'Worker üçüncü denemede kesildi.')
      WHERE status='processing' AND attempts>=${MAX_ATTEMPTS}
        AND claimed_at < NOW()-INTERVAL '10 minutes'
      RETURNING listing_id
    ), candidates AS (
      SELECT j.listing_id
      FROM listing_match_jobs j
      WHERE j.attempts < ${MAX_ATTEMPTS}
        AND (
          (j.status IN ('pending','failed') AND j.next_attempt_at<=NOW())
          OR (j.status='processing' AND j.claimed_at < NOW()-INTERVAL '10 minutes')
        )
        ${listingFilter}
      ORDER BY j.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT $${params.length}
    )
    UPDATE listing_match_jobs j
    SET status='processing',attempts=j.attempts+1,claimed_at=NOW(),last_error=NULL
    FROM candidates c
    WHERE j.listing_id=c.listing_id
    RETURNING j.*
  `, params);
  return rows;
}

async function expandListingMatchJob(job, { getClientFn = getClient, queryFn = query } = {}) {
  const client = await getClientFn();
  try {
    await client.query('BEGIN');
    const { rows: listingRows } = await client.query(`
      SELECT id,seller_id,listing_type,product_family_key
      FROM listings
      WHERE id=$1 AND status='active'
      FOR SHARE
    `, [job.listing_id]);
    const listing = listingRows[0];
    if (listing) {
      const oppositeType = listing.listing_type === 'buy' ? 'sell' : 'buy';
      await client.query(`
        WITH raw_candidates AS (
          SELECT DISTINCT ON (l.seller_id)
            l.seller_id AS recipient_id,
            l.id AS matched_listing_id,
            false AS favorite_match
          FROM listings l
          JOIN users u ON u.id=l.seller_id
          WHERE l.status='active'
            AND l.listing_type=$1
            AND l.product_family_key=$2
            AND l.seller_id<>$3
            AND u.account_status='active'
            AND u.match_notifications_enabled=true
          ORDER BY l.seller_id,l.created_at DESC
          UNION ALL
          SELECT fp.user_id AS recipient_id,
                 NULL::uuid AS matched_listing_id,
                 true AS favorite_match
          FROM user_favorite_products fp
          JOIN users u ON u.id=fp.user_id
          WHERE fp.product_family_key=$2
            AND fp.user_id<>$3
            AND u.account_status='active'
            AND u.favorite_product_notifications_enabled=true
        ), candidates AS (
          SELECT rc.recipient_id,
                 (ARRAY_AGG(rc.matched_listing_id)
                   FILTER (WHERE rc.matched_listing_id IS NOT NULL))[1]
                   AS matched_listing_id,
                 BOOL_OR(rc.favorite_match) AS favorite_match
          FROM raw_candidates rc
          WHERE NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE (ub.blocker_id=rc.recipient_id AND ub.blocked_id=$3)
               OR (ub.blocker_id=$3 AND ub.blocked_id=rc.recipient_id)
          )
          GROUP BY rc.recipient_id
        ), admitted AS (
          INSERT INTO listing_match_daily_counts
            (recipient_id,notification_date,notification_count)
          SELECT recipient_id,
                 (NOW() AT TIME ZONE 'Europe/Istanbul')::date,
                 1
          FROM candidates
          ON CONFLICT (recipient_id,notification_date) DO UPDATE
          SET notification_count=listing_match_daily_counts.notification_count+1,
              updated_at=NOW()
          WHERE listing_match_daily_counts.notification_count < 5
          RETURNING recipient_id
        )
        INSERT INTO listing_match_outbox
          (new_listing_id,matched_listing_id,recipient_id,match_reason)
        SELECT $4,c.matched_listing_id,c.recipient_id,
               CASE WHEN c.favorite_match THEN 'favorite_product'
                    ELSE 'opposite_listing' END
        FROM candidates c
        JOIN admitted a USING (recipient_id)
        ON CONFLICT (new_listing_id,recipient_id) DO NOTHING
      `, [oppositeType, listing.product_family_key, listing.seller_id, listing.id]);
    }
    await client.query(`
      UPDATE listing_match_jobs
      SET status='done',processed_at=NOW(),claimed_at=NULL,last_error=NULL
      WHERE listing_id=$1
    `, [job.listing_id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const terminal = Number(job.attempts) >= MAX_ATTEMPTS;
    await queryFn(`
      UPDATE listing_match_jobs
      SET status=$2,claimed_at=NULL,last_error=$3,
          next_attempt_at=NOW()+(INTERVAL '5 minutes' * LEAST(attempts,3))
      WHERE listing_id=$1
    `, [job.listing_id, terminal ? 'permanent_failed' : 'failed', error.message]);
    throw error;
  } finally {
    client.release();
  }
}

async function processListingMatchJobs(options = {}) {
  const jobs = await claimListingMatchJobs(options);
  for (const job of jobs) {
    try {
      await expandListingMatchJob(job);
    } catch (error) {
      console.error('[notification] listing match expansion failed:', error);
    }
  }
  return jobs.length;
}

async function claimPendingNotifications({
  listingId = null,
  limit = OUTBOX_BATCH_SIZE,
  queryFn = query,
} = {}) {
  const params = [];
  let listingFilter = '';
  if (listingId) {
    params.push(listingId);
    listingFilter = `AND o.new_listing_id=$${params.length}`;
  }
  params.push(limit);
  const { rows } = await queryFn(`
    WITH exhausted AS (
      UPDATE listing_match_outbox
      SET status='permanent_failed',claimed_at=NULL,
          last_error=COALESCE(last_error,'Worker üçüncü denemede kesildi.')
      WHERE status='processing' AND attempts>=${MAX_ATTEMPTS}
        AND claimed_at < NOW()-INTERVAL '10 minutes'
      RETURNING id
    ), candidates AS (
      SELECT o.id
      FROM listing_match_outbox o
      WHERE o.attempts < ${MAX_ATTEMPTS}
        AND (
          (o.status IN ('pending','failed') AND o.next_attempt_at<=NOW())
          OR (o.status='processing' AND o.claimed_at < NOW()-INTERVAL '10 minutes')
        )
        ${listingFilter}
      ORDER BY o.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT $${params.length}
    ), claimed AS (
      UPDATE listing_match_outbox o
      SET status='processing',attempts=o.attempts+1,claimed_at=NOW(),last_error=NULL
      FROM candidates c
      WHERE o.id=c.id
      RETURNING o.*
    )
    SELECT c.*,l.crop_name,l.listing_type,l.product_family_key,
           CASE
             WHEN l.status<>'active' THEN false
             WHEN u.account_status<>'active' THEN false
             WHEN EXISTS (
               SELECT 1 FROM user_blocks ub
               WHERE (ub.blocker_id=c.recipient_id AND ub.blocked_id=l.seller_id)
                  OR (ub.blocker_id=l.seller_id AND ub.blocked_id=c.recipient_id)
             ) THEN false
             WHEN c.match_reason='favorite_product' THEN
               u.favorite_product_notifications_enabled AND EXISTS (
                 SELECT 1 FROM user_favorite_products fp
                 WHERE fp.user_id=c.recipient_id
                   AND fp.product_family_key=l.product_family_key
               )
             ELSE
               u.match_notifications_enabled AND EXISTS (
                 SELECT 1 FROM listings matched
                 WHERE matched.id=c.matched_listing_id
                   AND matched.status='active'
               )
           END AS still_eligible
    FROM claimed c
    JOIN listings l ON l.id=c.new_listing_id
    JOIN users u ON u.id=c.recipient_id
  `, params);
  return rows;
}

async function dispatchPendingListingMatches(options = {}) {
  const rows = await claimPendingNotifications(options);
  for (const item of rows) {
    if (!item.still_eligible) {
      await query(`
        UPDATE listing_match_outbox
        SET status='permanent_failed',claimed_at=NULL,
            last_error='Bildirim tercihi veya eşleşme artık geçerli değil.'
        WHERE id=$1
      `, [item.id]);
      continue;
    }
    let result;
    try {
      result = await notify.listingMatch({
        recipientId: item.recipient_id,
        cropName: item.crop_name,
        newListingType: item.listing_type,
        listingId: item.new_listing_id,
        matchReason: item.match_reason,
      });
    } catch (error) {
      result = { sent: false, retryable: true, reason: error.message };
    }

    if (result?.sent) {
      await query(`
        UPDATE listing_match_outbox
        SET status='sent',sent_at=NOW(),claimed_at=NULL,last_error=NULL
        WHERE id=$1
      `, [item.id]);
      continue;
    }

    const terminal = result?.retryable === false || Number(item.attempts) >= MAX_ATTEMPTS;
    await query(`
      UPDATE listing_match_outbox
      SET status=$2,claimed_at=NULL,last_error=$3,
          next_attempt_at=NOW()+(INTERVAL '5 minutes' * LEAST(attempts,3))
      WHERE id=$1
    `, [item.id, terminal ? 'permanent_failed' : 'failed', result?.reason || 'Push gönderilemedi.']);
  }
  return rows.length;
}

async function cleanupListingMatchRecords(queryFn = query) {
  await queryFn(`
    DELETE FROM listing_match_outbox
    WHERE status IN ('sent','permanent_failed')
      AND COALESCE(sent_at,created_at) < NOW()-INTERVAL '7 days'
  `);
  await queryFn(`
    DELETE FROM listing_match_jobs
    WHERE status IN ('done','permanent_failed')
      AND COALESCE(processed_at,created_at) < NOW()-INTERVAL '7 days'
  `);
  await queryFn(`
    DELETE FROM listing_match_daily_counts
    WHERE notification_date < (NOW() AT TIME ZONE 'Europe/Istanbul')::date-7
  `);
}

async function runListingMatchWorkers(options = {}) {
  await processListingMatchJobs(options);
  await dispatchPendingListingMatches(options);
}

function scheduleListingMatchRetries() {
  if (process.env.DISABLE_LISTING_MATCH_SCHEDULER === 'true') return;
  const workerTimer = setInterval(() => {
    runListingMatchWorkers().catch((error) =>
      console.error('[notification] listing match worker failed:', error)
    );
  }, 60 * 1000);
  workerTimer.unref?.();

  const cleanupTimer = setInterval(() => {
    cleanupListingMatchRecords().catch((error) =>
      console.error('[notification] listing match cleanup failed:', error)
    );
  }, 24 * 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

module.exports = {
  claimListingMatchJobs,
  claimPendingNotifications,
  cleanupListingMatchRecords,
  dispatchPendingListingMatches,
  expandListingMatchJob,
  processListingMatchJobs,
  queueListingMatches,
  runListingMatchWorkers,
  scheduleListingMatchRetries,
};
