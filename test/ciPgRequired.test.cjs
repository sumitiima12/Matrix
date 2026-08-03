/* Makes PostgreSQL skips FAIL CI (reviewer H06 requirement).
 *
 * The PG integration + (future) C03 restart-recovery suites `skip` themselves when DATABASE_URL is absent, so
 * they stay green locally without a database. But in CI that would let real safety coverage silently vanish.
 * GitHub Actions (and most CI) set CI=true; this test then REQUIRES DATABASE_URL to be present, so a CI run
 * without an ephemeral Postgres fails loudly instead of passing on skipped safety tests.
 *
 * Locally (CI unset) it is a no-op.
 */
const test = require("node:test");
const assert = require("node:assert");

const inCI = String(process.env.CI || "").toLowerCase() === "true" || process.env.CI === "1" || !!process.env.GITHUB_ACTIONS;

test("CI must run the PostgreSQL safety suites (DATABASE_URL present) — skips are not allowed in CI", { skip: inCI ? false : "not in CI — PG suites may skip locally" }, () => {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL is not set in CI: the PostgreSQL integration and restart-recovery safety tests would SKIP. " +
    "CI must provision an ephemeral Postgres and export DATABASE_URL so those tests actually run.",
  );
});
