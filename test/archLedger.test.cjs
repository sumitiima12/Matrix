/* ARCH-1 + ARCH-2 tests: the immutable fills ledger (flat-file mode) and the normalized broker-fill contract. */
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

delete process.env.DATABASE_URL;
const tmpFills = path.join(os.tmpdir(), `mx_fills_${process.pid}_${Date.now()}.json`);
process.env.FILLS_FILE = tmpFills;
const db = require("../db.js");
const { normalizeFill } = require("../fillContract.js");

test.after(() => { try { fs.unlinkSync(tmpFills); } catch { /* ignore */ } });

test("ARCH-1: a fill appends once and is idempotent on the broker key", async () => {
  const u = "919000000100";
  const f = { broker: "fyers", orderId: "LEDG1", side: "BUY", qty: 3, entry: 100, market: "IN", tradeType: "Manual", entryAt: Date.now() };
  const a = await db.recordFill(u, f);
  const b = await db.recordFill(u, f);   // same fill replayed (retry/poll/watcher)
  assert.strictEqual(a.inserted, true);
  assert.strictEqual(b.inserted, false, "the same broker fill must not append twice");
  const rows = await db.getFills(u, 0, Date.now() + 60000);
  assert.strictEqual(rows.filter((x) => x.orderId === "LEDG1").length, 1);
});

test("ARCH-1: fills lacking an order id do NOT collapse into one row", async () => {
  const u = "919000000101";
  await db.recordFill(u, { broker: "delta", orderId: null, side: "BUY", qty: 1, entry: 10, market: "Crypto", entryAt: Date.now() });
  await db.recordFill(u, { broker: "delta", orderId: null, side: "BUY", qty: 2, entry: 11, market: "Crypto", entryAt: Date.now() });
  const rows = await db.getFills(u, 0, Date.now() + 60000);
  assert.strictEqual(rows.length, 2, "two distinct no-order-id fills must both be recorded, not collapsed");
});

test("ARCH-2: normalizeFill maps FYERS status codes to the canonical contract", () => {
  const filled = normalizeFill("fyers", { id: "1", status: 2, qty: 5, filledQty: 5, tradedPrice: 101, side: 1 });
  assert.strictEqual(filled.status, "filled");
  assert.strictEqual(filled.filledQty, 5);
  assert.strictEqual(filled.side, "BUY");
  assert.strictEqual(normalizeFill("fyers", { id: "2", status: 6, qty: 5, filledQty: 0 }).status, "pending");
  assert.strictEqual(normalizeFill("fyers", { id: "3", status: 5 }).status, "rejected");
  assert.strictEqual(normalizeFill("fyers", { id: "4", qty: 5, filledQty: 2 }).status, "partial");
});

test("INC-1: an exit fill is recorded once and is idempotent on the managed-position id", async () => {
  const u = "919000000300";
  const exitFill = { id: "exit_pos42", broker: "fyers", orderId: "EXIT9", side: "SELL", qty: 3, entry: 110, market: "IN", tradeType: "Auto Buy Exit", kind: "exit", managedId: "pos42", ts: Date.now() };
  const a = await db.recordFill(u, exitFill);
  const b = await db.recordFill(u, exitFill);   // stale-close reconcile / second sweep replays it
  assert.strictEqual(a.inserted, true);
  assert.strictEqual(b.inserted, false, "the same exit must not append twice");
  const rows = await db.getFills(u, 0, Date.now() + 60000);
  const exits = rows.filter((x) => x.kind === "exit");
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(exits[0].side, "SELL");
});

test("INC-1: computeLedgerDrift flags entries in the risk journal that are missing from the ledger", () => {
  const trades = [
    { orderId: "A1", real: true, serverAuthored: true, status: "filled" },   // in both → OK
    { orderId: "A2", real: true, serverAuthored: true, status: "filled" },   // journalled, NOT in ledger → drift
    { orderId: "V1", real: false },                                          // virtual → ignored
    { orderId: "C1", real: true, clientAuthored: true },                     // client-authored (not serverAuthored) → ignored
  ];
  const fills = [
    { orderId: "A1", kind: "entry" },
    { orderId: "X9", kind: "entry" },                                        // in ledger, NOT journalled → drift
    { orderId: "A2", kind: "exit" },                                         // exit leg → not an entry, ignored
  ];
  const d = db.computeLedgerDrift(trades, fills);
  assert.deepStrictEqual(d.missingInLedger, ["A2"]);
  assert.deepStrictEqual(d.missingInJournal, ["X9"]);
  assert.strictEqual(d.drift, 2);
});

test("INC-1: computeLedgerDrift is clean when journal and ledger agree", () => {
  const trades = [{ orderId: "A1", real: true, serverAuthored: true }, { orderId: "A2", real: true, serverAuthored: true }];
  const fills = [{ orderId: "A1" }, { orderId: "A2" }, { orderId: "A1", kind: "exit" }];
  const d = db.computeLedgerDrift(trades, fills);
  assert.strictEqual(d.drift, 0);
});

test("R24-P2-01: projectFills takes the MAX cumulative snapshot per order, not the sum", () => {
  const fills = [
    { broker: "fyers", orderId: "P1", qty: 2, kind: "entry" },   // partial snapshot
    { broker: "fyers", orderId: "P1", qty: 5, kind: "entry" },   // fuller snapshot of the SAME order
    { broker: "delta", orderId: "D1", qty: 3, kind: "exit" },
  ];
  const proj = db.projectFills(fills);
  const p1 = proj.find((p) => p.orderId === "P1" && p.leg === "entry");
  assert.strictEqual(p1.qty, 5, "cumulative snapshots collapse to the largest (5), never summed (7)");
  assert.strictEqual(proj.filter((p) => p.leg === "exit").length, 1);
});

test("R24-P2-02: computeLedgerDrift flags a quantity mismatch, not just presence", () => {
  const trades = [{ orderId: "Q1", real: true, serverAuthored: true, qty: 5 }];
  const fills = [{ orderId: "Q1", qty: 2, kind: "entry" }];   // journal says 5, ledger only saw 2
  const d = db.computeLedgerDrift(trades, fills);
  assert.strictEqual(d.missingInLedger.length, 0);
  assert.strictEqual(d.qtyMismatch.length, 1);
  assert.strictEqual(d.qtyMismatch[0].journalQty, 5);
  assert.strictEqual(d.qtyMismatch[0].ledgerQty, 2);
  assert.ok(d.drift >= 1);
});

test("R25-H05: drift keys are broker-scoped — same orderId at two brokers does NOT collide", () => {
  const trades = [
    { orderId: "100", broker: "fyers", real: true, serverAuthored: true, qty: 5 },
    { orderId: "100", broker: "delta", real: true, serverAuthored: true, qty: 3 },
  ];
  const fills = [
    { orderId: "100", broker: "fyers", qty: 5, kind: "entry" },
    { orderId: "100", broker: "delta", qty: 3, kind: "entry" },
  ];
  const d = db.computeLedgerDrift(trades, fills);
  assert.strictEqual(d.journalEntries, 2, "two brokers' order 100 are distinct journal entries");
  assert.strictEqual(d.ledgerEntries, 2, "two brokers' order 100 are distinct ledger fills");
  assert.strictEqual(d.drift, 0, "both match per-broker — no false drift from the shared numeric id");
});

test("R24-P2-03: computeExitDrift finds a closed position with no exit fill", () => {
  const closed = [{ id: "posA", status: "closed" }, { id: "posB", status: "closed" }];
  const fills = [{ kind: "exit", managedId: "posA", orderId: "E1" }];   // posB's exit never recorded
  const d = db.computeExitDrift(closed, fills);
  assert.deepStrictEqual(d.missingExitFill, ["posB"]);
  assert.strictEqual(d.drift, 1);
});

test("R23: claimPendingProtection carries created_at so the watcher ages rows correctly", async () => {
  // Regression: the claim dropped created_at (a top-level column, not inside data), so the delayed-fill
  // watcher computed ageMs = now - 0 = huge and expired EVERY freshly-parked FYERS order immediately.
  const rec = { id: `pp_${process.pid}_${Date.now()}`, userId: "919000000200", broker: "fyers", orderId: "PP1", symbol: "SBIN", qty: 1 };
  const saved = await db.savePendingProtection(rec);
  const claimed = await db.claimPendingProtection(1000, 50);
  const mine = claimed.find((x) => x.orderId === "PP1");
  assert.ok(mine, "the parked row must be claimable");
  assert.ok(Number.isFinite(mine.created_at) && mine.created_at > 0, "created_at must survive the claim");
  const ageMs = Date.now() - (mine.created_at || 0);
  assert.ok(ageMs < 60_000, "a freshly-parked row must NOT read as hours old");
  assert.ok(ageMs < 8 * 3600 * 1000, "a fresh row must not trip the 8h expiry");
  assert.strictEqual(mine.created_at, saved.created_at, "claim must report the same created_at that was saved");
  await db.deletePendingProtection(rec.id);
});

test("ARCH-2: normalizeFill maps Delta state to the canonical contract", () => {
  const filled = normalizeFill("delta", { id: "d1", state: "closed", size: 4, unfilled_size: 0, average_fill_price: 50, side: "buy" });
  assert.strictEqual(filled.status, "filled");
  assert.strictEqual(filled.filledQty, 4);
  assert.strictEqual(normalizeFill("delta", { id: "d2", state: "open", size: 4, unfilled_size: 4 }).status, "pending");
  assert.strictEqual(normalizeFill("delta", { id: "d3", state: "rejected" }).status, "rejected");
  // An unknown adapter must NEVER claim a fill.
  assert.strictEqual(normalizeFill("somenewbroker", { id: "x" }).status, "unknown");
});
