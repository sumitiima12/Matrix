/* C03 slice 1 — durable WRITE-BEFORE-SEND order-attempt state machine (db layer only; NOT yet wired into the
   live order path). Proves the persistence primitive with faults injected at each boundary. The startup
   broker-backed reconciliation (slice 2) will build on these against the fake FYERS + restart harness.

   Flat-file store is used for the state-machine logic (deterministic, no DB needed). Cross-restart DURABILITY
   is additionally asserted against real Postgres when DATABASE_URL is set (CI provides it; ciPgRequired makes a
   skip fail CI). */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Capture the REAL Postgres URL up front, BEFORE the before-hook below deletes it for the flat-file tests. The PG
// cross-restart test's skip decision (and its own DB connection) must use this captured value — reading the live env
// there would see the deleted variable and silently skip the money-safety test (which the zero-skip CI gate rejects).
const REAL_DATABASE_URL = process.env.DATABASE_URL || null;

const faultHook = require("../faultHook");
const { freshRequire } = require("./harness/restart.cjs");

let dir, db;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-c03-"));
  delete process.env.DATABASE_URL;                              // flat-file path for the state-machine tests
  process.env.ORDER_ATTEMPTS_FILE = path.join(dir, "order_attempts.json");
  db = require("../db.js");
});
test.after(() => { faultHook.clear(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const base = (id) => ({ id, userId: "u1", broker: "fyers", idemKey: `k_${id}`, orderTag: `mxTAG_${id}`,
  fingerprint: `fp_${id}`, payload: { symbol: "SBIN", qty: 10 }, symbol: "SBIN", side: "BUY", qty: 10, product: "CNC", protection: { sl: 1, tp: 3 } });

test("C03: DB failure BEFORE submission ⇒ prepare throws ⇒ caller must not send", async () => {
  faultHook.arm("db.attempt.prepare", 1);
  await assert.rejects(() => db.prepareOrderAttempt(base("A1")), /injected fault: db.attempt.prepare/);
  // Nothing persisted — no durable identity means the caller never calls the broker.
  assert.equal(await db.getOrderAttempt("A1"), null);
});

test("C03: prepare commits a PREPARED attempt discoverable by id and orderTag", async () => {
  const row = await db.prepareOrderAttempt(base("A2"));
  assert.equal(row.status, "PREPARED");
  const got = await db.getOrderAttempt("A2");
  assert.equal(got.status, "PREPARED");
  assert.equal(got.orderTag, "mxTAG_A2");
  assert.equal(got.resolved, false);
});

test("C03: transition is a CAS — wrong fromStatus does not advance (no double-advance)", async () => {
  await db.prepareOrderAttempt(base("A3"));
  const ok = await db.transitionOrderAttempt("A3", "PREPARED", "SUBMITTING", { brokerOrderId: "FY1" });
  assert.equal(ok.status, "SUBMITTING");
  assert.equal(ok.brokerOrderId, "FY1");
  const nope = await db.transitionOrderAttempt("A3", "PREPARED", "SUBMITTING");  // already advanced
  assert.equal(nope, null, "CAS guard rejects a stale transition");
});

test("C03: finalize FILLED is terminal+resolved; UNKNOWN stays unresolved for recovery", async () => {
  await db.prepareOrderAttempt(base("A4"));
  await db.transitionOrderAttempt("A4", "PREPARED", "SUBMITTING");
  const filled = await db.finalizeOrderAttempt("A4", "FILLED", { brokerOrderId: "FY4", filledQty: 10, avgPrice: 100 });
  assert.equal(filled.status, "FILLED");
  assert.equal(filled.resolved, true);
  assert.equal(filled.filledQty, 10);

  await db.prepareOrderAttempt(base("A5"));
  const unk = await db.finalizeOrderAttempt("A5", "UNKNOWN", {});
  assert.equal(unk.status, "UNKNOWN");
  assert.equal(unk.resolved, false, "an UNKNOWN outcome must remain unresolved (needs broker reconciliation)");
});

test("C03: listUnresolvedOrderAttempts returns non-resolved only (the recovery work list)", async () => {
  const unresolved = await db.listUnresolvedOrderAttempts(500);
  const ids = unresolved.map((r) => r.id);
  assert.ok(ids.includes("A5"), "UNKNOWN attempt is in the recovery list");
  assert.ok(!ids.includes("A4"), "a FILLED (resolved) attempt is NOT in the recovery list");
});

test("C03: finalize is idempotent (safe to replay during recovery)", async () => {
  await db.prepareOrderAttempt(base("A6"));
  await db.finalizeOrderAttempt("A6", "FILLED", { filledQty: 10, avgPrice: 50 });
  const again = await db.finalizeOrderAttempt("A6", "FILLED", { filledQty: 10, avgPrice: 50 });
  assert.equal(again.status, "FILLED");
  assert.equal(again.resolved, true);
});

test("C03: a fault at db.attempt.finalize leaves the attempt UNRESOLVED (recovery will retry)", async () => {
  await db.prepareOrderAttempt(base("A7"));
  await db.transitionOrderAttempt("A7", "PREPARED", "SUBMITTING");
  faultHook.arm("db.attempt.finalize", 1);
  await assert.rejects(() => db.finalizeOrderAttempt("A7", "FILLED", { filledQty: 10 }), /injected fault: db.attempt.finalize/);
  const still = await db.getOrderAttempt("A7");
  assert.equal(still.resolved, false, "unfinalized attempt stays in the recovery list");
});

/* ── PostgreSQL cross-restart DURABILITY (the real point of C03): a PREPARED attempt survives a process
   restart and is rediscovered by its orderTag. Skips without DATABASE_URL; ciPgRequired makes that skip fail CI. */
test("C03/PG: a PREPARED attempt survives a simulated restart and is found by orderTag", { skip: REAL_DATABASE_URL ? false : "DATABASE_URL not set — restart-recovery tests need a real Postgres" }, async () => {
  delete process.env.ORDER_ATTEMPTS_FILE;
  process.env.DATABASE_URL = REAL_DATABASE_URL;   // restore the URL the before-hook cleared, so db.js talks to real PG
  let boot = freshRequire(["../../db.js"]);   // "first boot"
  await boot.db.initDb();
  const id = `PGATT_${Date.now()}`;
  await boot.db.prepareOrderAttempt({ id, userId: "u_pg", broker: "fyers", orderTag: `mxPG_${id}`, symbol: "SBIN", side: "BUY", qty: 3, product: "CNC" });
  // "restart": drop in-memory state + pg pool; re-require fresh. Postgres persists.
  boot = freshRequire(["../../db.js"]);
  await boot.db.initDb();
  const found = (await boot.db.listUnresolvedOrderAttempts(500)).find((r) => r.id === id);
  assert.ok(found, "startup recovery rediscovers the PREPARED attempt after restart");
  assert.equal(found.orderTag, `mxPG_${id}`);
  assert.equal(found.resolved, false);
  try { const c = boot.db; if (c._pool) await c._pool.query(`DELETE FROM order_attempts WHERE id=$1`, [id]); } catch { /* best-effort cleanup */ }
});
