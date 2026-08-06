"use strict";
/* orderTypes.js — canonical order-type + product normalization, validation, and per-broker
 * native parameter mapping for the manual + automated order paths.
 *
 * Canonical ORDER TYPES (what the UI offers everywhere: manual, screener auto-buy, automate, smart):
 *   MARKET   — fill at the best available price now.
 *   LIMIT    — rest at a price; needs limitPrice.
 *   SL       — stop-loss (market): a trigger that becomes a MARKET order once price crosses triggerPrice.
 *   SL-L     — stop-limit: a trigger that becomes a LIMIT order (needs triggerPrice AND limitPrice).
 *   BRACKET  — an entry (market/limit) PLUS an attached target (take-profit) and stop-loss that Matrix's
 *              own verified exit engine manages reduce-only (works on every broker + paper, and supports
 *              a trailing stop). We deliberately DON'T use brokers' native "BO" products — several have
 *              deprecated them (e.g. Zerodha) — a Matrix-managed bracket is uniform and already fill-verified.
 *
 * Canonical PRODUCT (position type):
 *   INTRADAY — auto-square-off same day (MIS/INTRADAY).
 *   NRML     — carry-forward derivatives / margin (NRML/MARGIN).
 *   CNC      — delivery / cash-and-carry (equity delivery, DELIVERY).
 *
 * Trailing stop is expressed as tslPct on the managed exit (server-side, in strategyEngine.priceExitFired)
 * — this module only validates it; the engine ratchets it.
 *
 * Pure: no I/O. Every function is deterministic and unit-tested.
 */

const ORDER_TYPES = ["MARKET", "LIMIT", "SL", "SL-L", "BRACKET"];
const PRODUCTS = ["INTRADAY", "NRML", "CNC"];

/* Normalize a caller order-type string to one of ORDER_TYPES. Anything unrecognized falls back to MARKET
   (the safest default — it can't rest unfilled waiting on a price the user didn't intend). */
function normalizeOrderType(t) {
  const s = String(t == null ? "" : t).trim().toUpperCase().replace(/\s+/g, "");
  if (s === "LIMIT" || s === "LMT" || s === "L") return "LIMIT";
  if (s === "BRACKET" || s === "BO" || s === "BRACKETORDER") return "BRACKET";
  // Stop-limit variants (a stop that becomes a LIMIT order): SL-L, SLL, SL_LIMIT, STOP-LIMIT, STOPLIMIT, SL-LIMIT
  if (s === "SL-L" || s === "SLL" || s === "SL_L" || s === "SL-LIMIT" || s === "SLLIMIT" || s === "STOP-LIMIT" || s === "STOPLIMIT" || s === "STOP_LIMIT") return "SL-L";
  // Stop-loss (market): SL, SL-M, SLM, STOPLOSS, STOP, STOP-LOSS
  if (s === "SL" || s === "SL-M" || s === "SLM" || s === "SL_M" || s === "STOP" || s === "STOPLOSS" || s === "STOP-LOSS" || s === "STOP_LOSS" || s === "STOPLOSSMARKET" || s === "STOP_LOSS_MARKET") return "SL";
  if (s === "MARKET" || s === "MKT" || s === "M") return "MARKET";
  return "MARKET";
}

/* Normalize a caller product string to INTRADAY | NRML | CNC. Unknown → CNC (delivery, the least-leveraged
   default — an accidental leveraged/intraday product is worse than an accidental delivery product). */
function normalizeProduct(p) {
  const s = String(p == null ? "" : p).trim().toUpperCase();
  if (s === "INTRADAY" || s === "MIS" || s === "INTRA") return "INTRADAY";
  if (s === "NRML" || s === "MARGIN" || s === "NORMAL" || s === "CARRYFORWARD" || s === "CARRY") return "NRML";
  if (s === "CNC" || s === "DELIVERY" || s === "CASH" || s === "DELIVERY_CNC") return "CNC";
  return "CNC";
}

/* Does this order type behave like a LIMIT for the fill-or-cancel deadline (waits for a price/trigger)
   vs a MARKET (must fill promptly)? SL-L and LIMIT wait; MARKET, SL (becomes market) and BRACKET's entry
   are prompt. Returns the lowercase token orderDeadline.normalizeOrderType understands. */
function deadlineType(orderType) {
  const t = normalizeOrderType(orderType);
  return t === "LIMIT" || t === "SL-L" ? "limit" : "market";
}

/* The underlying ENTRY order type a BRACKET places (market/limit). A bracket is "enter, then Matrix manages
   the protective legs", so its entry is a plain MARKET (default) or LIMIT if the user set a limit price. */
function bracketEntryType(intent) {
  return Number(intent && intent.limitPrice) > 0 ? "LIMIT" : "MARKET";
}

/* Validate a full order intent. Returns { ok:true } or { ok:false, error }.
   intent: { orderType, product, side, limitPrice, triggerPrice, target, stopLoss, tslPct, market } */
function validateOrderIntent(intent = {}) {
  const orderType = normalizeOrderType(intent.orderType);
  const side = String(intent.side || "").trim().toUpperCase();
  if (!["BUY", "SELL"].includes(side)) return { ok: false, error: "side must be BUY or SELL." };

  const limitPrice = Number(intent.limitPrice);
  const triggerPrice = Number(intent.triggerPrice);
  const target = Number(intent.target);
  const stopLoss = Number(intent.stopLoss);
  const tslPct = Number(intent.tslPct);

  if (orderType === "LIMIT") {
    if (!(limitPrice > 0)) return { ok: false, error: "A Limit order needs a limit price greater than 0." };
  }
  if (orderType === "SL") {
    if (!(triggerPrice > 0)) return { ok: false, error: "A Stop-Loss order needs a trigger price greater than 0." };
  }
  if (orderType === "SL-L") {
    if (!(triggerPrice > 0)) return { ok: false, error: "A Stop-Limit order needs a trigger price greater than 0." };
    if (!(limitPrice > 0)) return { ok: false, error: "A Stop-Limit order needs a limit price greater than 0." };
    /* For a BUY stop-limit the limit must be at/above the trigger; for a SELL it must be at/below — otherwise
       it can never fill after triggering. Enforce the sane relationship rather than send a dead order. */
    if (side === "BUY" && limitPrice < triggerPrice) return { ok: false, error: "For a Buy Stop-Limit, the limit price must be at or above the trigger price." };
    if (side === "SELL" && limitPrice > triggerPrice) return { ok: false, error: "For a Sell Stop-Limit, the limit price must be at or below the trigger price." };
  }
  if (orderType === "BRACKET") {
    if (!(target > 0) && !(stopLoss > 0) && !(tslPct > 0)) {
      return { ok: false, error: "A Bracket order needs at least a target, a stop-loss, or a trailing stop." };
    }
  }
  // Trailing stop percent, wherever supplied, must be a sane positive percentage.
  if (intent.tslPct != null && intent.tslPct !== "" && !(tslPct > 0 && tslPct < 100)) {
    return { ok: false, error: "Trailing stop must be a percentage between 0 and 100." };
  }
  return { ok: true };
}

/* Whether a BRACKET is being requested — the route turns this into "place entry + arm managed SL/TP/trailing". */
function isBracket(orderType) { return normalizeOrderType(orderType) === "BRACKET"; }

/* ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
   R41-P1-02 / R41-P1-03 — SERVER-ENFORCED broker × order-type capability matrix.

   A broker's order route previously advertised Limit/SL/SL-L/Bracket "across all 6 brokers", but (a) several brokers
   have no tested stale-order CANCEL adapter, so a resting order that never fills couldn't be swept by the fill-or-cancel
   deadline, and (b) unsupported combos silently fell back to MARKET. Both are real-money hazards. This matrix is the
   single source of truth the route enforces: an unsupported (broker, order-type) combination is REJECTED (never a
   MARKET fallback), and a RESTING/trigger order is only offered on a broker that can also cancel a stale one.
   ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */

// Brokers with a TESTED unattended cancel adapter (must stay in sync with server.js cancelBrokerOrder).
const CANCEL_CAPABLE_BROKERS = ["delta", "fyers", "dhan", "indmoney"];

// Native (broker-API-level) order-type support, from each buildBrokerOrderParams branch. A broker absent here can
// place MARKET only. This is what the broker's API accepts — cancel capability is layered on separately below.
const NATIVE_ORDER_TYPES = {
  delta:    ["MARKET", "LIMIT", "SL", "SL-L"],
  fyers:    ["MARKET", "LIMIT", "SL", "SL-L"],
  dhan:     ["MARKET", "LIMIT", "SL", "SL-L"],
  indmoney: ["MARKET", "LIMIT", "SL", "SL-L"],
  zerodha:  ["MARKET", "LIMIT", "SL", "SL-L"],
  groww:    ["MARKET", "LIMIT", "SL", "SL-L"],
  coindcx:  ["MARKET", "LIMIT"],
};

// Order types that REST at the broker waiting on a price/trigger (so they need a cancel adapter to be swept if stale).
const RESTING_TYPES = new Set(["LIMIT", "SL", "SL-L"]);

function isCancelCapable(broker) { return CANCEL_CAPABLE_BROKERS.includes(String(broker || "").toLowerCase()); }

/* The canonical order types a broker may ACTUALLY place for real money: its native support, with resting/trigger
   types withheld unless it also has a cancel adapter. BRACKET is always available (its protective legs are
   Matrix-managed, reduce-only + fill-verified on every broker); its ENTRY leg is constrained separately below. */
function supportedOrderTypes(broker) {
  const b = String(broker || "").toLowerCase();
  const native = NATIVE_ORDER_TYPES[b] || ["MARKET"];
  const canCancel = isCancelCapable(b);
  const out = native.filter((t) => !RESTING_TYPES.has(t) || canCancel);
  if (!out.includes("MARKET")) out.unshift("MARKET");
  out.push("BRACKET");
  return out;
}

/* SERVER-SIDE ENFORCEMENT: may `broker` place this intent's order type? Unsupported ⇒ { ok:false } (the route returns
   400 — NEVER a MARKET fallback). A BRACKET with a LIMIT entry on a non-cancellable broker is rejected (the entry
   could rest uncancellable); a market-entry bracket is always fine. */
function validateBrokerOrderType(broker, intent = {}) {
  const b = String(broker || "").toLowerCase();
  const ot = normalizeOrderType(intent.orderType);
  const canCancel = isCancelCapable(b);
  if (ot === "BRACKET") {
    if (bracketEntryType(intent) === "LIMIT" && !canCancel) {
      return { ok: false, error: `${b} can't place a limit-entry bracket order (no certified stale-order cancellation). Use a market entry.` };
    }
    return { ok: true };
  }
  const supported = supportedOrderTypes(b);
  if (supported.includes(ot)) return { ok: true };
  const native = NATIVE_ORDER_TYPES[b] || ["MARKET"];
  if (RESTING_TYPES.has(ot) && native.includes(ot) && !canCancel) {
    return { ok: false, error: `${b} does not yet support ${ot} orders (no certified stale-order cancellation). Use a Market order.` };
  }
  return { ok: false, error: `${b} does not support ${ot} orders. Supported here: ${supported.join(", ")}.` };
}

/* Per-broker native order-type field mapping. Given the canonical intent, returns the fields to MERGE into
   that broker's order body so a Limit / Stop-Loss / Stop-Limit is placed natively (not silently downgraded
   to Market). BRACKET resolves to its underlying entry type (market/limit) — the protective legs are armed
   separately by the route via the managed-exit engine.
   crypto:true means a crypto broker (Delta/CoinDCX): spot brokers get market/limit only; stop handling is
   Matrix-managed, so callers should treat SL/SL-L as { managed:true } rather than a native stop field.
   Returns: { fields, managed } where `fields` merges into the broker body and `managed` requests a
   Matrix-managed protective stop when the broker can't place the native stop itself. */
function buildBrokerOrderParams(broker, intent = {}) {
  const b = String(broker || "").toLowerCase();
  let orderType = normalizeOrderType(intent.orderType);
  const product = normalizeProduct(intent.product);
  const limitPrice = Number(intent.limitPrice) || 0;
  const triggerPrice = Number(intent.triggerPrice) || 0;
  // A BRACKET is entered as its underlying market/limit type; protection is managed by the route.
  const managedFromBracket = orderType === "BRACKET";
  if (orderType === "BRACKET") orderType = bracketEntryType(intent);

  const price = limitPrice > 0 ? limitPrice : 0;

  switch (b) {
    case "fyers": {
      // FYERS type: 1=Limit, 2=Market, 3=Stop (SL-Market), 4=StopLimit. productType CNC|INTRADAY|MARGIN.
      const typeMap = { MARKET: 2, LIMIT: 1, SL: 3, "SL-L": 4 };
      return {
        fields: {
          type: typeMap[orderType] || 2,
          productType: product === "CNC" ? "CNC" : (product === "NRML" ? "MARGIN" : "INTRADAY"),
          limitPrice: (orderType === "LIMIT" || orderType === "SL-L") ? Number(price) : 0,
          stopPrice: (orderType === "SL" || orderType === "SL-L") ? Number(triggerPrice) : 0,
        },
        managed: managedFromBracket,
      };
    }
    case "zerodha": {
      // Kite order_type MARKET|LIMIT|SL|SL-M; product CNC|MIS|NRML; price + trigger_price.
      const otMap = { MARKET: "MARKET", LIMIT: "LIMIT", SL: "SL-M", "SL-L": "SL" };
      const f = {
        order_type: otMap[orderType] || "MARKET",
        product: product === "CNC" ? "CNC" : (product === "NRML" ? "NRML" : "MIS"),
      };
      if (orderType === "LIMIT" || orderType === "SL-L") f.price = String(price);
      if (orderType === "SL" || orderType === "SL-L") f.trigger_price = String(triggerPrice);
      return { fields: f, managed: managedFromBracket };
    }
    case "dhan": {
      // Dhan orderType MARKET|LIMIT|STOP_LOSS|STOP_LOSS_MARKET; productType CNC|INTRADAY|MARGIN; price+triggerPrice.
      const otMap = { MARKET: "MARKET", LIMIT: "LIMIT", SL: "STOP_LOSS_MARKET", "SL-L": "STOP_LOSS" };
      return {
        fields: {
          orderType: otMap[orderType] || "MARKET",
          productType: product === "CNC" ? "CNC" : (product === "NRML" ? "MARGIN" : "INTRADAY"),
          price: (orderType === "LIMIT" || orderType === "SL-L") ? String(price) : "",
          triggerPrice: (orderType === "SL" || orderType === "SL-L") ? String(triggerPrice) : "",
        },
        managed: managedFromBracket,
      };
    }
    case "groww": {
      // Groww order_type MARKET|LIMIT|SL|SL_M; product CNC|MIS|NRML; price + trigger_price.
      const otMap = { MARKET: "MARKET", LIMIT: "LIMIT", SL: "SL_M", "SL-L": "SL" };
      const f = {
        order_type: otMap[orderType] || "MARKET",
        product: product === "CNC" ? "CNC" : (product === "NRML" ? "NRML" : "MIS"),
      };
      if (orderType === "LIMIT" || orderType === "SL-L") f.price = Number(price);
      if (orderType === "SL" || orderType === "SL-L") f.trigger_price = Number(triggerPrice);
      return { fields: f, managed: managedFromBracket };
    }
    case "indmoney": {
      // INDstocks order_type MARKET|LIMIT|SL|SL_M; product CNC|INTRADAY; price + trigger_price.
      const otMap = { MARKET: "MARKET", LIMIT: "LIMIT", SL: "SL_M", "SL-L": "SL" };
      const f = {
        order_type: otMap[orderType] || "MARKET",
        product: product === "CNC" ? "CNC" : "INTRADAY",
      };
      if (orderType === "LIMIT" || orderType === "SL-L") f.price = Number(price);
      if (orderType === "SL" || orderType === "SL-L") f.trigger_price = Number(triggerPrice);
      return { fields: f, managed: managedFromBracket };
    }
    case "coindcx": {
      // CoinDCX spot supports market_order | limit_order only. A standalone STOP ENTRY (SL/SL-L) can't be
      // placed natively and there's no entry-trigger engine — so it's UNSUPPORTED (the route rejects it with a
      // clear message rather than silently entering at market). A BRACKET's protective legs are exit-side and
      // ARE handled by the Matrix-managed exit engine, so bracket is fine.
      const native = orderType === "LIMIT" ? "limit_order" : "market_order";
      const f = { order_type: native };
      if (orderType === "LIMIT" && price > 0) f.price_per_unit = Number(price);
      const unsupported = orderType === "SL" || orderType === "SL-L";
      return { fields: f, managed: managedFromBracket, unsupported };
    }
    case "delta": {
      // Delta supports NATIVE stop orders via stop_order_type + stop_price. SL = stop that becomes a market
      // order at the trigger; SL-L = stop that becomes a limit order (needs limit_price too). BRACKET's entry
      // is a plain market/limit; its protective legs are armed separately (native Delta bracket + managed trail).
      const f = {};
      if (orderType === "SL") {
        f.order_type = "market_order";
        f.stop_order_type = "stop_loss_order";
        f.stop_price = String(triggerPrice);
      } else if (orderType === "SL-L") {
        f.order_type = "limit_order";
        f.limit_price = String(price);
        f.stop_order_type = "stop_loss_order";
        f.stop_price = String(triggerPrice);
      } else {
        f.order_type = orderType === "LIMIT" ? "limit_order" : "market_order";
        if (orderType === "LIMIT" && price > 0) f.limit_price = String(price);
      }
      return { fields: f, managed: managedFromBracket };
    }
    default: {
      // Unknown broker: safest is market + managed protection for any non-market request.
      const managed = managedFromBracket || orderType === "SL" || orderType === "SL-L";
      return { fields: {}, managed };
    }
  }
}

module.exports = {
  ORDER_TYPES, PRODUCTS,
  normalizeOrderType, normalizeProduct, deadlineType, bracketEntryType,
  validateOrderIntent, isBracket, buildBrokerOrderParams,
  // R41-P1-02/03 — capability matrix + server-side enforcement.
  CANCEL_CAPABLE_BROKERS, NATIVE_ORDER_TYPES, isCancelCapable, supportedOrderTypes, validateBrokerOrderType,
};
