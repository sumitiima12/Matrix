/**
 * reconcile.js — PURE decision logic for unknown-order reconciliation and OAuth redirect binding.
 *
 * The broker HTTP calls live in server.js, but the DECISIONS they drive — is a scanned order page
 * conclusive about absence? does our client_order_id appear? is a callback redirect allow-listed and
 * bound? — are extracted here so they can be unit-tested without a live broker or a running server
 * (R6-P2-04). server.js imports these and feeds them already-fetched broker payloads.
 *
 * INC-2: the FYERS/Delta fill-truth classifiers below DERIVE their canonical status from the single
 * normalizeFill contract (fillContract.js), so there is exactly ONE place that decides "is this a fill?" for
 * each broker. classify* keep their existing return shape (callers are unchanged) but the filled/rejected
 * decision now flows through normalizeFill — the reviewer's "wire normalizeFill into the FYERS/Delta paths".
 */
const { normalizeFill } = require("./fillContract");

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

/* M02 — the BROKER's own execution timestamp is the audit-authoritative fill time (it drives the IST risk-day
   boundary and the trade ledger's entry/exit time). Prefer it over the server's receipt clock, BUT only when it
   parses AND lands in a sane window around now (default ±2 days) — a mis-parsed or wildly-skewed broker time could
   otherwise push a fill into the wrong risk day or corrupt ordering. Tries several common broker field names in
   priority order. Returns a finite ms timestamp, or null if nothing usable (caller falls back to Date.now()).
   `first` accepts numbers or strings (epoch s/ms/µs or a date string) via parseDeltaTs. */
function brokerFillTsMs(candidates, { now = Date.now(), windowMs = 2 * 24 * 3600 * 1000 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const c of list) {
    const t = parseDeltaTs(c);
    if (t != null && Number.isFinite(t) && Math.abs(t - now) <= windowMs) return t;
  }
  return null;
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
  // INC-2: fill truth from the canonical contract (normalizeFill), so Delta has ONE fill-decision path.
  const n = normalizeFill("delta", { ...o, size });
  const rejected = n.status === "rejected" || n.status === "cancelled";
  return {
    state: o.state || "unknown",
    size, filled, unfilled, rejected,
    fullyFilled: n.status === "filled",
    partial: n.status === "partial",
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
  // INC-2: fill truth from the canonical contract (normalizeFill), so FYERS has ONE fill-decision path.
  // normFyers marks "filled" only for status 2 WITH a positive filled qty, and "rejected"/"cancelled" for 5/1 —
  // identical to the prior inline logic, now single-sourced. avgPrice/qty stay raw so nothing else shifts.
  const n = normalizeFill("fyers", o);
  const filled = n.status === "filled";
  const rejected = n.status === "rejected" || n.status === "cancelled";
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

/* R11-P1-01: is a position still in "closing" STALE enough to reconcile (rather than let the in-flight
   attempt finish)? A missing/zero closingSince means a legacy or crash-stranded claim → stale immediately.
   Otherwise stale once it's older than staleMs. Kept pure so the recovery decision is unit-tested. */
function closingIsStale(closingSince, now, staleMs) {
  const since = Number(closingSince) || 0;
  if (!since) return true;
  return (Number(now) - since) >= Number(staleMs);
}

/* R12-P1-01: classify the state of our tagged EXIT order in a FYERS order book, so stale-close recovery is
   idempotent — it must NOT submit a second SELL while the first is still working. Returns:
     "pending"  → an order with our tag is still transit/pending → do NOT resubmit; wait.
     "resolved" → our tagged order(s) are all terminal (filled/rejected) → safe to reconcile net position.
     "absent"   → no order with our tag → nothing outstanding → safe to reconcile/resubmit.
   A non-array book means we couldn't read it → "unknown" (caller treats like pending: never resubmit). */
function fyersTaggedExitState(orderBook, tag) {
  if (!tag) return "absent";
  if (!Array.isArray(orderBook)) return "unknown";
  const ours = orderBook.filter((o) => String((o && o.orderTag) || "") === String(tag));
  if (!ours.length) return "absent";
  for (const o of ours) { const c = classifyFyersOrder(o); if (c.pending && !c.rejected) return "pending"; }
  return "resolved";
}

/* R13-P1-01: the exit-lifecycle decisions, made PURE so "at most one active SELL" is unit-tested rather
   than scattered across engine branches.
   exitOutcomeAction(r): map a placeExitOrder result to the managed-position action —
     "close" = fully flat/filled; "hold" = order still WORKING (keep "closing" + same tag, never resubmit);
     "retry" = terminal partial/unfilled (reopen and sell only the remainder with a fresh tag).
   exitPreflightAction(exState): before firing a NEW exit, given the prior tagged order's state —
     "wait" = a prior order may still be live (pending/unknown) → do NOT submit another; "fire" = terminal
     or absent → safe to submit a fresh exit. */
function exitOutcomeAction(r) {
  r = r || {};
  if (r.filled === true || r.alreadyFlat === true) return "close";
  if (r.pending === true) return "hold";
  return "retry";
}
function exitPreflightAction(exState) {
  return (exState === "pending" || exState === "unknown") ? "wait" : "fire";
}

/* ---- R16-P2-05/06 Delta reconciliation (PURE) ----
   Build a base-symbol → {long, short} size map from raw Delta positions, then judge each open real crypto
   journal row against the ACTUAL side + quantity Delta holds. Provenance rule (R16-P2-06): only rows tagged
   broker="delta" are auto-reconcilable; untagged rows are "broker unknown" and require explicit confirmation
   (never auto-closed on the mere absence of another broker's credential). */
const _normSym = (s) => String(s || "").toUpperCase().replace(/(USDT|USD|INR)$/i, "");
function buildDeltaBook(positions) {
  const book = new Map();
  for (const x of positions || []) {
    const size = Number(x && x.size);
    if (!size) continue;
    const base = _normSym((x.product_symbol) || (x.product && x.product.symbol) || "");
    const cur = book.get(base) || { long: 0, short: 0 };
    if (size > 0) cur.long += size; else cur.short += Math.abs(size);
    book.set(base, cur);
  }
  return book;
}
function deltaHoldsCover(trade, book) {
  const b = book.get(_normSym(trade && trade.sym));
  if (!b) return false;
  const isShort = String(trade.side || "").toUpperCase() === "SELL" || trade.short === true;
  const have = isShort ? b.short : b.long;
  const need = Math.abs(Number(trade.qty) || 0);
  return have > 0 && (need <= 0 || have + 1e-9 >= need);
}
/* Partition open real crypto rows into {phantomDelta (auto-closable), phantomUnknown (needs confirm)}.
   Round18-6 / R17-P2-04: the broker's held quantity is ALLOCATED across journal rows, not compared to each
   row independently. If Delta holds 1 BTC long and the journal has two open 1-BTC-long rows, only ONE is
   covered — the other is a phantom. We walk a mutable copy of the book, sort deterministically (oldest,
   largest first) and DECREMENT the available long/short pool as each row is matched; whatever the pool can't
   cover is phantom. */
function deltaReconcilePlan(openCryptoRealTrades, book) {
  const deltaTagged = [], untagged = [];
  for (const t of openCryptoRealTrades || []) {
    const tag = String((t && t.broker) || "").trim().toLowerCase();
    if (tag === "delta") deltaTagged.push(t);
    else if (!tag) untagged.push(t);
    // rows tagged to another broker are ignored entirely
  }
  // Mutable pool copy — allocated across BOTH tagged and untagged rows (tagged first, so a limited broker
  // holding is credited to attributable rows before ambiguous ones).
  const pool = new Map();
  for (const [k, v] of book) pool.set(k, { long: v.long, short: v.short });
  const isShort = (t) => String(t.side || "").toUpperCase() === "SELL" || t.short === true;
  const sortRows = (rows) => rows.slice().sort((a, b) => (a.entryAt || 0) - (b.entryAt || 0) || (Math.abs(Number(b.qty) || 0) - (Math.abs(Number(a.qty) || 0))));
  const allocate = (rows) => {
    const phantom = [];
    for (const t of sortRows(rows)) {
      const p = pool.get(_normSym(t.sym));
      const need = Math.abs(Number(t.qty) || 0);
      const side = isShort(t) ? "short" : "long";
      if (p && p[side] > 0 && (need <= 0 || p[side] + 1e-9 >= need)) {
        p[side] -= (need > 0 ? need : p[side]);        // covered — consume from the pool
      } else {
        phantom.push(t);                               // pool can't cover it → phantom
      }
    }
    return phantom;
  };
  return { phantomDelta: allocate(deltaTagged), phantomUnknown: allocate(untagged) };
}

/* R27-P1-03 / C02 (pure): confirm each Matrix-managed OPEN position is present at the broker with at least the
   tracked quantity. `positions` = [{symbol|brokerSym, qty}] for ONE broker; `held` = that broker's portfolio
   snapshot [{sym, qty}]. Returns { ok, verified, shortfall }. Fails closed on the FIRST position the broker
   can't confirm (a shortfall means the position was reduced/closed at the broker, or never truly filled). */
function normUnlockSym(s) { return String(s || "").toUpperCase().replace(/^NSE:/, "").replace(/-EQ$/, "").replace(/(USDT|USD|INR)$/i, "").replace(/[^A-Z0-9]/g, ""); }
// Direction of a MANAGED row: an explicit short flag / SELL side, or a negative tracked qty, is a SHORT.
function _posDir(p) { return (p.short === true || String(p.side || "").toUpperCase() === "SELL" || Number(p.qty) < 0) ? "short" : "long"; }
/* Confirm every managed OPEN position is live at the broker with the SAME DIRECTION and enough quantity —
   CONSUMING broker quantity as it goes. Fixes two holes: (1) the broker lot is decremented per match, so two
   tracked rows of 10 cannot both clear against a single broker holding of 10; (2) direction is respected via
   the SIGN of the broker quantity (>=0 long, <0 short), so a tracked long can never be covered by a broker
   short (or vice-versa). Fails closed on the FIRST row the broker can't cover in the right direction. */
function verifyManagedAgainstBroker(positions, held) {
  // Broker pool keyed by (symbol, direction) with consumable magnitude. Broker qty sign = direction.
  const pool = new Map();
  for (const h of (held || [])) {
    const q = Number(h.qty) || 0; if (q === 0) continue;
    const key = `${normUnlockSym(h.sym)}|${q >= 0 ? "long" : "short"}`;
    pool.set(key, (pool.get(key) || 0) + Math.abs(q));
  }
  let verified = 0;
  for (const p of (positions || [])) {
    const want = Math.abs(Number(p.qty) || 0);
    if (want <= 0) continue;
    const dir = _posDir(p);
    const key = `${normUnlockSym(p.symbol || p.brokerSym)}|${dir}`;
    const avail = pool.get(key) || 0;
    if (avail + 1e-9 < want * 0.999) {
      return { ok: false, verified, shortfall: { sym: p.symbol || p.brokerSym, dir, tracked: want, broker: avail } };
    }
    pool.set(key, avail - want);   // CONSUME — a later tracked row can't reuse the same broker quantity
    verified++;
  }
  // ORPHAN broker exposure: any broker quantity LEFT in the pool after consuming every managed position is
  // exposure the broker holds that Matrix does not track (e.g. an orphaned fill from a lost order). The caller
  // decides whether to block on it (strict managed accounts) or just surface it (accounts with manual holdings).
  const orphans = [];
  for (const [key, qty] of pool.entries()) {
    if (qty > 1e-9) { const [sym, dir] = key.split("|"); orphans.push({ sym, dir, qty }); }
  }
  return { ok: true, verified, shortfall: null, orphans };
}

/* M05 — ORPHAN CORRELATION. An orphan is broker exposure Matrix doesn't track; when the account also has
   unresolved order attempts, the orphan is almost certainly the fill a lost/ambiguous order left behind. This
   pure helper picks the unresolved attempt that BEST explains a given orphan so the reconcile/unlock message can
   name the exact order (id + tag) instead of a generic "untracked exposure". Match rules, in priority order:
   same broker (or attempt broker unknown) → same normalized symbol → same direction (BUY⇒long, SELL⇒short;
   an attempt with no side matches either) → quantity closest to the orphan's (attempt qty ≥ orphan preferred).
   Returns the matched attempt (with a `match` note) or null when nothing plausibly explains it. */
function correlateOrphanToAttempt(orphan, attempts, broker = null) {
  if (!orphan) return null;
  const oSym = normUnlockSym(orphan.sym);
  const oDir = orphan.dir === "short" ? "short" : "long";
  const oQty = Math.abs(Number(orphan.qty) || 0);
  let best = null, bestScore = -1;
  for (const a of (attempts || [])) {
    if (!a) continue;
    if (broker && a.broker && String(a.broker) !== String(broker)) continue;   // different broker ⇒ not this one
    if (normUnlockSym(a.symbol || a.sym) !== oSym) continue;                     // symbol must match
    const aSideRaw = String(a.side || "").toUpperCase();
    const aDir = aSideRaw === "SELL" ? "short" : (aSideRaw === "BUY" ? "long" : null);
    if (aDir && aDir !== oDir) continue;                                         // known-but-opposite ⇒ not this one
    const aQty = Math.abs(Number(a.qty) || 0);
    // Score: exact broker + exact dir + quantity proximity. Prefer an attempt qty that covers the orphan.
    let score = 100;
    if (broker && a.broker === broker) score += 20;
    if (aDir === oDir) score += 20;
    if (aQty > 0 && oQty > 0) score += Math.max(0, 20 - Math.min(20, (Math.abs(aQty - oQty) / oQty) * 20));
    if (aQty + 1e-9 >= oQty) score += 10;                                        // covers the orphan quantity
    if (score > bestScore) { bestScore = score; best = a; }
  }
  if (!best) return null;
  return { attemptId: best.id, orderTag: best.orderTag || null, broker: best.broker || broker || null, symbol: best.symbol || best.sym || orphan.sym, side: best.side || null, qty: best.qty != null ? Number(best.qty) : null, orphan };
}

/* R31-P2-07 — ATTEMPT-TIMESTAMP GATE for declaring a FYERS order ABSENT.
   FYERS' order book / tradebook are day/window-scoped and can lag right after placement — a just-sent order can be
   momentarily missing from EVERY read even though the broker did receive it. So "not found anywhere" is only
   trustworthy once the attempt is OLD ENOUGH that broker-side propagation lag can't still be hiding it. This pure
   predicate decides whether it is safe to conclude ABSENT (→ CANCELLED). It is deliberately conservative:
     • no createdAt / unparseable            → NOT safe (unknown age ⇒ stay locked, retry a later sweep);
     • createdAt in the future / now         → NOT safe (clock skew ⇒ treat as too-recent);
     • age < minAgeMs (default 2 min)         → NOT safe (still inside the lag window);
     • age ≥ minAgeMs                         → safe to declare absent (all live reads already checked by the caller).
   The caller only reaches this after order book + tradebook + positions + holdings were ALL readable and none
   referenced the order AND a broker order id exists — this gate adds the time dimension the review asked for. */
function safeToDeclareAbsent(attempt, { now = Date.now(), minAgeMs = 120000 } = {}) {
  const created = attempt && (attempt.createdAt ?? attempt.created_at);
  const ts = Number(created);
  if (!Number.isFinite(ts) || ts <= 0) return false;   // unknown age ⇒ never conclude absent
  const age = now - ts;
  if (age < 0) return false;                            // future timestamp (clock skew) ⇒ treat as too recent
  return age >= (Number(minAgeMs) || 0);
}

module.exports = { parseDeltaTs, brokerFillTsMs, correlateOrphanToAttempt, safeToDeclareAbsent, hasClientOrderId, pageConclusive, redirectAllowed, redirectBindingOk, classifyDeltaOrder, classifyFyersOrder, fyersOrderTag, hasFyersOrderTag, attributeFyersFills, fyersExitPlan, closingIsStale, fyersTaggedExitState, exitOutcomeAction, exitPreflightAction, buildDeltaBook, deltaHoldsCover, deltaReconcilePlan, verifyManagedAgainstBroker };
