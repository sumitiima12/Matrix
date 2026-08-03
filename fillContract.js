/* ARCH-2 — the ONE normalized broker-fill contract every adapter maps to, so downstream code (journal,
   protection, UI) never has to infer a fill from broker-specific shapes or from mere order acceptance.

   Canonical status ∈ accepted | pending | partial | filled | rejected | cancelled | unknown
     accepted  — broker took the order, no fill info yet (NOT a fill)
     pending   — live at the exchange, awaiting fill
     partial   — some quantity filled, some remaining
     filled    — fully filled
     rejected  — broker rejected it (nothing executed)
     cancelled — cancelled/expired before/after partial
     unknown   — we could not determine the outcome (treat as reconcile-required, never as filled)

   normalizeFill(broker, raw) returns:
     { broker, orderId, status, requestedQty, filledQty, remainingQty, avgPrice, side, ts, raw }
   Quantities are in the broker's native unit (contracts for Delta, shares/lots elsewhere); callers convert. */

const STATUSES = ["accepted", "pending", "partial", "filled", "rejected", "cancelled", "unknown"];

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

function normalizeFill(broker, raw) {
  const b = String(broker || "").toLowerCase();
  if (b === "fyers") return normFyers(raw);
  if (b === "delta") return normDelta(raw);
  // Unknown adapter: fail SAFE — never claim a fill we can't verify.
  return base(b, raw, { status: "unknown" });
}

function base(broker, raw, over) {
  return {
    broker, orderId: raw && (raw.id ?? raw.order_id ?? raw.orderId) != null ? String(raw.id ?? raw.order_id ?? raw.orderId) : null,
    status: "unknown", requestedQty: null, filledQty: null, remainingQty: null, avgPrice: null, side: null,
    ts: (raw && num(raw.ts)) || Date.now(), raw, ...over,
  };
}

/* FYERS order object: status codes 2=filled, 6=pending, 5=rejected, 1=cancelled; filledQty / tradedPrice. */
function normFyers(raw) {
  const r = raw || {};
  const filled = num(r.filledQty ?? r.filled_qty) || 0;
  const requested = num(r.qty ?? r.quantity);
  const st = Number(r.status);
  let status = "unknown";
  // Acceptance is NOT execution: only status 2 (traded) WITH a positive filled qty is a fill. This matches
  // reconcile.classifyFyersOrder exactly (which now delegates here) — a status-2 row with zero filled qty, or a
  // fill inferred from quantity alone, must never be treated as filled (the safe direction: no phantom entry).
  if (st === 2 && filled > 0) status = "filled";
  else if (st === 5) status = "rejected";
  else if (st === 1) status = "cancelled";
  else if (filled > 0) status = "partial";
  else if (st === 6) status = "pending";
  const remaining = requested != null && filled != null ? Math.max(0, requested - filled) : null;
  return base("fyers", r, {
    status, requestedQty: requested, filledQty: filled || null, remainingQty: remaining,
    avgPrice: num(r.tradedPrice ?? r.avgPrice ?? r.limitPrice), side: r.side === 1 ? "BUY" : r.side === -1 ? "SELL" : null,
  });
}

/* Delta order object: state ∈ open|closed|cancelled|rejected; size / unfilled_size / average_fill_price. */
function normDelta(raw) {
  const r = raw || {};
  const size = num(r.size) || 0;
  // Mirror reconcile.classifyDeltaOrder's arithmetic exactly (which now delegates here): a missing unfilled_size
  // means "closed ⇒ nothing left, otherwise nothing filled yet". filled = size − unfilled.
  const unfilled = r.unfilled_size != null ? (num(r.unfilled_size) || 0) : (r.state === "closed" ? 0 : size);
  const filled = Math.max(0, size - unfilled);
  let status = "unknown";
  if (r.state === "rejected") status = "rejected";
  else if (r.state === "cancelled") status = "cancelled";
  else if (filled > 0 && unfilled <= 0) status = "filled";
  else if (filled > 0) status = "partial";
  else if (r.state === "open") status = "pending";
  return base("delta", r, {
    status, requestedQty: size, filledQty: filled, remainingQty: unfilled,
    avgPrice: num(r.average_fill_price), side: r.side ? String(r.side).toUpperCase() : null,
  });
}

module.exports = { normalizeFill, STATUSES };
