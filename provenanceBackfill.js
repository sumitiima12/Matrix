/**
 * provenanceBackfill.js — DRY-RUN historical provenance repair (pure, idempotent, non-mutating).
 *
 * Fixes defects #3, #4, #6 for EXISTING data without inventing anything. It correlates each trade to durable
 * evidence (order attempts, client-order tags, broker order ids, screener/automation claims, signals, broker
 * fills) and proposes a corrected origin/strategy/screener. It NEVER:
 *   • invents provenance (only proposes a change backed by a concrete evidence record),
 *   • downgrades a known automated origin to MANUAL,
 *   • closes positions or fabricates fills/P&L,
 *   • mutates anything — it returns a plan; the caller applies it in one transaction.
 * It is idempotent: re-running on already-corrected rows proposes no further change.
 */

const { resolveProvenance, ORIGIN, AUTOMATED_ORIGINS } = require("./provenance");

function _num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function _sym(s) { return String(s || "").replace(/(USDT|USD|INR|PERP)$/i, "").replace(/^NSE:/i, "").replace(/-EQ$/i, "").toUpperCase(); }

/* Correlate a trade to a screener/automation CLAIM by deterministic product+side+size within a conservative
   execution-time window. This is the LAST resort (evidence priority #6) — only used when no id/tag link exists,
   and only a single unambiguous claim within the window qualifies (never a guess across several). */
function correlateExecution(trade, claims, windowMs) {
  const sym = _sym(trade.sym), side = String(trade.side || (trade.short ? "SELL" : "BUY")).toUpperCase();
  const qty = Math.abs(_num(trade.qty)), at = _num(trade.entryAt);
  const w = _num(windowMs) || 5 * 60 * 1000;
  const hits = (claims || []).filter((c) =>
    _sym(c.sym) === sym &&
    String(c.side || "BUY").toUpperCase() === side &&
    (c.qty == null || Math.abs(Math.abs(_num(c.qty)) - qty) <= Math.max(1e-8, qty * 0.02)) &&   // ≤2% size drift
    (c.productId == null || trade.brokerProductId == null || String(c.productId) === String(trade.brokerProductId)) &&
    Math.abs(_num(c.at) - at) <= w);
  return hits.length === 1 ? hits[0] : null;   // require a UNIQUE match — ambiguity ⇒ no correlation
}

/* Build the evidence object resolveProvenance() expects, from the precomputed indexes for ONE trade. */
function evidenceFor(trade, idx, windowMs) {
  const claim = correlateExecution(trade, idx.screenerClaims || [], windowMs);
  return {
    byMatrixOrderId: (trade.orderId != null && idx.attemptByMatrixOrderId) ? idx.attemptByMatrixOrderId[String(trade.orderId)] || null : null,
    byClientOrderId: ((trade.orderTag || trade.clientOrderId) != null && idx.attemptByClientOrderId) ? idx.attemptByClientOrderId[String(trade.orderTag || trade.clientOrderId)] || null : null,
    byBrokerOrderId: (trade.brokerOrderId != null && idx.attemptByBrokerOrderId) ? idx.attemptByBrokerOrderId[String(trade.brokerOrderId)] || null : null,
    bySignalId: (trade.signalId != null && idx.signalById) ? idx.signalById[String(trade.signalId)] || null : null,
    byExecutionCorrelation: claim ? { kind: claim.kind || "screener", screenerId: claim.screenerId, screenerName: claim.screenerName, strategyId: claim.strategyId, strategyName: claim.strategyName, signalId: claim.signalId, automationRuleId: claim.automationRuleId, confidence: "execution-correlation" } : null,
    brokerHeldNoMatrixOrder: idx.brokerHeldNoMatrixOrder && trade.orderId == null && idx.brokerHeldNoMatrixOrder(trade) === true,
    manualConfirmed: idx.manualConfirmed ? idx.manualConfirmed(trade) === true : false,
  };
}

/* The current (pre-correction) origin/strategy/screener a row displays, for the before/after diff. */
function currentView(t) {
  const { originFromTradeType } = require("./provenance");
  const base = originFromTradeType(t.tradeType);
  return {
    origin: t.origin || base.origin || ORIGIN.UNKNOWN,
    strategyName: t.strategyName || (base.origin === ORIGIN.AUTOMATE ? t.strategy : null) || null,
    screenerName: t.screenerName || (base.origin === ORIGIN.SCREENER ? t.strategy : null) || null,
  };
}

/**
 * Plan the backfill. Returns rows (before/after + evidence), a summary, the mutation set (for apply mode) and
 * detected duplicate/phantom open positions. Nothing is mutated.
 *
 * @param {object} args
 *   trades: display rows to inspect
 *   idx: { attemptByMatrixOrderId, attemptByClientOrderId, attemptByBrokerOrderId, signalById, screenerClaims,
 *          brokerHeld: Set of normalized held symbols (REAL), brokerHeldNoMatrixOrder?, manualConfirmed? }
 *   windowMs: execution-correlation window
 */
function planBackfill({ trades = [], idx = {}, windowMs } = {}) {
  const rows = [], mutations = [];
  let corrected = 0, unresolved = 0, unchanged = 0;

  for (const t of trades) {
    const before = currentView(t);
    const prov = resolveProvenance(t, evidenceFor(t, idx, windowMs));
    const after = { origin: prov.origin, strategyName: prov.strategyName, screenerName: prov.screenerName };

    // A KNOWN automated origin must never be downgraded to MANUAL/UNKNOWN by the backfill (invariant #2).
    if (AUTOMATED_ORIGINS.has(before.origin) && !AUTOMATED_ORIGINS.has(after.origin)) {
      after.origin = before.origin;
      after.strategyName = before.strategyName; after.screenerName = before.screenerName;
    }

    const changed = after.origin !== before.origin || (after.strategyName || null) !== (before.strategyName || null) || (after.screenerName || null) !== (before.screenerName || null);
    const evidenceBacked = prov.evidenceChain.length > 0;
    // Only propose a change when it is EVIDENCE-BACKED. An unbacked change (e.g. Manual→Unknown with no record)
    // is reported as "unresolved" for review, not applied — we don't rewrite history on a hunch.
    if (changed && evidenceBacked) {
      corrected += 1;
      mutations.push({ id: t.id, patch: { origin: after.origin, strategyName: after.strategyName, screenerName: after.screenerName, screenerKey: prov.screenerId, strategyId: prov.strategyId, signalId: prov.signalId, provenanceResolvedAt: Date.now(), provenanceDecidedBy: prov.decidedBy } });
    } else if (changed && !evidenceBacked) {
      unresolved += 1;
    } else {
      unchanged += 1;
    }

    rows.push({
      id: t.id, sym: t.sym, market: t.market, real: !!t.real,
      before, after,
      changed, evidenceBacked,
      evidence: prov.evidenceChain, decidedBy: prov.decidedBy,
      status: (changed && evidenceBacked) ? "CORRECTED" : (changed ? "UNRESOLVED" : "UNCHANGED"),
    });
  }

  // Duplicate / phantom open positions: same broker orderId projected onto >1 open row, OR two open rows for the
  // same (sym, side, entry) with no distinguishing order id. Reported only — never auto-closed.
  const openRows = trades.filter((t) => t.entry != null && t.exitAt == null && t.status !== "rejected");
  const byOrder = new Map();
  for (const t of openRows) { const k = t.orderId || t.brokerOrderId; if (k == null) continue; (byOrder.get(k) || byOrder.set(k, []).get(k)).push(t.id); }
  const duplicates = [...byOrder.entries()].filter(([, ids]) => ids.length > 1).map(([orderId, ids]) => ({ orderId, tradeIds: ids }));

  // Phantom: open REAL rows whose symbol is NOT in the broker-held set (position not actually held any more).
  const heldSet = idx.brokerHeld instanceof Set ? idx.brokerHeld : null;
  const phantoms = heldSet ? openRows.filter((t) => t.real && !heldSet.has(_sym(t.sym))).map((t) => ({ id: t.id, sym: t.sym })) : [];

  return {
    rows, mutations,
    duplicates, phantoms,
    summary: {
      inspected: trades.length, corrected, unresolved, unchanged,
      duplicateGroups: duplicates.length, phantomOpen: phantoms.length,
    },
  };
}

/* Apply a backfill plan's mutations to the trade rows IN MEMORY (pure) and return the new rows — used by tests
   to prove idempotency, and by the caller after wrapping in a real DB transaction. Never closes/deletes rows. */
function applyPlanInMemory(trades, mutations) {
  const patchById = new Map(mutations.map((m) => [m.id, m.patch]));
  return trades.map((t) => (patchById.has(t.id) ? { ...t, ...patchById.get(t.id) } : t));
}

module.exports = { planBackfill, applyPlanInMemory, correlateExecution, evidenceFor };
