/**
 * provenance.js — CANONICAL, IMMUTABLE ORDER/FILL/POSITION ORIGIN (pure).
 *
 * Root cause of the "everything is Manual" defect: the order route and the reconcilers stamped
 * `tradeType || "Manual"`, so any row without an explicit type — including screener/automation orders whose
 * type failed to propagate — became "Manual", and the UI rendered "Strategy by: Manual" (an ORIGIN printed as
 * a STRATEGY name). This module makes origin a resolved, evidence-based fact, never a silent default.
 *
 * Two independent fields, never conflated:
 *   - origin   : who/what CREATED the order (an enum)
 *   - strategy : the human strategy/screener NAME, or null ("—" in the UI). Never "Manual".
 *
 * Pure + deterministic so every rule is unit-tested. The backfill/reconciler supplies the DB evidence; this
 * file only decides, given evidence, what the origin IS.
 */

const ORIGIN = Object.freeze({
  MANUAL: "MANUAL",
  SCREENER: "SCREENER",
  SMART_AUTO_BUY: "SMART_AUTO_BUY",
  AUTOMATE: "AUTOMATE",
  IDEA: "IDEA",
  BROKER_IMPORTED: "BROKER_IMPORTED",
  UNKNOWN: "UNKNOWN",
});

const AUTOMATED_ORIGINS = Object.freeze(new Set([
  ORIGIN.SCREENER, ORIGIN.SMART_AUTO_BUY, ORIGIN.AUTOMATE, ORIGIN.IDEA,
]));

/* The legacy display `tradeType` → origin. Only the automated types are TRUSTED (they are only ever stamped by
   their engine). "Manual" is LOW-CONFIDENCE (it was also the missing-value default), so evidence can override
   it UP to an automated origin — but an automated origin is NEVER downgraded to MANUAL. Empty ⇒ no signal. */
function originFromTradeType(tt) {
  switch (String(tt || "").trim().toLowerCase()) {
    case "auto buy": return { origin: ORIGIN.SMART_AUTO_BUY, trusted: true };
    case "screener auto buy": return { origin: ORIGIN.SCREENER, trusted: true };
    case "automate": return { origin: ORIGIN.AUTOMATE, trusted: true };
    case "ideas": case "idea": return { origin: ORIGIN.IDEA, trusted: true };
    case "manual": return { origin: ORIGIN.MANUAL, trusted: false };   // ambiguous — was also the default
    default: return { origin: null, trusted: false };                  // empty / unrecognised ⇒ no signal
  }
}

/* Map a resolved order_attempt/signal/screener record's own origin marker to the enum. Records created AFTER
   this correction carry an explicit `origin`; older ones are inferred from which store they came from. */
function originFromEvidenceKind(kind) {
  switch (String(kind || "")) {
    case "screener": return ORIGIN.SCREENER;
    case "smart_auto_buy": return ORIGIN.SMART_AUTO_BUY;
    case "automate": return ORIGIN.AUTOMATE;
    case "idea": return ORIGIN.IDEA;
    case "manual": return ORIGIN.MANUAL;
    default: return null;
  }
}

/**
 * Resolve canonical provenance for one order/trade from durable EVIDENCE, in the required priority order.
 *
 * @param {object} trade  the display row: { tradeType, strategy, strategyId, strategyName, screenerKey,
 *                        screenerName, signalId, orderId (matrixOrderId), brokerOrderId, orderTag/clientOrderId,
 *                        real, market, sym, side, qty, entry, entryAt }
 * @param {object} ev  evidence resolved by the CALLER from the DB (any subset; each is the linked record or null):
 *   { byMatrixOrderId, byClientOrderId, byBrokerOrderId, bySignalId, byExecutionCorrelation }
 *   Each linked record: { kind, strategyId, strategyName, screenerId, screenerName, signalId, automationRuleId,
 *                         orderAttemptId, confidence }
 * @returns {object} canonical provenance + the evidence chain that decided it (audit trail).
 */
function resolveProvenance(trade, ev = {}) {
  const t = trade || {};
  const base = originFromTradeType(t.tradeType);
  const chain = [];

  // Evidence, strongest → weakest. The FIRST record that yields an automated/known origin wins.
  const ordered = [
    ["matrixOrderId", ev.byMatrixOrderId],
    ["clientOrderId", ev.byClientOrderId],
    ["brokerOrderId", ev.byBrokerOrderId],
    ["signalId", ev.bySignalId],
    ["executionCorrelation", ev.byExecutionCorrelation],
  ];

  let resolved = null;
  for (const [via, rec] of ordered) {
    if (!rec) continue;
    const o = originFromEvidenceKind(rec.kind);
    if (!o) continue;
    chain.push({ via, kind: rec.kind, confidence: rec.confidence || "linked" });
    // An automated origin from a durable link is authoritative. A MANUAL-kind record only counts as positive
    // manual evidence (it does not beat an automated record found earlier — but we took the first, so order holds).
    resolved = { origin: o, rec, via };
    break;
  }

  /* ROW SELF-EVIDENCE. A trade row that already carries a screener/strategy ATTRIBUTION (written at order time by
     the screener/automation path — this is how the Screener Dashboard correctly groups SOXLB under Swing Catcher)
     is itself durable evidence. A "Manual"/empty tradeType must NEVER hide an attribution the row already holds —
     that internal inconsistency is exactly defect #3. Screener attribution is a strong, specific link. */
  if (!resolved && !(base.trusted && AUTOMATED_ORIGINS.has(base.origin))) {
    if (t.screenerKey || t.screenerName) {
      resolved = { origin: ORIGIN.SCREENER, rec: { screenerId: t.screenerKey || null, screenerName: t.screenerName || t.strategy || null }, via: "row.screenerAttribution" };
      chain.push({ via: "row.screenerAttribution", kind: "screener", confidence: "row-attribution" });
    } else if (t.automationRuleId || (t.strategyId && t.tradeType && String(t.tradeType).toLowerCase() === "automate")) {
      resolved = { origin: ORIGIN.AUTOMATE, rec: { strategyId: t.strategyId || null, strategyName: t.strategyName || t.strategy || null, automationRuleId: t.automationRuleId || null }, via: "row.strategyAttribution" };
      chain.push({ via: "row.strategyAttribution", kind: "automate", confidence: "row-attribution" });
    }
  }

  let origin, strategyId = null, strategyName = null, screenerId = null, screenerName = null,
    signalId = t.signalId || null, automationRuleId = null, decidedBy;

  if (resolved) {
    origin = resolved.origin;
    const r = resolved.rec;
    strategyId = r.strategyId || t.strategyId || null;
    strategyName = r.strategyName || null;
    screenerId = r.screenerId || t.screenerKey || null;
    screenerName = r.screenerName || null;
    signalId = r.signalId || signalId;
    automationRuleId = r.automationRuleId || null;
    decidedBy = `evidence:${resolved.via}`;
    // NEVER downgrade a trusted automated tradeType to something weaker; if both say automated, keep evidence's.
  } else if (base.trusted && AUTOMATED_ORIGINS.has(base.origin)) {
    // The engine-stamped automated type is itself trusted evidence when no linked record was supplied.
    origin = base.origin;
    decidedBy = "tradeType:trusted";
    chain.push({ via: "tradeType", kind: base.origin, confidence: "trusted" });
  } else if (base.origin === ORIGIN.MANUAL) {
    // Explicit "Manual" WITHOUT corroborating evidence is not conclusive (it was also the missing-value default).
    // Per policy we do NOT assert MANUAL as a default: without a manual order-attempt or clear manual signal it
    // stays UNKNOWN until the backfill correlates it (or a human confirms). A caller with real manual evidence
    // passes ev.manualConfirmed=true to keep MANUAL.
    if (ev.manualConfirmed === true) { origin = ORIGIN.MANUAL; decidedBy = "manual:confirmed"; }
    else { origin = ORIGIN.UNKNOWN; decidedBy = "manual:unconfirmed→unknown"; }
  } else {
    // No tradeType signal and no evidence. If the position is known to exist at the broker but Matrix never
    // recorded an order for it, it's an import; otherwise genuinely unknown.
    origin = ev.brokerHeldNoMatrixOrder === true ? ORIGIN.BROKER_IMPORTED : ORIGIN.UNKNOWN;
    decidedBy = origin === ORIGIN.BROKER_IMPORTED ? "broker:imported" : "no-evidence→unknown";
  }

  // Preserve any strategy/screener names already on the row when evidence didn't supply better ones — but only
  // when the origin is the matching kind (never attach a strategy name to a MANUAL/UNKNOWN row).
  if (origin === ORIGIN.SCREENER) {
    screenerName = screenerName || t.screenerName || t.strategy || null;
    screenerId = screenerId || t.screenerKey || null;
  } else if (origin === ORIGIN.AUTOMATE) {
    strategyName = strategyName || t.strategyName || t.strategy || null;
    strategyId = strategyId || t.strategyId || null;
  }

  return {
    origin,
    strategyId: origin === ORIGIN.AUTOMATE ? strategyId : (origin === ORIGIN.SCREENER ? null : strategyId),
    strategyName: origin === ORIGIN.AUTOMATE ? strategyName : null,
    screenerId: origin === ORIGIN.SCREENER ? screenerId : null,
    screenerName: origin === ORIGIN.SCREENER ? screenerName : null,
    signalId, automationRuleId,
    matrixOrderId: t.orderId || t.matrixOrderId || null,
    brokerOrderId: t.brokerOrderId || null,
    clientOrderId: t.orderTag || t.clientOrderId || null,
    environment: t.real ? "REAL" : "VIRTUAL",
    market: t.market || null,
    decidedBy,
    evidenceChain: chain,
  };
}

/* UI-facing SOURCE label for an origin. This is what the "Source:" field shows — NEVER a strategy name. */
function sourceLabel(origin) {
  switch (origin) {
    case ORIGIN.SCREENER: return "Screener";
    case ORIGIN.SMART_AUTO_BUY: return "Smart Auto-Buy";
    case ORIGIN.AUTOMATE: return "Automation";
    case ORIGIN.IDEA: return "Idea";
    case ORIGIN.MANUAL: return "Manual";
    case ORIGIN.BROKER_IMPORTED: return "Imported";
    default: return "Unknown";
  }
}

/* The STRATEGY/SCREENER name to render (the "Strategy:" field), or "—". Manual/Smart-Auto-Buy/Idea/Unknown
   have no strategy name — this is what kills "Strategy by: Manual" at the source. */
function strategyLabel(prov) {
  if (!prov) return "—";
  if (prov.origin === ORIGIN.SCREENER) return prov.screenerName || "—";
  if (prov.origin === ORIGIN.AUTOMATE) return prov.strategyName || "—";
  return "—";
}

/* The category bucket a trade counts toward in the P&L breakdown. Mutually exclusive; UNKNOWN/BROKER_IMPORTED
   collapse to a single "Unknown/Imported" reporting category so nothing is silently dropped from the total. */
function pnlCategory(origin) {
  switch (origin) {
    case ORIGIN.MANUAL: return "Manual";
    case ORIGIN.SMART_AUTO_BUY: return "Smart Auto-Buy";
    case ORIGIN.AUTOMATE: return "Automate";
    case ORIGIN.SCREENER: return "Screener";
    case ORIGIN.IDEA: return "Ideas";
    default: return "Unknown/Imported";
  }
}

const CATEGORIES = Object.freeze(["Manual", "Smart Auto-Buy", "Automate", "Screener", "Ideas", "Unknown/Imported"]);

module.exports = {
  ORIGIN, AUTOMATED_ORIGINS, CATEGORIES,
  originFromTradeType, resolveProvenance, sourceLabel, strategyLabel, pnlCategory,
};
