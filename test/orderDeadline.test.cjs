const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKET_TIMEOUT_MS, LIMIT_TIMEOUT_MS, normalizeOrderType, deadlineMsFor, shouldCancelStale } = require("../orderDeadline");

test("timeouts: market 60s, limit 15min", () => {
  assert.equal(MARKET_TIMEOUT_MS, 60000);
  assert.equal(LIMIT_TIMEOUT_MS, 900000);
});

test("normalizeOrderType: only clear limits are limit; everything else market (fail-safe)", () => {
  for (const t of ["limit", "LIMIT", "Lmt", "SL", "sl-l"]) assert.equal(normalizeOrderType(t), "limit", t);
  for (const t of ["market", "MKT", "", null, undefined, "weird", "market_order"]) assert.equal(normalizeOrderType(t), "market", String(t));
});

test("deadlineMsFor picks the right timeout", () => {
  assert.equal(deadlineMsFor("market"), 60000);
  assert.equal(deadlineMsFor("limit"), 900000);
  assert.equal(deadlineMsFor(undefined), 60000);   // default market
});

test("shouldCancelStale: market cancels at 60s, not before", () => {
  const placedAtMs = 1_000_000;
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs, nowMs: placedAtMs + 59_000 }), false);
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs, nowMs: placedAtMs + 60_000 }), true);
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs, nowMs: placedAtMs + 120_000 }), true);
});

test("shouldCancelStale: limit cancels at 15min, not before", () => {
  const placedAtMs = 1_000_000;
  assert.equal(shouldCancelStale({ orderType: "limit", placedAtMs, nowMs: placedAtMs + 14 * 60_000 }), false);
  assert.equal(shouldCancelStale({ orderType: "limit", placedAtMs, nowMs: placedAtMs + 15 * 60_000 }), true);
});

test("shouldCancelStale: unknown type uses the SHORTER (market) deadline", () => {
  const placedAtMs = 1_000_000;
  assert.equal(shouldCancelStale({ orderType: "???", placedAtMs, nowMs: placedAtMs + 60_000 }), true);
});

test("shouldCancelStale: no/invalid timestamp never auto-cancels", () => {
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs: null, nowMs: Date.now() }), false);
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs: 0, nowMs: Date.now() }), false);
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs: "nope", nowMs: Date.now() }), false);
});

test("shouldCancelStale: clock skew (now < placed) never cancels", () => {
  assert.equal(shouldCancelStale({ orderType: "market", placedAtMs: 2_000_000, nowMs: 1_000_000 }), false);
});
