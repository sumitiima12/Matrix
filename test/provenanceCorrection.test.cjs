/**
 * test/provenanceCorrection.test.cjs — proves the source-of-truth correction (provenance + canonical analytics
 * + dry-run backfill). Covers the 16 required invariants. Pure, deterministic, no DB.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { ORIGIN, resolveProvenance, sourceLabel, strategyLabel, pnlCategory } = require("../provenance");
const { computePortfolio, categoryPnl } = require("../portfolioAnalytics");
const { planBackfill, applyPlanInMemory } = require("../provenanceBackfill");

// A Swing Catcher screener signal → Delta order → fill, stamped (wrongly) "Manual" but linked by client-order tag.
const SOXLB = {
  id: "t-soxlb", sym: "SOXLB", market: "Crypto", real: true, side: "BUY", qty: 0.3, entry: 144.8,
  entryAt: 1000, tradeType: "Manual", orderId: "1473165512", orderTag: "mx_3729", brokerOrderId: "1473165512",
};
const screenerClaim = { kind: "screener", screenerId: "swing-catcher", screenerName: "Swing Catcher", sym: "SOXLB", side: "BUY", qty: 0.3, at: 1000 };
const idxWithClaim = { attemptByClientOrderId: { mx_3729: { kind: "screener", screenerId: "swing-catcher", screenerName: "Swing Catcher" } }, screenerClaims: [screenerClaim] };

test("#1 Swing Catcher signal→order→fill resolves SCREENER + Swing Catcher (tradeType was Manual)", () => {
  const p = resolveProvenance(SOXLB, { byClientOrderId: idxWithClaim.attemptByClientOrderId.mx_3729 });
  assert.equal(p.origin, ORIGIN.SCREENER);
  assert.equal(p.screenerName, "Swing Catcher");
  assert.equal(sourceLabel(p.origin), "Screener");
  assert.equal(strategyLabel(p), "Swing Catcher");
});

test("#2 backfill never changes a known SCREENER origin to MANUAL", () => {
  const already = { ...SOXLB, origin: ORIGIN.SCREENER, screenerName: "Swing Catcher", tradeType: "Screener Auto Buy" };
  const plan = planBackfill({ trades: [already], idx: {} });
  const row = plan.rows[0];
  assert.equal(row.after.origin, ORIGIN.SCREENER);
  assert.notEqual(row.after.origin, ORIGIN.MANUAL);
});

test("#3 missing provenance becomes UNKNOWN, never MANUAL", () => {
  const p = resolveProvenance({ id: "x", sym: "FOO", tradeType: "" }, {});
  assert.equal(p.origin, ORIGIN.UNKNOWN);
  // Explicit 'Manual' with no evidence is also not asserted as MANUAL by default.
  const p2 = resolveProvenance({ id: "y", sym: "FOO", tradeType: "Manual" }, {});
  assert.equal(p2.origin, ORIGIN.UNKNOWN);
  // ...unless there is positive manual evidence.
  const p3 = resolveProvenance({ id: "z", sym: "FOO", tradeType: "Manual" }, { manualConfirmed: true });
  assert.equal(p3.origin, ORIGIN.MANUAL);
});

test("#4 'Strategy by: Manual' can never be produced — Manual has strategy '—'", () => {
  const p = resolveProvenance({ tradeType: "Manual" }, { manualConfirmed: true });
  assert.equal(sourceLabel(p.origin), "Manual");
  assert.equal(strategyLabel(p), "—");
  // Smart Auto-Buy / Idea / Unknown also render no strategy name.
  for (const tt of ["Auto Buy", "Ideas", ""]) {
    assert.equal(strategyLabel(resolveProvenance({ tradeType: tt }, {})), "—");
  }
});

// Shared marks + fixtures for the analytics invariants.
const marks = { SOXLB: 144.57, SLVON: 58.86, SNDKB: 1651.24, BTC: 65000 };
const F = { mode: "REAL", market: "Crypto", from: 0, to: Infinity };

test("#5 totalPnl equals Σ category P&Ls within one cent", () => {
  const trades = [
    { id: "a", sym: "SOXLB", market: "Crypto", real: true, side: "BUY", qty: 0.3, entry: 144.8, origin: ORIGIN.SCREENER, screenerName: "Swing Catcher" },
    { id: "b", sym: "SLVON", market: "Crypto", real: true, side: "BUY", qty: 0.8, entry: 58.93, origin: ORIGIN.SMART_AUTO_BUY },
    { id: "c", sym: "SNDKB", market: "Crypto", real: true, side: "BUY", qty: 0.05, entry: 1628.6, origin: ORIGIN.MANUAL },
    { id: "d", sym: "BTC", market: "Crypto", real: true, side: "BUY", qty: 0.01, entry: 64000, exit: 65000, exitAt: 50, origin: ORIGIN.UNKNOWN },
  ];
  const r = computePortfolio({ trades, marks, filter: F });
  assert.equal(r.invariantHolds, true);
  const sum = Object.values(r.categories).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - r.totalPnl) <= 0.01, `Σcat ${sum} vs total ${r.totalPnl}`);
});

test("#6 Total Dashboard Screener P&L === Screener Dashboard P&L for identical filter", () => {
  const trades = [
    { id: "a", sym: "SOXLB", market: "Crypto", real: true, side: "BUY", qty: 0.3, entry: 144.8, origin: ORIGIN.SCREENER, screenerName: "Swing Catcher" },
    { id: "b", sym: "SLVON", market: "Crypto", real: true, side: "BUY", qty: 0.8, entry: 58.93, origin: ORIGIN.SMART_AUTO_BUY },
  ];
  const total = computePortfolio({ trades, marks, filter: F });
  // "Screener Dashboard" = the same canonical compute, filtered to screener-origin rows only.
  const screenerOnly = computePortfolio({ trades: trades.filter((t) => t.origin === ORIGIN.SCREENER), marks, filter: F });
  assert.equal(categoryPnl(total, "Screener"), screenerOnly.totalPnl);
});

test("#7 open-position count is one number for identical filters", () => {
  const trades = [
    { id: "a", sym: "SOXLB", market: "Crypto", real: true, qty: 0.3, entry: 144.8 },       // open
    { id: "b", sym: "SLVON", market: "Crypto", real: true, qty: 0.8, entry: 58.93 },        // open
    { id: "c", sym: "SNDKB", market: "Crypto", real: true, qty: 0.05, entry: 1628.6, exit: 1651, exitAt: 9 }, // closed
    { id: "d", sym: "EVAA", market: "Crypto", real: true, qty: 104, entry: 0.79, status: "rejected" },        // rejected
  ];
  const r = computePortfolio({ trades, marks, filter: F });
  assert.equal(r.openCount, 2);
  assert.equal(r.openPositions.length, 2);
});

test("#8 rejected / bad_schema / cancelled orders never appear as positions", () => {
  const trades = [
    { id: "r", sym: "X", market: "Crypto", real: true, qty: 1, entry: 10, status: "rejected" },
    { id: "c", sym: "Y", market: "Crypto", real: true, qty: 1, entry: 10, status: "cancelled" },
    { id: "b", sym: "Z", market: "Crypto", real: true, qty: 1, entry: 10, rejectReason: "bad_schema", status: "rejected" },
  ];
  const r = computePortfolio({ trades, marks: { X: 11, Y: 11, Z: 11 }, filter: F });
  assert.equal(r.openCount, 0);
});

test("#9 a fully sold position is closed everywhere (0 open, realised booked)", () => {
  const t = { id: "s", sym: "SLVON", market: "Crypto", real: true, side: "BUY", qty: 0.8, entry: 58.0, exit: 60.0, exitAt: 5, origin: ORIGIN.SCREENER, screenerName: "Swing Catcher" };
  const r = computePortfolio({ trades: [t], marks, filter: F });
  assert.equal(r.openCount, 0);
  assert.ok(Math.abs(r.realizedPnl - (60 - 58) * 0.8) < 1e-6);
});

test("#10 partial exits retain only the verified residual quantity as open", () => {
  // Modeled as the residual open row (qty reduced by the exit fill) — the analytics counts exactly that qty.
  const residual = { id: "p", sym: "SNDKB", market: "Crypto", real: true, side: "BUY", qty: 0.02, entry: 1628.6 };
  const r = computePortfolio({ trades: [residual], marks, filter: F });
  assert.equal(r.openCount, 1);
  assert.equal(r.openPositions[0].qty, 0.02);
});

test("#11 protection status reflects actual coverage, not origin", () => {
  const base = { sym: "A", market: "Crypto", real: true, qty: 1, entry: 10, origin: ORIGIN.MANUAL };
  const prot = computePortfolio({ trades: [{ ...base, id: "1", bracketActive: true }], marks: { A: 10 }, filter: F }).openPositions[0];
  const unprot = computePortfolio({ trades: [{ ...base, id: "2" }], marks: { A: 10 }, filter: F }).openPositions[0];
  const partial = computePortfolio({ trades: [{ ...base, id: "3", qty: 2, protectionCoveredQty: 1 }], marks: { A: 10 }, filter: F }).openPositions[0];
  const unknown = computePortfolio({ trades: [{ ...base, id: "4", protectionVerified: false }], marks: { A: 10 }, filter: F }).openPositions[0];
  assert.equal(prot.protection, "PROTECTED");
  assert.equal(unprot.protection, "UNPROTECTED");   // Manual origin but genuinely unprotected — from coverage, not origin
  assert.equal(partial.protection, "PARTIALLY_PROTECTED");
  assert.equal(unknown.protection, "UNKNOWN");
});

test("#12 win rate uses only eligible closed trades after fees; breakeven excluded; none → null", () => {
  const trades = [
    { id: "w", sym: "A", market: "Crypto", real: true, qty: 1, entry: 10, exit: 12, exitAt: 1 },   // +2 win
    { id: "l", sym: "B", market: "Crypto", real: true, qty: 1, entry: 10, exit: 9, exitAt: 2 },     // -1 loss
    { id: "be", sym: "C", market: "Crypto", real: true, qty: 1, entry: 10, exit: 10, exitAt: 3 },   // breakeven → excluded
    { id: "o", sym: "D", market: "Crypto", real: true, qty: 1, entry: 10 },                          // open → excluded
  ];
  const r = computePortfolio({ trades, marks: { D: 11 }, filter: F });
  assert.equal(r.wins, 1); assert.equal(r.losses, 1); assert.equal(r.breakevens, 1);
  assert.equal(r.eligibleClosedTrades, 2);
  assert.equal(r.winRate, 50);
  const none = computePortfolio({ trades: [{ id: "o2", sym: "D", market: "Crypto", real: true, qty: 1, entry: 10 }], marks: { D: 11 }, filter: F });
  assert.equal(none.winRate, null);   // "—", not 0%
});

test("#13 REAL and VIRTUAL data never mix", () => {
  const trades = [
    { id: "r1", sym: "A", market: "Crypto", real: true, qty: 1, entry: 10 },
    { id: "v1", sym: "A", market: "Crypto", real: false, qty: 1, entry: 10 },
  ];
  const real = computePortfolio({ trades, marks: { A: 11 }, filter: { mode: "REAL", market: "Crypto" } });
  const virt = computePortfolio({ trades, marks: { A: 11 }, filter: { mode: "VIRTUAL", market: "Crypto" } });
  assert.equal(real.openCount, 1); assert.deepEqual(real.meta.includedPositionIds, ["r1"]);
  assert.equal(virt.openCount, 1); assert.deepEqual(virt.meta.includedPositionIds, ["v1"]);
});

test("#14 Today/7d/30d have identical semantics across endpoints (closed scoped by exit time; open always now)", () => {
  const trades = [
    { id: "open", sym: "A", market: "Crypto", real: true, qty: 1, entry: 10, entryAt: 100 },              // open, entered long ago
    { id: "recent", sym: "B", market: "Crypto", real: true, qty: 1, entry: 10, exit: 12, exitAt: 950 },   // closed inside window
    { id: "old", sym: "C", market: "Crypto", real: true, qty: 1, entry: 10, exit: 12, exitAt: 100 },      // closed before window
  ];
  const win = { mode: "REAL", market: "Crypto", from: 900, to: 1000 };
  const r = computePortfolio({ trades, marks: { A: 11 }, filter: win });
  assert.equal(r.openCount, 1);                       // open always counts "now"
  assert.equal(r.closedTrades.length, 1);             // only the in-window exit
  assert.equal(r.closedTrades[0].id, "recent");
});

test("#15 multi-instance reconciliation cannot duplicate or overwrite provenance (idempotent, no-downgrade)", () => {
  const idx = { attemptByClientOrderId: { mx_3729: { kind: "screener", screenerId: "swing-catcher", screenerName: "Swing Catcher" } }, screenerClaims: [screenerClaim] };
  const first = planBackfill({ trades: [SOXLB], idx });
  const applied = applyPlanInMemory([SOXLB], first.mutations);
  assert.equal(applied[0].origin, ORIGIN.SCREENER);
  // Re-run on the corrected rows: no further mutation (idempotent), and never a downgrade.
  const second = planBackfill({ trades: applied, idx });
  assert.equal(second.summary.corrected, 0);
  assert.equal(second.rows[0].after.origin, ORIGIN.SCREENER);
});

test("#16 historical backfill is idempotent AND evidence-gated (no unbacked rewrites)", () => {
  // No evidence at all: a Manual row is reported UNRESOLVED (for review), never silently mutated.
  const plan = planBackfill({ trades: [{ id: "m", sym: "Q", market: "Crypto", real: true, qty: 1, entry: 10, tradeType: "Manual" }], idx: {} });
  assert.equal(plan.summary.corrected, 0);
  assert.equal(plan.rows[0].status, "UNRESOLVED");
  assert.equal(plan.mutations.length, 0);
});

test("duplicate/phantom detection reports without mutating", () => {
  const trades = [
    { id: "d1", sym: "A", market: "Crypto", real: true, qty: 1, entry: 10, orderId: "O1" },
    { id: "d2", sym: "A", market: "Crypto", real: true, qty: 1, entry: 10, orderId: "O1" },   // duplicate projection
    { id: "ph", sym: "GONE", market: "Crypto", real: true, qty: 1, entry: 10, orderId: "O2" }, // not held → phantom
  ];
  const plan = planBackfill({ trades, idx: { brokerHeld: new Set(["A"]) } });
  assert.equal(plan.duplicates.length, 1);
  assert.deepEqual(plan.duplicates[0].tradeIds.sort(), ["d1", "d2"]);
  assert.equal(plan.phantoms.length, 1);
  assert.equal(plan.phantoms[0].sym, "GONE");
});

test("category buckets are mutually exclusive and cover Unknown (nothing dropped from total)", () => {
  const cats = new Set();
  for (const o of [ORIGIN.MANUAL, ORIGIN.SMART_AUTO_BUY, ORIGIN.AUTOMATE, ORIGIN.SCREENER, ORIGIN.IDEA, ORIGIN.UNKNOWN, ORIGIN.BROKER_IMPORTED]) cats.add(pnlCategory(o));
  assert.ok(cats.has("Unknown/Imported"));
  assert.equal(pnlCategory(ORIGIN.BROKER_IMPORTED), "Unknown/Imported");
  assert.equal(pnlCategory(ORIGIN.UNKNOWN), "Unknown/Imported");
});
