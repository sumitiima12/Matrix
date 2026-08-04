/* §10/§13 — pre-entry guards. Pure unit tests: a stale signal is rejected, a fresh one passes, and the
   duplicate-symbol conflict policy blocks stacking real exposure on one symbol. No DB. */
const test = require("node:test");
const assert = require("node:assert");
const G = require("../signalGuards");

test("§13 timeframeMs: parses common timeframes; unknown → 15m", () => {
  assert.equal(G.timeframeMs("1m"), 60e3);
  assert.equal(G.timeframeMs("15m"), 15 * 60e3);
  assert.equal(G.timeframeMs("1h"), 3600e3);
  assert.equal(G.timeframeMs("4h"), 4 * 3600e3);
  assert.equal(G.timeframeMs("1d"), 24 * 3600e3);
  assert.equal(G.timeframeMs("1w"), 7 * 24 * 3600e3);
  assert.equal(G.timeframeMs("garbage"), 15 * 60e3);
});

test("§10 staleSignal: a fresh closed-candle signal passes; a long-delayed one is rejected", () => {
  const now = 1_700_000_000_000;
  // Just-closed 15m candle → not stale.
  assert.equal(G.staleSignal(now - 60e3, now, "15m"), false, "a 1-min-old 15m signal is fresh");
  // 15m signal from 2 hours ago → stale (grace is 3 bars = 45 min).
  assert.equal(G.staleSignal(now - 2 * 3600e3, now, "15m"), true, "a 2-hour-old 15m signal is stale");
  // 1m signal has a 10-min floor: 5 min old is fine, 30 min old is stale.
  assert.equal(G.staleSignal(now - 5 * 60e3, now, "1m"), false);
  assert.equal(G.staleSignal(now - 30 * 60e3, now, "1m"), true);
  // A daily signal tolerates a longer delay (3 days) but not a week.
  assert.equal(G.staleSignal(now - 2 * 24 * 3600e3, now, "1d"), false);
  assert.equal(G.staleSignal(now - 7 * 24 * 3600e3, now, "1d"), true);
  // Unknown/zero candle time → never blocks on staleness.
  assert.equal(G.staleSignal(0, now, "15m"), false);
  assert.equal(G.staleSignal(NaN, now, "15m"), false);
});

test("§10 duplicateOpenSymbol: blocks a second entry on an already-open (broker,symbol)", () => {
  const positions = [
    { status: "open", broker: "delta", brokerSym: "BTCUSD" },
    { status: "closing", broker: "fyers", brokerSym: "NSE:SBIN-EQ" },
    { status: "closed", broker: "delta", brokerSym: "ETHUSD" },   // closed ⇒ not a conflict
  ];
  // Same broker + symbol as an OPEN position → duplicate.
  assert.equal(G.duplicateOpenSymbol(positions, "delta", "BTCUSD"), true);
  assert.equal(G.duplicateOpenSymbol(positions, "delta", "BTC"), true, "symbol normalised (BTCUSD ~ BTC)");
  // A closing FYERS position still counts as held.
  assert.equal(G.duplicateOpenSymbol(positions, "fyers", "SBIN"), true);
  // Different broker, or a symbol only held as CLOSED, is NOT a conflict.
  assert.equal(G.duplicateOpenSymbol(positions, "fyers", "BTCUSD"), false, "different broker is fine");
  assert.equal(G.duplicateOpenSymbol(positions, "delta", "ETHUSD"), false, "a closed position is not a conflict");
  assert.equal(G.duplicateOpenSymbol([], "delta", "BTCUSD"), false);
});
