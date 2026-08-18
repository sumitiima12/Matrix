/**
 * portfolioAnalytics.js — THE ONE canonical portfolio/trade analytics service (pure, deterministic).
 *
 * Root cause of defects #1, #2, #5, #8: every widget (Home Total, category boxes, Screener dashboard, Live
 * Positions, Trade History, Portfolio) computed its own numbers in React with slightly different filters,
 * period semantics, dedup and origin buckets. So the headline could not add up to the boxes, the Screener box
 * disagreed with the Screener dashboard, and the open count differed between screens.
 *
 * This module is the single definition. Every endpoint/widget calls computePortfolio() with ONE filter and
 * renders what it returns — no independent maths. It GUARANTEES, by construction:
 *   • totalPnl === Σ category P&Ls   (each trade maps to exactly one mutually-exclusive category)
 *   • one open-position set + count, shared by every screen
 *   • one Today/7d/30d semantic (open positions' unrealised counts "now"; closed trades scoped by EXIT time)
 *   • REAL and VIRTUAL never mix
 * and returns the metadata + the exact included IDs so callers can prove agreement.
 *
 * Pure: takes plain data (trades, marks, filter, feePolicy) and returns a plain report. Unit-tested.
 */

const { resolveProvenance, pnlCategory, CATEGORIES, ORIGIN, originFromTradeType } = require("./provenance");

const EPS = 1e-9;
function _num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function _normSym(s) { return String(s || "").replace(/(USDT|USD|INR|PERP)$/i, "").replace(/^NSE:/i, "").replace(/-EQ$/i, "").toUpperCase(); }

/* Instrument-specific "is this quantity effectively zero" tolerance. Crypto can hold tiny fractional residuals;
   equities are whole units. A position is OPEN only when |openQty| exceeds this. */
function qtyTolerance(market) {
  return String(market || "").toLowerCase() === "crypto" ? 1e-8 : 1e-6;
}

/* Signed direction: +1 long, -1 short. */
function dirOf(t) { return (t.side === "SELL" || t.short === true) ? -1 : 1; }

/* Fees for a trade under the selected policy. Prefer the authoritative finalized fee; else the recorded
   estimate; else 0. `policy.includeEstimatedExitFee` lets unrealised P&L reserve an estimated exit fee. */
function feesFor(t, policy) {
  const entryFee = _num(t.feeFinal != null ? t.feeFinal : (t.fee != null ? t.fee : t.entryFee));
  const exitFee = _num(t.exitFee);
  return { entryFee, exitFee };
}

/* Canonical origin of a trade for BUCKETING. Prefer the resolved canonical `origin` (set by the route/backfill).
   Legacy rows without it: trust an automated tradeType, treat explicit "manual" as Manual, and — critically —
   treat MISSING/empty as UNKNOWN, never Manual (defect #4). */
function originOf(t) {
  if (t.origin && typeof t.origin === "string") return t.origin;
  const base = originFromTradeType(t.tradeType);
  if (base.origin) return base.origin;           // automated (trusted) or explicit manual
  return ORIGIN.UNKNOWN;                          // no signal ⇒ Unknown, not Manual
}

/* Is a trade IN SCOPE for this filter? Environment (REAL/VIRTUAL) is a hard wall; broker/market are optional. */
function inScope(t, filter) {
  if (!t || t.status === "rejected" || t.status === "cancelled") return false;
  const env = t.real ? "REAL" : "VIRTUAL";
  if (String(filter.mode || "REAL").toUpperCase() !== env) return false;   // #13 REAL/VIRTUAL never mix
  if (filter.broker && String(t.broker || "").toLowerCase() !== String(filter.broker).toLowerCase()) return false;
  if (filter.market && String(t.market || "").toLowerCase() !== String(filter.market).toLowerCase()) return false;
  return true;
}

/* A trade is a confirmed OPEN position when it has a real entry and no exit, and its quantity clears tolerance.
   Rejected/cancelled/unresolved-without-fill rows are already excluded by inScope / entry==null. */
function isOpen(t) {
  const q = Math.abs(_num(t.qty));
  return t.entry != null && _num(t.entry) > 0 && t.exitAt == null && t.exit == null && q > qtyTolerance(t.market);
}
function isClosed(t) {
  return t.exitAt != null && t.exit != null && _num(t.qty) !== 0 && t.status !== "rejected";
}

/* Realised P&L of a closed trade (short-aware), net of actual entry+exit fees. null if not a usable closed trade. */
function realizedPnlNet(t, policy) {
  if (!isClosed(t)) return null;
  const entry = _num(t.entry), exit = _num(t.exit), qty = Math.abs(_num(t.qty));
  if (!(entry > 0) || !(exit > 0) || !(qty > 0)) return null;
  const { entryFee, exitFee } = feesFor(t, policy);
  return (exit - entry) * qty * dirOf(t) - entryFee - exitFee;
}

/* Unrealised P&L of an open position at a mark, net of entry fee (+ optional estimated exit fee per policy). */
function unrealizedPnlNet(t, mark, policy) {
  const entry = _num(t.entry), qty = Math.abs(_num(t.qty));
  if (!(entry > 0) || !(qty > 0) || mark == null) return 0;
  const { entryFee } = feesFor(t, policy);
  const estExit = policy && policy.includeEstimatedExitFee ? _num(t.estExitFee) : 0;
  return (_num(mark) - entry) * qty * dirOf(t) - entryFee - estExit;
}

/* Protection status for an OPEN position from its actual protection state — NEVER inferred from origin. */
function protectionOf(t) {
  const openQty = Math.abs(_num(t.qty));
  if (!(openQty > 0)) return { status: "UNKNOWN", coveredQty: 0, openQty: 0 };
  // Coverage evidence: an active broker bracket / server-managed protective exit, or a recorded SL/TP the exit
  // engine is enforcing. `protectionCoveredQty` (if the position row carries it) is authoritative.
  if (t.protectionCoveredQty != null) {
    const cov = Math.max(0, _num(t.protectionCoveredQty));
    if (cov + EPS >= openQty) return { status: "PROTECTED", coveredQty: openQty, openQty };
    if (cov > 0) return { status: "PARTIALLY_PROTECTED", coveredQty: cov, openQty };
    return { status: "UNPROTECTED", coveredQty: 0, openQty };
  }
  const hasActive = t.bracketActive === true || t.managedExitActive === true || (_num(t.sl) > 0 || _num(t.tp) > 0 || _num(t.tsl) > 0);
  if (t.protectionVerified === false) return { status: "UNKNOWN", coveredQty: 0, openQty };
  return hasActive ? { status: "PROTECTED", coveredQty: openQty, openQty } : { status: "UNPROTECTED", coveredQty: 0, openQty };
}

/* Timeframe membership. Open positions ALWAYS count "now" (their unrealised P&L is live); closed trades are
   scoped by EXIT time into [from,to]. This is the one Today/7d/30d rule every endpoint shares (#14). */
function _lo(v) { if (v == null) return -Infinity; const n = Number(v); return Number.isNaN(n) ? -Infinity : n; }   // preserves ±Infinity
function _hi(v) { if (v == null) return Infinity; const n = Number(v); return Number.isNaN(n) ? Infinity : n; }
function closedInWindow(t, filter) {
  const from = _lo(filter.from), to = _hi(filter.to);
  const x = _num(t.exitAt);
  return x >= from && x <= to;
}

/**
 * Compute the canonical portfolio report for one filter.
 * @param {object} args
 *   trades: array of display trade rows (each may carry canonical `origin`; else it is derived honestly)
 *   marks:  { [normalizedSymbol]: markPrice }  — the ONE price snapshot for valuation
 *   filter: { userId, mode:"REAL"|"VIRTUAL", broker?, market?, from?, to?, timeframeLabel?, valuationTs?,
 *             valuationSource?, currency? }
 *   feePolicy: { includeEstimatedExitFee?: bool }
 */
function computePortfolio({ trades = [], marks = {}, filter = {}, feePolicy = {} } = {}) {
  const asOf = filter.valuationTs != null ? _num(filter.valuationTs) : Date.now();
  const markFor = (sym) => { const k = _normSym(sym); return marks[k] != null ? _num(marks[k]) : (marks[String(sym).toUpperCase()] != null ? _num(marks[String(sym).toUpperCase()]) : null); };

  // Scope + DEDUP by broker order id (a broker position must not be double-projected). Keep the latest row.
  const scoped = [];
  const seen = new Map();
  for (const t of Array.isArray(trades) ? trades : []) {
    if (!inScope(t, filter)) continue;
    const key = t.orderId || t.brokerOrderId || t.id;
    if (key != null && seen.has(key)) {
      const prevIdx = seen.get(key);
      if (_num(t.ts || t.entryAt) >= _num(scoped[prevIdx].ts || scoped[prevIdx].entryAt)) scoped[prevIdx] = t;   // newer wins
      continue;
    }
    if (key != null) seen.set(key, scoped.length);
    scoped.push(t);
  }

  const zeroByCat = () => CATEGORIES.reduce((m, c) => (m[c] = 0, m), {});
  const byCategory = zeroByCat();
  const openPositions = [], closedTrades = [];
  const includedPositionIds = [], includedTradeIds = [];
  let realizedPnl = 0, unrealizedPnl = 0;
  let wins = 0, losses = 0, breakevens = 0;

  for (const t of scoped) {
    const cat = pnlCategory(originOf(t));
    if (isOpen(t)) {
      const mark = markFor(t.sym);
      const up = unrealizedPnlNet(t, mark, feePolicy);
      unrealizedPnl += up;
      byCategory[cat] += up;
      const prot = protectionOf(t);
      openPositions.push({
        id: t.id, orderId: t.orderId || null, sym: t.sym, market: t.market, side: t.side || (t.short ? "SELL" : "BUY"),
        qty: Math.abs(_num(t.qty)), entry: _num(t.entry), mark, unrealizedPnl: +up.toFixed(2),
        origin: originOf(t), category: cat, protection: prot.status, protectionCoveredQty: prot.coveredQty,
        entryAt: t.entryAt || null,
      });
      includedPositionIds.push(t.id);
    } else if (isClosed(t) && closedInWindow(t, filter)) {
      const rp = realizedPnlNet(t, feePolicy);
      if (rp == null) continue;
      realizedPnl += rp;
      byCategory[cat] += rp;
      // Win-rate eligibility: fully-closed with determinable realised P&L, excluding breakeven (#12 rules).
      if (Math.abs(rp) <= EPS) breakevens += 1;
      else if (rp > 0) wins += 1; else losses += 1;
      closedTrades.push({ id: t.id, orderId: t.orderId || null, sym: t.sym, origin: originOf(t), category: cat, realizedPnl: +rp.toFixed(2), exitAt: t.exitAt });
      includedTradeIds.push(t.id);
    }
  }

  const totalPnl = realizedPnl + unrealizedPnl;
  const eligibleClosed = wins + losses;
  const winRate = eligibleClosed > 0 ? +((wins / eligibleClosed) * 100).toFixed(2) : null;   // "—" when null (#8)

  // Displayed category values (round ONLY here). The invariant total===Σcategories holds on the raw numbers;
  // we also expose the rounded set and the rounding residual so the caller can prove nothing is silently lost.
  const categoriesRaw = byCategory;
  const categories = {}; let catRoundedSum = 0;
  for (const c of CATEGORIES) { categories[c] = +byCategory[c].toFixed(2); catRoundedSum += categories[c]; }
  const totalRounded = +totalPnl.toFixed(2);

  return {
    // headline
    totalPnl: totalRounded,
    realizedPnl: +realizedPnl.toFixed(2),
    unrealizedPnl: +unrealizedPnl.toFixed(2),
    // mutually-exclusive breakdown (Σ === totalPnl within rounding)
    categories,
    categoriesRaw,
    invariantHolds: Math.abs(catRoundedSum - totalRounded) <= 0.01,   // one-cent tolerance (test #5)
    roundingResidual: +(catRoundedSum - totalRounded).toFixed(2),
    // win rate
    winRate, wins, losses, breakevens, eligibleClosedTrades: eligibleClosed,
    // positions
    openPositions,
    openCount: openPositions.length,
    closedTrades,
    // provenance-safe metadata every widget echoes so agreement is provable
    meta: {
      asOf,
      mode: String(filter.mode || "REAL").toUpperCase(),
      broker: filter.broker || null,
      market: filter.market || null,
      timeframe: filter.timeframeLabel || null,
      from: Number.isFinite(_lo(filter.from)) ? _lo(filter.from) : null,   // null ⇒ unbounded (all-time)
      to: Number.isFinite(_hi(filter.to)) ? _hi(filter.to) : null,
      valuationSource: filter.valuationSource || "mark-snapshot",
      currency: filter.currency || (String(filter.market).toLowerCase() === "crypto" || String(filter.market).toUpperCase() === "US" ? "USD" : "INR"),
      includedPositionIds, includedTradeIds,
    },
  };
}

/* Convenience: the category P&L for a single origin category, from a computed report — so the Total Dashboard's
   "Screener" box and the Screener Dashboard total read the SAME number for the SAME filter (defect #2). */
function categoryPnl(report, category) {
  return report && report.categories ? _num(report.categories[category]) : 0;
}

module.exports = {
  computePortfolio, categoryPnl,
  // exported for tests / reuse
  originOf, isOpen, isClosed, realizedPnlNet, unrealizedPnlNet, protectionOf, qtyTolerance, _normSym,
};
