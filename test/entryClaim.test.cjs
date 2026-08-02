/**
 * test/entryClaim.test.cjs — R16-P1-01 candle-idempotent, active/open-guarded entry claim (flat-file path),
 * plus R16-P2-01 atomic update + versioned transition. These are the invariants that keep unattended
 * auto-buy at most-once per signal and prevent post-pause orders.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let dir, db;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-claim-test-"));
  delete process.env.DATABASE_URL;
  process.env.REAL_STRATS_FILE = path.join(dir, "real_strategies.json");
  db = require("../db");
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const seed = async (over = {}) => {
  const s = { id: "s1", userId: "ph_1", status: "active", brokerSym: "BTCUSD", openPositionId: null, ...over };
  await db.saveRealStrategy(s);
  return s;
};

test("candle idempotency: two claims for the SAME candle → only the first wins", async () => {
  await seed();
  const first = await db.claimRealStrategyForEntry("s1", "candle-100", { pendingSince: Date.now(), pendingClientId: "c1" });
  assert.ok(first, "first claim should win");
  // second worker, same candle, but pendingSince now cleared (simulate fast completion)
  await db.updateRealStrategy("s1", { pendingSince: null, openPositionId: null });
  const second = await db.claimRealStrategyForEntry("s1", "candle-100", { pendingSince: Date.now(), pendingClientId: "c2" });
  assert.equal(second, null, "same candle must not be claimed twice");
});

test("a NEW candle can be claimed after the previous one completed", async () => {
  await seed({ lastEntryCandle: "candle-100", pendingSince: null, openPositionId: null });
  const next = await db.claimRealStrategyForEntry("s1", "candle-200", { pendingSince: Date.now(), pendingClientId: "c3" });
  assert.ok(next, "a fresh candle should be claimable");
});

test("paused / position-held strategies cannot be claimed (no post-pause order)", async () => {
  await seed({ status: "paused" });
  assert.equal(await db.claimRealStrategyForEntry("s1", "c-a", { pendingSince: Date.now() }), null);
  await seed({ status: "active", openPositionId: "pos-1" });
  assert.equal(await db.claimRealStrategyForEntry("s1", "c-b", { pendingSince: Date.now() }), null);
});

test("updateRealStrategy is an atomic merge that never un-pauses (COALESCE status)", async () => {
  await seed({ status: "paused" });
  // an engine completion write carrying no status must NOT resurrect the strategy to active
  const after = await db.updateRealStrategy("s1", { openPositionId: "pos-9", lastOrderStatus: "filled" });
  assert.equal(after.status, "paused");
  assert.equal(after.openPositionId, "pos-9");
});

test("transitionRealStrategy honours the expected version", async () => {
  const s = await seed();
  const v0 = (await db.getRealStrategiesForUser("ph_1")).find((x) => x.id === "s1").version || 0;
  const ok = await db.transitionRealStrategy("s1", { status: "cancelled" }, v0);
  assert.ok(ok, "matching version should apply");
  const stale = await db.transitionRealStrategy("s1", { status: "active" }, v0);
  assert.equal(stale, null, "stale version must be rejected");
});
