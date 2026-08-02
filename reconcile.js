/**
 * reconcile.js — PURE decision logic for unknown-order reconciliation and OAuth redirect binding.
 *
 * The broker HTTP calls live in server.js, but the DECISIONS they drive — is a scanned order page
 * conclusive about absence? does our client_order_id appear? is a callback redirect allow-listed and
 * bound? — are extracted here so they can be unit-tested without a live broker or a running server
 * (R6-P2-04). server.js imports these and feeds them already-fetched broker payloads.
 */

/* Parse a Delta timestamp (created_at) to ms, tolerant of ISO strings and numeric seconds/ms/µs. Returns
   null when it can't parse — callers treat null as "unknown age", never as "old enough to be conclusive". */
function parseDeltaTs(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e15) return Math.floor(v / 1000);   // microseconds
    if (v > 1e12) return v;                       // milliseconds
    if (v > 1e9) return v * 1000;                 // seconds
    return null;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/* Does this page of Delta orders carry our client_order_id? */
function hasClientOrderId(records, cid) {
  return Array.isArray(records) && records.some((o) => String((o && o.client_order_id) || "") === String(cid));
}

/* Is a scanned page CONCLUSIVE about absence? A short page (we saw them all) is conclusive; a FULL page is
   conclusive only if it already contains a record OLDER than the order-placement boundary (Delta returns
   newest-first, so we've scanned past where ours would be). Unparseable timestamps are ignored, so they
   can only keep a result inconclusive — never falsely declare absence. Non-array (bad schema) → false. */
function pageConclusive(records, pageSize, boundaryMs) {
  if (!Array.isArray(records)) return false;
  if (records.length < pageSize) return true;
  if (boundaryMs > 0) {
    for (const o of records) {
      const t = parseDeltaTs(o && (o.created_at || o.created_at_ms));
      if (t != null && t < boundaryMs - 60000) return true;
    }
  }
  return false;
}

/* OAuth callback allow-list: EXACT origin + a PATH BOUNDARY (never a naive startsWith, which would let
   "https://app.example" prefix-match "https://app.example.evil.com"). An allow entry may be a bare origin
   or an origin+path prefix. Empty allow-list = opt-in (allow all); no redirect = nothing to gate. */
function redirectAllowed(redirect, allowList) {
  if (!redirect) return true;
  if (!allowList || !allowList.length) return true;
  let u; try { u = new URL(redirect); } catch { return false; }
  return allowList.some((a) => {
    let au; try { au = new URL(a); } catch { return false; }
    if (u.origin !== au.origin) return false;
    const base = au.pathname.replace(/\/+$/, "");
    return base === "" || u.pathname === base || u.pathname.startsWith(base + "/");
  });
}

/* OAuth redirect binding at session completion. A mismatch is always rejected; a MISSING echoed redirect
   is rejected only when enforcement is on (so a client that doesn't yet echo it isn't hard-broken).
   Returns { ok, reason }. */
function redirectBindingOk(stateRedirect, echoed, enforce) {
  if (!stateRedirect) return { ok: true };
  if (echoed && String(stateRedirect) !== String(echoed)) return { ok: false, reason: "redirect mismatch — restart the broker login" };
  if (!echoed && enforce) return { ok: false, reason: "redirect not presented — restart the broker login" };
  return { ok: true };
}

/* ONE interpretation of a Delta order response → fill truth, so ENTRY and EXIT read fills the same way
   (the review's "internal truth diverges on partial/delayed/unknown fills"). `requested` is the contract
   size we asked for, used when the response omits size. HTTP 200 is NOT a fill — a market order can be
   accepted then partially filled or rejected, so we derive from size/unfilled_size/state. */
function classifyDeltaOrder(o, requested = 0) {
  o = o || {};
  const size = Number(o.size) || Number(requested) || 0;
  const unfilled = o.unfilled_size != null ? Number(o.unfilled_size) : (o.state === "closed" ? 0 : size);
  const filled = Math.max(0, size - unfilled);
  const rejected = o.state === "cancelled" || o.state === "rejected";
  return {
    state: o.state || "unknown",
    size, filled, unfilled, rejected,
    fullyFilled: !rejected && filled > 0 && unfilled <= 0,
    partial: !rejected && filled > 0 && unfilled > 0,
    avgPrice: o.average_fill_price != null ? Number(o.average_fill_price) : null,
    orderId: o.id != null ? o.id : null,
  };
}

/* FYERS order status → fill truth. v3 status codes: 1 cancelled · 2 traded/filled · 4 transit · 5 rejected
   · 6 pending. Acceptance (an order id) is NOT execution — only status 2 with a positive filled qty is a
   confirmed fill. Everything we can't positively read as filled/rejected is treated as PENDING (the safe
   direction: we won't register a phantom entry or mark an unconfirmed exit closed). */
function classifyFyersOrder(o) {
  o = o || {};
  const status = Number(o.status);
  const qty = Number(o.qty) || 0;
  const filledQty = Number(o.filledQty != null ? o.filledQty : o.filled_qty) || 0;
  const avgPrice = (o.tradedPrice != null ? Number(o.tradedPrice) : (o.avgPrice != null ? Number(o.avgPrice) : null));
  const filled = status === 2 && filledQty > 0;
  const rejected = status === 5 || status === 1;   // rejected or cancelled → nothing executed
  return { status, qty, filledQty, avgPrice: Number.isFinite(avgPrice) ? avgPrice : null, filled, rejected, pending: !filled && !rejected };
}

/* FYERS order tag = our durable dedupe key on FYERS (its analogue of Delta's client_order_id). FYERS
   caps orderTag at 20 alphanumeric chars, so we strip separators from our client id and keep the last 20
   (the trailing timestamp stays, so it's unique per order). The SAME derivation is used when we stamp the
   order and when we later scan the order book for it, so they always match. */
function fyersOrderTag(clientOrderId) {
  const t = String(clientOrderId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-20);
  return t || null;
}

/* Does this FYERS order book carry our stamped orderTag? (absence-scan analogue of hasClientOrderId) */
function hasFyersOrderTag(records, tag) {
  if (!tag || !Array.isArray(records)) return false;
  return records.some((o) => String((o && o.orderTag) || "") === String(tag));
}

/* R9-P2-02: sum the filled quantity and weighted-average fill price across ONLY the FYERS order-book
   entries carrying our stamped orderTag. Adoption uses this so a strategy adopts just the exposure its own
   order created — never a user's pre-existing holding in the same symbol. Returns { filledQty, avgPrice }. */
function attributeFyersFills(orderBook, tag) {
  let filledQty = 0, pricedQty = 0, notional = 0;
  if (tag && Array.isArray(orderBook)) {
    for (const o of orderBook) {
      if (String((o && o.orderTag) || "") !== String(tag)) continue;
      const c = classifyFyersOrder(o);
      if (c.filled && c.filledQty > 0) { filledQty += c.filledQty; if (c.avgPrice > 0) { pricedQty += c.filledQty; notional += c.filledQty * c.avgPrice; } }
    }
  }
  return { filledQty, avgPrice: pricedQty > 0 ? notional / pricedQty : null };
}

/* R10-P1-01: decide how much to SELL to close a FYERS long, given the broker's signed net holding and the
   quantity we want to close. FYERS equity SELL is NOT reduce-only, so this is the guard that stops a retry
   after a partial fill from overselling into a short. FAIL CLOSED: if we couldn't read the holding
   (held == null), place NO order ("unverified" → caller retries). Flat/short holding → nothing to close.
   Otherwise sell only min(requested, held) — never more than we actually hold. */
function fyersExitPlan(held, requestedQty) {
  const qty = Number(requestedQty) || 0;
  if (held == null) return { action: "unverified", sellQty: 0 };   // couldn't read holdings → do not sell
  const h = Number(held);
  if (!(h > 0)) return { action: "flat", sellQty: 0 };             // flat or short → nothing to close with a SELL
  return { action: "sell", sellQty: Math.min(qty, h) };
}

module.exports = { parseDeltaTs, hasClientOrderId, pageConclusive, redirectAllowed, redirectBindingOk, classifyDeltaOrder, classifyFyersOrder, fyersOrderTag, hasFyersOrderTag, attributeFyersFills, fyersExitPlan };
