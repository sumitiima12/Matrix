/* R27-P1-03 / C02 — pure broker-truth comparison used by the risk-lock Resume gate.
   Proves the unlock verification is fail-closed: a managed open position only counts as verified when the
   broker snapshot confirms AT LEAST the tracked quantity; a shortfall, a missing symbol, or a closed
   position at the broker fails the check (which keeps the lock on in the route). */
const test = require("node:test");
const assert = require("node:assert");
const { verifyManagedAgainstBroker } = require("../reconcile.js");

test("C02: a managed long fully held at the broker verifies", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10 }], [{ sym: "SBIN", qty: 10 }]);
  assert.equal(r.ok, true);
  assert.equal(r.verified, 1);
});

test("C02: a broker SHORTFALL fails closed (position reduced/closed at the broker)", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10 }], [{ sym: "SBIN", qty: 4 }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.shortfall, { sym: "SBIN", dir: "long", tracked: 10, broker: 4 });
});

test("C02: a position the broker doesn't hold at all fails closed", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "INFY", qty: 5 }], [{ sym: "SBIN", qty: 10 }]);
  assert.equal(r.ok, false);
  assert.equal(r.shortfall.broker, 0);
});

test("C02: symbol normalization matches NSE:/-EQ and crypto USD suffixes", () => {
  const eq = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 3 }], [{ sym: "NSE:SBIN-EQ", qty: 3 }]);
  assert.equal(eq.ok, true);
  const crypto = verifyManagedAgainstBroker([{ symbol: "BTCUSD", qty: 2 }], [{ sym: "BTC", qty: 2 }]);
  assert.equal(crypto.ok, true);
});

test("C02: a short position (tracked qty) is confirmed by the broker's absolute holding", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "ETHUSD", qty: -3 }], [{ sym: "ETH", qty: -3 }]);
  assert.equal(r.ok, true);
  assert.equal(r.verified, 1);
});

test("C02: multiple broker fills of the same symbol sum to cover one managed position", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10 }], [{ sym: "SBIN", qty: 6 }, { sym: "SBIN", qty: 4 }]);
  assert.equal(r.ok, true);
});

test("C02: an empty managed list is trivially ok (nothing to confirm)", () => {
  const r = verifyManagedAgainstBroker([], [{ sym: "SBIN", qty: 10 }]);
  assert.equal(r.ok, true);
  assert.equal(r.verified, 0);
});

test("C02-fix: broker quantity is CONSUMED — two tracked rows of 10 cannot both clear one broker lot of 10", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10 }, { symbol: "SBIN", qty: 10 }], [{ sym: "SBIN", qty: 10 }]);
  assert.equal(r.ok, false, "the second row must fail — the first consumed the only 10 shares");
  assert.equal(r.verified, 1);
  assert.equal(r.shortfall.broker, 0);
});

test("C02-fix: two tracked rows summing to the broker lot DO clear (10 + 10 vs broker 20)", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10 }, { symbol: "SBIN", qty: 10 }], [{ sym: "SBIN", qty: 20 }]);
  assert.equal(r.ok, true);
  assert.equal(r.verified, 2);
});

test("C02-fix: DIRECTION respected — a tracked LONG cannot clear against a broker SHORT", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10, short: false }], [{ sym: "SBIN", qty: -10 }]);
  assert.equal(r.ok, false, "broker holds a SHORT; our tracked LONG is not confirmed");
  assert.equal(r.shortfall.dir, "long");
  assert.equal(r.shortfall.broker, 0);
});

test("C02-fix: DIRECTION respected — a tracked SHORT cannot clear against a broker LONG", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 10, short: true }], [{ sym: "SBIN", qty: 10 }]);
  assert.equal(r.ok, false, "broker holds a LONG; our tracked SHORT is not confirmed");
  assert.equal(r.shortfall.dir, "short");
});

test("C02-fix: ORPHAN broker exposure is reported (broker holds a position Matrix doesn't track)", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 5 }], [{ sym: "SBIN", qty: 5 }, { sym: "INFY", qty: 10 }]);
  assert.equal(r.ok, true, "the tracked SBIN long is confirmed");
  assert.equal(r.orphans.length, 1, "the untracked INFY holding is flagged as orphan exposure");
  assert.deepEqual(r.orphans[0], { sym: "INFY", dir: "long", qty: 10 });
});

test("C02-fix: no orphans when the broker holds exactly the tracked positions", () => {
  const r = verifyManagedAgainstBroker([{ symbol: "SBIN", qty: 5 }], [{ sym: "SBIN", qty: 5 }]);
  assert.equal(r.orphans.length, 0);
});

test("C02-fix: a hedged book verifies per-direction (broker long 10 + short 5 covers managed long 10 + short 5)", () => {
  const r = verifyManagedAgainstBroker(
    [{ symbol: "SBIN", qty: 10, short: false }, { symbol: "SBIN", qty: 5, short: true }],
    [{ sym: "SBIN", qty: 10 }, { sym: "SBIN", qty: -5 }],
  );
  assert.equal(r.ok, true);
  assert.equal(r.verified, 2);
});
