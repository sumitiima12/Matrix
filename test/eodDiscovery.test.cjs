/* R34-P3-02 — literal adapter tests for the EOD-fee discovery / completeness / manual-evidence changes, in flat-file
   mode (no DATABASE_URL) against TEMP files. Covers:
     • getUsersWithProvisionalFills / getProvisionalFills EXCLUDE source fills that already have a fee_final overlay
       (R34-P2-03), so finalized work isn't rediscovered every sweep;
     • getProvisionalFills returns the COMPLETE unfinalized set for an order (R34-P2-02 pagination in flat mode);
     • getOrderExecCounts reports the TRUE per-order execution count (finalized + not);
     • reconcileEodFees REFUSES order-level allocation over an incomplete execution set (R34-P2-02 completeness gate);
     • finalizeOrderAttempt PERSISTS manual + evidence (R34-P3-01) and it survives a read-back. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mx-eod-"));
process.env.FILLS_FILE = path.join(TMP, "fills.json");
process.env.ORDER_ATTEMPTS_FILE = path.join(TMP, "attempts.json");
delete process.env.DATABASE_URL;   // force flat-file mode

const db = require("../db.js");
const { reconcileEodFees } = require("../feeReconcile.js");

function seedFills(obj) { fs.writeFileSync(process.env.FILLS_FILE, JSON.stringify(obj)); }
const NOW = 1_700_000_000_000;

test("R34: flat-file mode is active (no Postgres) for these adapter tests", () => {
  assert.equal(db.USING_PG, false, "tests must run against the flat-file store");
});

test("R34-P2-03: getUsersWithProvisionalFills EXCLUDES a user whose only fill already has a fee_final overlay", async () => {
  seedFills({
    ph_unmatched: { f1: { fillId: "f1", real: true, broker: "fyers", orderId: "O1", ts: NOW } },
    ph_done: {
      f2: { fillId: "f2", real: true, broker: "fyers", orderId: "O2", ts: NOW },
      ff2: { fillId: "feefinal_fyers_entry_f2", kind: "fee_final", real: true, broker: "fyers", refFillId: "f2", ts: NOW },
    },
  });
  const users = await db.getUsersWithProvisionalFills(0, NOW + 1);
  const keys = users.map((u) => u.userKey).sort();
  assert.deepEqual(keys, ["ph_unmatched"], "only the user with an UNMATCHED provisional fill is discovered");
});

test("R34-P2-03: getProvisionalFills returns unfinalized fills and omits ones with an overlay", async () => {
  seedFills({
    ph_x: {
      a: { fillId: "a", real: true, broker: "fyers", orderId: "O1", ts: NOW },
      b: { fillId: "b", real: true, broker: "fyers", orderId: "O1", ts: NOW + 1 },
      ffa: { fillId: "feefinal_fyers_entry_a", kind: "fee_final", real: true, broker: "fyers", refFillId: "a", ts: NOW + 2 },
      done: { fillId: "done", real: true, broker: "fyers", orderId: "O9", feeFinal: true, feeStatus: "contract-note", ts: NOW },
      virt: { fillId: "virt", real: false, broker: "fyers", orderId: "O5", ts: NOW },
    },
  });
  const prov = await db.getProvisionalFills("ph_x", 0, NOW + 10);
  const ids = prov.map((f) => f.fillId).sort();
  assert.deepEqual(ids, ["b"], "a=overlaid, done=already final, virt=not real ⇒ only b remains provisional");
});

test("R34-P2-02: getOrderExecCounts counts ALL executions of an order (finalized or not)", async () => {
  seedFills({
    ph_y: {
      e1: { fillId: "e1", real: true, broker: "fyers", orderId: "OZ", ts: NOW },
      e2: { fillId: "e2", real: true, broker: "fyers", orderId: "OZ", ts: NOW + 1 },
      ffe1: { fillId: "feefinal_fyers_entry_e1", kind: "fee_final", real: true, broker: "fyers", refFillId: "e1", ts: NOW + 2 },
    },
  });
  const counts = await db.getOrderExecCounts("ph_y", 0, NOW + 10);
  const key = "fyersOZ";
  assert.equal(counts[key], 2, "the order has TWO true executions even though one is already finalized");
});

test("R34-P2-02: reconcileEodFees REFUSES order-level allocation when the execution set is incomplete", () => {
  // Only ONE of the order's two executions is visible (the other was finalized earlier). Without the completeness
  // gate, the whole ₹20 order charge would land on this single fill. With it, the order is left provisional.
  const fills = [{ fillId: "b", orderId: "OZ", broker: "fyers", qty: 1, real: true, fees: 0, feeFinal: false }];
  const note = [{ orderId: "OZ", broker: "fyers", charges: 20 }];
  const totals = { "fyersOZ": 2 };   // ledger says the order truly has 2 executions
  const refused = reconcileEodFees({ fills, contractNote: note, now: NOW, orderExecTotals: totals });
  assert.equal(refused.length, 0, "incomplete order execution set ⇒ no finalization this pass");
  // When the full set is present (2 fills), allocation proceeds and sums to the order total.
  const full = reconcileEodFees({
    fills: [
      { fillId: "a", orderId: "OZ", broker: "fyers", qty: 1, real: true, fees: 0, feeFinal: false },
      { fillId: "b", orderId: "OZ", broker: "fyers", qty: 1, real: true, fees: 0, feeFinal: false },
    ],
    contractNote: note, now: NOW, orderExecTotals: totals,
  });
  assert.equal(full.length, 2, "complete set ⇒ both executions finalized");
  assert.equal(+full.reduce((s, x) => s + x.finalFees, 0).toFixed(2), 20, "allocated fees sum to the order total");
});

test("R34-P3-01: finalizeOrderAttempt PERSISTS manual + evidence and it survives a read-back", async () => {
  const id = "att_manual_1";
  await db.prepareOrderAttempt({ id, userId: "ph_z", orderTag: "TAG1", status: "PREPARED" });
  const evidence = { orderTag: "TAG1", brokerOrderId: "9987", createdAt: NOW, checked: ["orders", "tradebook", "positions", "holdings"] };
  await db.finalizeOrderAttempt(id, "MANUAL_RECONCILIATION_REQUIRED", { manual: true, evidence });
  const row = await db.getOrderAttempt(id);
  assert.equal(row.status, "MANUAL_RECONCILIATION_REQUIRED");
  assert.ok(row.resolution, "a resolution record is stored (was previously dropped)");
  assert.equal(row.resolution.manual, true);
  assert.equal(row.resolution.evidence.brokerOrderId, "9987");
  assert.deepEqual(row.resolution.evidence.checked, ["orders", "tradebook", "positions", "holdings"]);
  assert.equal(row.resolved, false, "MANUAL_RECONCILIATION_REQUIRED stays UNRESOLVED so the account stays locked");
});
