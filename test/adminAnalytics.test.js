const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_ANALYTICS_SUMMARY_SQL,
  D30_COHORT_NEWEST_DAY,
  D30_COHORT_OLDEST_DAY,
  D30_WINDOW_END_DAY,
  D30_WINDOW_START_DAY,
  fetchAdminAnalyticsSummary,
} = require('../src/services/adminAnalytics');

test('D30 cohort and activity windows match the observed cohort definition', () => {
  assert.equal(D30_COHORT_OLDEST_DAY, 64);
  assert.equal(D30_COHORT_NEWEST_DAY, 35);
  assert.equal(D30_WINDOW_START_DAY, 28);
  assert.equal(D30_WINDOW_END_DAY, 34);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /u\.is_admin=false/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /signup_date \+ 28/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /signup_date \+ 34/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /NULLIF\(cohort_users,0\)/);
});

test('weekly metrics use Istanbul calendar boundary and listing type split', () => {
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /AT TIME ZONE 'Europe\/Istanbul'/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /listing_type='sell'/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /listing_type='buy'/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /COUNT\(DISTINCT contact_key\)/);
  assert.match(ADMIN_ANALYTICS_SUMMARY_SQL, /is_guest=true AND channel='call'/);
});

test('summary query preserves null retention returned by PostgreSQL', async () => {
  const expected = {
    d30_cohort_users: 0,
    d30_retained_users: 0,
    d30_retention_rate: null,
  };
  const result = await fetchAdminAnalyticsSummary(async (sql) => {
    assert.equal(sql, ADMIN_ANALYTICS_SUMMARY_SQL);
    return { rows: [expected] };
  });
  assert.deepEqual(result, expected);
});
