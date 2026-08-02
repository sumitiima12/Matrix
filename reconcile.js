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

module.exports = { parseDeltaTs, hasClientOrderId, pageConclusive, redirectAllowed, redirectBindingOk, classifyDeltaOrder };
