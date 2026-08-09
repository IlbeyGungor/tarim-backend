const { query } = require('../db');

const ISTANBUL_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Istanbul')::date`;

function normalizeAnalyticsDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(90, Math.max(7, parsed));
}

async function recordUserActivity(userId, dbQuery = query) {
  const { rows } = await dbQuery(`
    WITH updated_user AS (
      UPDATE users
      SET last_active_at=NOW()
      WHERE id=$1 AND account_status='active'
      RETURNING last_active_at
    ), activity AS (
      INSERT INTO user_activity_daily (
        user_id,activity_date,first_active_at,last_active_at,ping_count
      )
      SELECT $1,${ISTANBUL_DATE_SQL},NOW(),NOW(),1
      FROM updated_user
      ON CONFLICT (user_id,activity_date) DO UPDATE
      SET last_active_at=EXCLUDED.last_active_at,
          ping_count=user_activity_daily.ping_count+1
      RETURNING activity_date
    )
    SELECT updated_user.last_active_at,activity.activity_date
    FROM updated_user CROSS JOIN activity
  `, [userId]);
  return rows[0] || null;
}

module.exports = {
  ISTANBUL_DATE_SQL,
  normalizeAnalyticsDays,
  recordUserActivity,
};
