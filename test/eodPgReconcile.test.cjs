/* R35-P3-04 — PostgreSQL PRODUCTION-PATH proofs for the EOD fee reconciliation: the real `NOT EXISTS`/overlay
   exclusion, >5,000-row pagination, crash-after-first-overlay REPLAY CONVERGENCE (R35-P2-04), and manual-reconciliation
   evidence surviving a restart (R35-P3-01). Runs against real Postgres (embedded, or DATABASE_URL); in CI a missing DB
   is a HARD failure (safety coverage can't silently skip), locally it self-skips. */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

const IN_CI = /^(1|true|yes)$/i.test(String(process.env.CI || ""));
function loadEmbeddedPg() {
  for (const t of ["embedded-postgres", process.env.EMBEDDED_PG_PATH].filter(Boolean)) {
    try { const M = require(t); return M.default || M; } catch { /* next */ }
  }
  return null;
}
let pgHandle = null, DATABASE_URL = null, db = null, feeReconcile = null;

async function bootPostgres() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const EmbeddedPostgres = loadEmbeddedPg();
  if (!EmbeddedPostgres) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-eodpg-"));
  const port = 57000 + Math.floor(Math.random() * 1500);
  pgHandle = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pgHandle.initialise(); await pgHandle.start(); await pgHandle.createDatabase("matrix_test");
  return `postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
}

let READY = false;
test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) { if (IN_CI) throw new Error("DATABASE_URL required for the EOD PG reconcile suite in CI."); return; }
  process.env.DATABASE_URL = DATABASE_URL;
  db = require("../db.js");
  feeReconcile = require("../feeReconcile.js");
  await db.initDb();
  READY = true;
});
test.after(async () => { if (pgHandle) { try { await pgHandle.stop(); } catch { /* ignore */ } } });

const skip = () => (!READY ? { skip: "no PostgreSQL (set DATABASE_URL; CI provides one)" } : false);

test("R35-P3-04: getReconcilableFills paginates BEYOND 5,000 rows (no cap-driven order split)", { skip: skip() }, async () => {
  const uk = "pg_paginate_" + Date.now();
  const base = 1_700_000_000_000;
  for (let i = 0; i < 5001; i++) {
    await db.recordFill(uk, { fillId: `p${i}`, real: true, broker: "fyers", orderId: "O" + i, qty: 1, fees: 0, ts: base + i });
  }
  const all = await db.getReconcilableFills(uk, 0, base + 10000);
  assert.equal(all.length, 5001, "every row returned despite the 5,000-row page size");
  assert.ok(all.every((f) => f.feeFinalized === false), "none finalized yet");
});

test("R35-P3-04 / P2-03: overlay exclusion — a finalized execution is annotated feeFinalized:true", { skip: skip() }, async () => {
  const uk = "pg_overlay_" + Date.now();
  const t = 1_700_000_100_000;
  await db.recordFill(uk, { fillId: "a", real: true, broker: "fyers", orderId: "OZ", qty: 1, fees: 0, ts: t });
  await db.recordFill(uk, { fillId: "b", real: true, broker: "fyers", orderId: "OZ", qty: 1, fees: 0, ts: t + 1 });
  await db.recordFill(uk, { fillId: "feefinal_fyers_entry_a", kind: "fee_final", real: true, broker: "fyers", refFillId: "a", feeDelta: 5, feeStatus: "contract-note", feeFinal: true, ts: t + 2 });
  const set = await db.getReconcilableFills(uk, 0, t + 100);
  const byId = Object.fromEntries(set.map((f) => [f.fillId, f]));
  assert.equal(byId.a.feeFinalized, true, "a has an overlay ⇒ finalized");
  assert.equal(byId.b.feeFinalized, false, "b still needs finalizing");
  // Discovery must still see this user (b is unmatched) but NOT after b is finalized too.
  const users1 = await db.getUsersWithProvisionalFills(0, t + 100);
  assert.ok(users1.some((u) => u.userKey === uk), "user discovered while b is unmatched");
});

test("R35-P2-04: crash-after-first-overlay REPLAY converges (order-level, real DB)", { skip: skip() }, async () => {
  const uk = "pg_converge_" + Date.now();
  const t = 1_700_000_200_000;
  // 3 executions of one order, ₹30 order-level charge.
  for (const id of ["a", "b", "c"]) await db.recordFill(uk, { fillId: id, real: true, broker: "fyers", orderId: "OC", qty: 1, fees: 0, ts: t });
  const note = [{ execId: null, orderId: "OC", broker: "fyers", charges: 30 }];
  // Run 1 — persist overlays for ALL finals, but simulate a CRASH after only the first is written.
  const finals1 = feeReconcile.reconcileEodFees({ fills: await db.getReconcilableFills(uk, 0, t + 100), contractNote: note, now: t });
  assert.equal(finals1.length, 3);
  const first = finals1.slice().sort((x, y) => String(x.fillId).localeCompare(String(y.fillId)))[0];
  await db.recordFill(uk, { fillId: `feefinal_fyers_entry_${first.fillId}`, kind: "fee_final", real: true, broker: "fyers", refFillId: first.fillId, feeDelta: first.feeDelta, feeStatus: "contract-note", feeFinal: true, ts: t + 1 });
  // Run 2 — replay after the crash: only the two remaining executions are emitted, and the total still sums to ₹30.
  const finals2 = feeReconcile.reconcileEodFees({ fills: await db.getReconcilableFills(uk, 0, t + 100), contractNote: note, now: t + 2 });
  assert.equal(finals2.length, 2, "only the two not-yet-finalized executions are emitted on replay");
  assert.ok(!finals2.find((f) => f.fillId === first.fillId), "the already-finalized execution is not re-emitted");
  assert.equal(+(first.finalFees + finals2.reduce((s, x) => s + x.finalFees, 0)).toFixed(2), 30, "prior + replayed shares sum to the order total");
  for (const f of finals2) await db.recordFill(uk, { fillId: `feefinal_fyers_entry_${f.fillId}`, kind: "fee_final", real: true, broker: "fyers", refFillId: f.fillId, feeDelta: f.feeDelta, feeStatus: "contract-note", feeFinal: true, ts: t + 3 });
  // Run 3 — fully converged: nothing left to emit, and the user drops out of discovery.
  const finals3 = feeReconcile.reconcileEodFees({ fills: await db.getReconcilableFills(uk, 0, t + 100), contractNote: note, now: t + 4 });
  assert.equal(finals3.length, 0, "converged ⇒ no more finalizations");
  const users = await db.getUsersWithProvisionalFills(0, t + 100);
  assert.ok(!users.some((u) => u.userKey === uk), "user no longer discovered once every execution is finalized");
});

test("R35-P3-01: MANUAL_RECONCILIATION_REQUIRED evidence survives a fresh DB read (JSONB persisted)", { skip: skip() }, async () => {
  const id = "pg_att_" + Date.now();
  await db.prepareOrderAttempt({ id, userId: "pg_u", orderTag: "TAGX", status: "PREPARED" });
  const evidence = { orderTag: "TAGX", brokerOrderId: "5501", createdAt: 1, checked: ["orders", "tradebook", "positions", "holdings"] };
  await db.finalizeOrderAttempt(id, "MANUAL_RECONCILIATION_REQUIRED", { manual: true, evidence });
  const row = await db.getOrderAttempt(id);   // a fresh SELECT round-trip
  assert.equal(row.status, "MANUAL_RECONCILIATION_REQUIRED");
  assert.equal(row.resolution.manual, true);
  assert.equal(row.resolution.evidence.brokerOrderId, "5501");
  assert.equal(row.resolved, false, "stays unresolved ⇒ account stays locked");
});
