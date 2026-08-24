const { query } = require('../db');
const { ISTANBUL_DATE_SQL } = require('./userActivity');

const D30_COHORT_OLDEST_DAY = 64;
const D30_COHORT_NEWEST_DAY = 35;
const D30_WINDOW_START_DAY = 28;
const D30_WINDOW_END_DAY = 34;

const ADMIN_ANALYTICS_SUMMARY_SQL = `
  WITH cohort_users AS (
    SELECT u.id,(u.created_at AT TIME ZONE 'Europe/Istanbul')::date AS signup_date
    FROM users u
    WHERE u.is_admin=false
      AND (u.created_at AT TIME ZONE 'Europe/Istanbul')::date
        BETWEEN ${ISTANBUL_DATE_SQL} - ${D30_COHORT_OLDEST_DAY}
            AND ${ISTANBUL_DATE_SQL} - ${D30_COHORT_NEWEST_DAY}
  ), retention_summary AS (
    SELECT
      COUNT(*)::int AS cohort_users,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM user_activity_daily activity
        WHERE activity.user_id=cohort_users.id
          AND activity.activity_date
            BETWEEN cohort_users.signup_date + ${D30_WINDOW_START_DAY}
                AND cohort_users.signup_date + ${D30_WINDOW_END_DAY}
      ))::int AS retained_users
    FROM cohort_users
  )
  SELECT
    (SELECT COUNT(*)::int FROM users) AS total_users,
    (SELECT COUNT(*)::int FROM users WHERE account_status='active') AS active_accounts,
    (SELECT COUNT(DISTINCT user_id)::int FROM user_activity_daily
      WHERE activity_date >= ${ISTANBUL_DATE_SQL} - 6) AS active_users_7d,
    (SELECT COUNT(DISTINCT user_id)::int FROM user_activity_daily
      WHERE activity_date >= ${ISTANBUL_DATE_SQL} - 29) AS active_users_30d,
    (SELECT COUNT(*)::int FROM users
      WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
    (SELECT COUNT(*)::int FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days') AS new_users_30d,
    (SELECT COUNT(*)::int FROM listings) AS total_listings,
    (SELECT COUNT(*)::int FROM listings WHERE status='active') AS active_listings,
    (SELECT COUNT(*)::int FROM listings
      WHERE listing_type='sell'
        AND created_at >= ((${ISTANBUL_DATE_SQL} - 6)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AS new_sell_listings_7d,
    (SELECT COUNT(*)::int FROM listings
      WHERE listing_type='buy'
        AND created_at >= ((${ISTANBUL_DATE_SQL} - 6)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AS new_buy_listings_7d,
    (SELECT COUNT(*)::int FROM offers) AS total_offers,
    (SELECT COUNT(*)::int FROM offers WHERE status='accepted') AS accepted_offers,
    COALESCE((SELECT ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT seller_id),0),2)
      FROM listings),0) AS listings_per_listing_owner,
    COALESCE((SELECT ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT buyer_id),0),2)
      FROM offers),0) AS offers_per_offer_user,
    (SELECT cohort_users FROM retention_summary) AS d30_cohort_users,
    (SELECT retained_users FROM retention_summary) AS d30_retained_users,
    (SELECT ROUND(retained_users::numeric * 100 / NULLIF(cohort_users,0),1)
      FROM retention_summary) AS d30_retention_rate,
    (SELECT COUNT(DISTINCT contact_key)::int FROM contact_events
      WHERE is_guest=false AND contact_key IS NOT NULL
        AND created_at >= ((${ISTANBUL_DATE_SQL} - 6)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AS unique_contacts_7d,
    (SELECT COUNT(DISTINCT contact_key)::int FROM contact_events
      WHERE is_guest=false AND channel='call' AND contact_key IS NOT NULL
        AND created_at >= ((${ISTANBUL_DATE_SQL} - 6)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AS call_contacts_7d,
    (SELECT COUNT(DISTINCT contact_key)::int FROM contact_events
      WHERE is_guest=false AND channel='message' AND contact_key IS NOT NULL
        AND created_at >= ((${ISTANBUL_DATE_SQL} - 6)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AS message_contacts_7d,
    (SELECT COUNT(*)::int FROM contact_events
      WHERE is_guest=true AND channel='call'
        AND created_at >= ((${ISTANBUL_DATE_SQL} - 6)::timestamp AT TIME ZONE 'Europe/Istanbul'))
      AS guest_call_clicks_7d
`;

async function fetchAdminAnalyticsSummary(dbQuery = query) {
  const { rows } = await dbQuery(ADMIN_ANALYTICS_SUMMARY_SQL);
  return rows[0] || {};
}

module.exports = {
  ADMIN_ANALYTICS_SUMMARY_SQL,
  D30_COHORT_NEWEST_DAY,
  D30_COHORT_OLDEST_DAY,
  D30_WINDOW_END_DAY,
  D30_WINDOW_START_DAY,
  fetchAdminAnalyticsSummary,
};
