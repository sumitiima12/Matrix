/**
 * test/monitoring.test.cjs — MU-2 monitoring/on-call. Proves the health verdict classifies page vs warn vs
 * healthy correctly and the on-call de-dup + cooldown suppresses repeat pages.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateHealth, shouldPage, pageKey } = require("../monitoring");

const healthy = { schemaReady: true, dbOk: true, liveHalted: false, unresolvedAttempts: 0, unknownOrders: 0, lastEngineTickMs: 1000, nowMs: 2000, errorRate5m: 0 };

test("all-good snapshot → healthy, not page-worthy", () => {
  const v = evaluateHealth(healthy);
  assert.equal(v.status, "healthy");
  assert.equal(v.pageWorthy, false);
  assert.deepEqual(v.failing, []);
});

test("schema-not-ready and live-halt are page-worthy → critical", () => {
  assert.equal(evaluateHealth({ ...healthy, schemaReady: false }).status, "critical");
  assert.equal(evaluateHealth({ ...healthy, liveHalted: true }).pageWorthy, true);
  assert.equal(evaluateHealth({ ...healthy, dbOk: false }).status, "critical");
});

test("thresholds: unresolved attempts warn at 1, page at 5; unknown orders warn", () => {
  assert.equal(evaluateHealth({ ...healthy, unresolvedAttempts: 1 }).status, "degraded");
  assert.equal(evaluateHealth({ ...healthy, unresolvedAttempts: 5 }).status, "critical");
  assert.equal(evaluateHealth({ ...healthy, unknownOrders: 2 }).status, "degraded");
});

test("stale engine heartbeat pages; missing heartbeat warns", () => {
  assert.equal(evaluateHealth({ ...healthy, lastEngineTickMs: 0, nowMs: 10_000_000 }).status, "degraded"); // no heartbeat → warn
  assert.equal(evaluateHealth({ ...healthy, lastEngineTickMs: 1000, nowMs: 1000 + 6 * 60_000 }).status, "critical"); // 6 min stale → page
});

test("error-rate bands: ≥3% warn, ≥10% page", () => {
  assert.equal(evaluateHealth({ ...healthy, errorRate5m: 0.05 }).status, "degraded");
  assert.equal(evaluateHealth({ ...healthy, errorRate5m: 0.2 }).status, "critical");
});

test("on-call de-dup: same page suppressed inside cooldown, fires after", () => {
  const v = evaluateHealth({ ...healthy, liveHalted: true });
  const key = pageKey(v);
  const seen = {};
  const first = shouldPage(v, seen, { nowMs: 0, cooldownMs: 15 * 60_000 });
  assert.equal(first.page, true);
  seen[first.key] = 0;                                         // record we paged at t=0
  assert.equal(shouldPage(v, seen, { nowMs: 60_000 }).page, false);   // 1 min later → suppressed
  assert.equal(shouldPage(v, seen, { nowMs: 16 * 60_000 }).page, true); // after cooldown → pages again
  assert.equal(key, "live_halt");
});

test("healthy verdict is never page-worthy regardless of cooldown state", () => {
  assert.equal(shouldPage(evaluateHealth(healthy), {}, {}).page, false);
});
