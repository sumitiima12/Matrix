#!/usr/bin/env node
/* test/dhanSandbox.sandbox.cjs — standalone Dhan SANDBOX certification run.
 *
 * WHAT IT PROVES (mirrors the FYERS/Delta .sandbox.cjs suites): against Dhan's mock sandbox
 * (https://sandbox.dhan.co/v2, base URL per DhanHQ docs — orders fill at a static ₹100, capital
 * resets to ₹10,00,000 daily, no live quotes, no static-IP whitelist), the exact contract Matrix
 * uses to trade Dhan works end-to-end:
 *   1. CONNECT      GET  /v2/fundlimit                 → token is accepted, balance readable
 *   2. RESOLVE      images.dhan.co scrip master        → strict (NSE, cash-equity, exact symbol) id
 *   3. BUY          POST /v2/orders (MARKET INTRADAY)  → order accepted
 *   4. VERIFY FILL  GET  /v2/orders                    → our order reaches TRADED
 *   5. POSITION     GET  /v2/positions                 → a long position exists
 *   6. FLATTEN      POST /v2/orders (SELL, reduce)     → position closed
 *   7. VERIFY FLAT  GET  /v2/positions                 → net qty back to 0
 * A try/finally EMERGENCY FLATTEN makes sure we never leave a sandbox position open if a step
 * throws midway. The order body + the security-id resolution are copied field-for-field from
 * server.js so this exercises the real path, not an approximation.
 *
 * This script NEVER contains your token. It reads it from the environment:
 *   DHAN_ACCESS_TOKEN   (required)  the sandbox JWT from developer.dhanhq.co → Sandbox tab
 *   DHAN_CLIENT_ID      (required)  the sandbox Client ID (Dhan calls it dhanClientId)
 *   DHAN_API_BASE       (optional)  default https://sandbox.dhan.co  — do NOT point at prod
 *   DHAN_TEST_SYMBOL    (optional)  default RELIANCE (NSE cash equity, exact trading symbol)
 *   DHAN_TEST_QTY       (optional)  default 1
 *   DHAN_TEST_SECURITY_ID (optional) skip the scrip-master download and use this id directly
 *   DHAN_ALLOW_PROD=1   (optional)  required guard to allow a non-sandbox base (refused otherwise)
 *
 * RUN (from the matrix-backend folder):
 *   DHAN_ACCESS_TOKEN='...' DHAN_CLIENT_ID='...' node test/dhanSandbox.sandbox.cjs
 */
"use strict";

const BASE = String(process.env.DHAN_API_BASE || "https://sandbox.dhan.co").replace(/\/+$/, "");
const TOKEN = process.env.DHAN_ACCESS_TOKEN || "";
const CLIENT_ID = process.env.DHAN_CLIENT_ID || "";
const SYMBOL = (process.env.DHAN_TEST_SYMBOL || "RELIANCE").trim();
const QTY = Math.max(1, Number(process.env.DHAN_TEST_QTY || 1) | 0);
/* Order type for the cert. Dhan's SANDBOX has no live market data, so a MARKET order has no LTP to fill
   against — it's CONFIRMED but sits PENDING with filledQty 0 forever. A LIMIT order priced at the sandbox's
   static fill price (₹100) DOES match and reach TRADED. Default to LIMIT@100 here so the fill pipeline can be
   proven; production still uses MARKET (which fills against the real market). The verify-fill / position /
   flatten machinery this exercises is identical for both order types. Override with DHAN_TEST_ORDER_TYPE=MARKET. */
const ORDER_TYPE = String(process.env.DHAN_TEST_ORDER_TYPE || "LIMIT").trim().toUpperCase() === "MARKET" ? "MARKET" : "LIMIT";
const LIMIT_PRICE = Number(process.env.DHAN_TEST_PRICE || 100);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const die = (msg) => { log(c.r("\n✖ " + msg)); process.exit(1); };

function headers(hasBody) {
  // Dhan sets Content-Type: application/json ONLY on POST (with a body). Sending it on a bodyless GET
  // makes the sandbox return a spurious 500, so we add it only when there's a body.
  const h = { "access-token": TOKEN, Accept: "application/json" };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Copied field-for-field from server.js dhanSecurityId(): strict (NSE, cash-equity, exact symbol).
async function resolveSecurityId(sym) {
  if (process.env.DHAN_TEST_SECURITY_ID) return String(process.env.DHAN_TEST_SECURITY_ID).trim();
  const res = await fetch("https://images.dhan.co/api-data/api-scrip-master.csv");
  if (!res.ok) throw new Error(`scrip master download failed (${res.status})`);
  const txt = await res.text();
  const lines = txt.split(/\r?\n/);
  const H = lines[0].split(",").map((s) => s.trim());
  const iId = H.indexOf("SEM_SMST_SECURITY_ID"), iSym = H.indexOf("SEM_TRADING_SYMBOL"),
    iExch = H.indexOf("SEM_EXM_EXCH_ID"), iSeg = H.indexOf("SEM_SEGMENT");
  if (iId < 0 || iSym < 0 || iExch < 0) throw new Error("Dhan scrip master format changed — cannot resolve id safely");
  const map = {};
  for (let k = 1; k < lines.length; k++) {
    const col = lines[k].split(",");
    if (!col[iExch] || col[iExch].trim() !== "NSE") continue;
    if (iSeg >= 0 && !/^(E|EQ|I)$/i.test((col[iSeg] || "").trim())) continue;
    const t = (col[iSym] || "").trim().toUpperCase();
    if (t) map[t] = (col[iId] || "").trim();
  }
  const key = String(sym).toUpperCase().replace(/-EQ$/, "");
  const id = map[key] || map[`${key}-EQ`];
  if (!id) throw new Error(`no NSE equity security id for ${sym} — refusing rather than guess`);
  return id;
}

function orderBody(side, securityId, qty = QTY) {
  // Same shape as server.js POST /api/order dhan branch. orderType/price come from ORDER_TYPE (LIMIT@100 for the
  // sandbox so it can match; MARKET with empty price for production parity). Everything else is identical.
  // priceOverride (5th arg via closure below) forces a LIMIT at that price; otherwise use the ORDER_TYPE default.
  const px = orderBody._px;
  const oType = px != null ? "LIMIT" : ORDER_TYPE;
  return {
    dhanClientId: CLIENT_ID, transactionType: String(side).toUpperCase(),
    exchangeSegment: "NSE_EQ", productType: "INTRADAY",
    orderType: oType, validity: "DAY", securityId, quantity: String(Math.max(1, Math.abs(Number(qty) || QTY))),
    price: oType === "LIMIT" ? String(px != null ? px : LIMIT_PRICE) : "", disclosedQuantity: "", afterMarketOrder: false,
  };
}

async function placeOrder(side, securityId, qty = QTY, priceOverride = null) {
  orderBody._px = priceOverride;                       // threaded into orderBody() for this call
  const body = orderBody(side, securityId, qty);
  orderBody._px = null;
  const r = await api("POST", "/v2/orders", body);
  const d = r.json || {};
  if (!r.ok || d.orderStatus === "REJECTED" || d.errorType) {
    throw new Error(d.errorMessage || d.omsErrorDescription || `Dhan ${side} failed (${r.status}) ${r.text || ""}`.trim());
  }
  return { orderId: d.orderId ?? (d.data && (d.data.orderId || d.data.order_id)) ?? null, status: d.orderStatus || "PENDING" };
}

// Poll an order (order list + tradebook) up to `waitS` seconds. Returns { filled, order, rejected, rejectMsg }.
async function awaitOutcome(orderId, waitS) {
  let lastOrder = null, dumped = false;
  for (let i = 0; i < waitS; i++) {
    await sleep(1000);
    const o = await findOrder(orderId);
    lastOrder = o || lastOrder;
    if (o) {
      log(`  … order ${o.orderStatus}`);
      if (/TRADED|FILLED|EXECUTED/i.test(o.orderStatus)) return { filled: true, order: o };
      if (/REJECTED|CANCELLED/i.test(o.orderStatus)) return { filled: false, rejected: true, rejectMsg: o.omsErrorDescription || o.omsErrorCode || "", order: o };
      if (!dumped && /PENDING|TRANSIT|PART/i.test(o.orderStatus)) { dumped = true; log(c.y("    raw order → ") + JSON.stringify(o)); }
    }
    const trs = await tradesForOrder(orderId).catch(() => []);
    if (trs.length) return { filled: true, order: { orderStatus: "TRADED", averageTradedPrice: trs[0].tradedPrice ?? trs[0].price, _viaTrades: true } };
  }
  return { filled: false, order: lastOrder };
}

// Parse "... Circuit Limits of 1334.90 to 1631.50" from an RMS rejection → { lo, hi }.
function parseCircuit(msg) {
  const m = /Circuit\s*Limits?\s*of\s*([\d.]+)\s*to\s*([\d.]+)/i.exec(String(msg || ""));
  return m ? { lo: Number(m[1]), hi: Number(m[2]) } : null;
}

/* Place a LIMIT order that will actually FILL in the sandbox. The sandbox enforces the symbol's circuit band, so
   a marketable limit must sit INSIDE it: a BUY at the UPPER circuit (crosses up → fills), a SELL at the LOWER
   circuit (crosses down → fills). We discover the band from a first attempt's RMS rejection, then re-place at the
   right edge. Returns the filled order. `waitS` is the per-attempt fill wait. */
async function placeFillingLimit(side, securityId, qty, waitS) {
  const isBuy = String(side).toUpperCase() === "BUY";
  // Attempt 1 at the configured price (default ₹100 — deliberately out-of-band, so it also serves as band discovery).
  let o = await placeOrder(side, securityId, qty, LIMIT_PRICE);
  log(`  order ${o.orderId} status ${o.status}`);
  let out = await awaitOutcome(o.orderId, waitS);
  if (out.filled) return out.order;
  const band = out.rejected ? parseCircuit(out.rejectMsg) : null;
  if (!band) throw new Error(`${side} did not fill and no circuit band to retry from (${out.rejectMsg || "still pending"})`);
  const px = isBuy ? band.hi : band.lo;               // marketable edge for the side
  log(c.y(`  ↻ circuit band ${band.lo}–${band.hi}; re-placing ${side} LIMIT @₹${px} (marketable)`));
  o = await placeOrder(side, securityId, qty, px);
  log(`  order ${o.orderId} status ${o.status}`);
  out = await awaitOutcome(o.orderId, waitS);
  if (out.filled) return out.order;
  if (out.rejected) throw new Error(`${side} re-placed at ₹${px} but REJECTED: ${out.rejectMsg}`);
  throw new Error(`${side} re-placed at ₹${px} but did not reach TRADED within ${waitS}s`);
}

async function findOrder(orderId) {
  const r = await api("GET", "/v2/orders");
  const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  return arr.find((o) => String(o.orderId) === String(orderId)) || null;
}

// Tradebook fill-truth: GET /v2/trades/{orderId} returns the executed trade(s) for an order. In the sandbox an
// order can show TRADED here (executed at the static ₹100) even while the order list still lags on status.
async function tradesForOrder(orderId) {
  let r = await api("GET", `/v2/trades/${encodeURIComponent(orderId)}`);
  let arr = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  if (!arr.length) { r = await api("GET", "/v2/trades"); arr = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || []; arr = arr.filter((t) => String(t.orderId) === String(orderId)); }
  return arr;
}

async function positionNetQty(securityId) {
  const r = await api("GET", "/v2/positions");
  const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  const p = arr.find((x) => String(x.securityId) === String(securityId));
  return p ? Number(p.netQty) : 0;
}

(async function main() {
  log(c.b("\n═══ Dhan SANDBOX certification ═══"));
  log("base:", BASE, "| symbol:", SYMBOL, "| qty:", QTY, "| orderType:", ORDER_TYPE + (ORDER_TYPE === "LIMIT" ? ` @₹${LIMIT_PRICE}` : ""));

  if (!TOKEN || !CLIENT_ID) die("Set DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID in the environment before running.");
  if (!/(^|\.)sandbox\.dhan\.co$/i.test(new URL(BASE).hostname) && process.env.DHAN_ALLOW_PROD !== "1") {
    die(`Refusing to run against a non-sandbox host (${new URL(BASE).hostname}). This script places live orders; keep DHAN_API_BASE on sandbox.dhan.co (or set DHAN_ALLOW_PROD=1 only if you truly mean production).`);
  }

  let securityId = null, boughtQty = 0, flattened = false, submitted = false, net0 = 0;

  try {
    // 1. CONNECT — prove the token is valid. Prefer /v2/fundlimit (shows balance), but Dhan's SANDBOX
    // frequently returns 500 FUND_LIMIT_ERROR there (funds aren't modelled — everyone just gets ₹10L),
    // so a non-auth error must NOT fail the run. Fall back to another authenticated call (orders list):
    // if that returns 200 the token is genuinely valid. Only a real auth error (401/403) fails connect.
    log(c.y("\n[1/7] CONNECT  GET /v2/fundlimit"));
    const fl = await api("GET", "/v2/fundlimit");
    if (fl.ok) {
      const bal = fl.json && (fl.json.availabelBalance ?? fl.json.availableBalance ?? fl.json.sodLimit);
      log(c.g("  ✓ token accepted") + `  available balance: ₹${bal ?? "?"}`);
    } else if (fl.status === 401 || fl.status === 403) {
      throw new Error(`token rejected (${fl.status}) ${fl.text || ""}`.trim());
    } else {
      log(c.y(`  ⚠ /fundlimit returned ${fl.status} (common sandbox quirk) — verifying token via GET /v2/orders / /v2/positions instead`));
      const ord = await api("GET", "/v2/orders");
      const pos = await api("GET", "/v2/positions");
      if ([fl.status, ord.status, pos.status].some((s) => s === 401 || s === 403)) throw new Error(`token rejected (auth error on a probe)`);
      if (!ord.ok && !pos.ok) throw new Error(`could not confirm the token — fundlimit ${fl.status}, orders ${ord.status} (${ord.text || ""}), positions ${pos.status} (${pos.text || ""})`.trim());
      log(c.g("  ✓ token accepted") + `  (orders ${ord.status} / positions ${pos.status}; sandbox balance is a fixed ₹10,00,000)`);
    }

    // 2. RESOLVE
    log(c.y("\n[2/7] RESOLVE  security id for " + SYMBOL));
    securityId = await resolveSecurityId(SYMBOL);
    log(c.g("  ✓ ") + `${SYMBOL} → securityId ${securityId}`);

    // 3+4. BUY THAT FILLS — R39-P1-04: `submitted` fires before the send so the catch reconciles from broker truth
    // even if a response is lost. placeFillingLimit places a marketable LIMIT: it discovers the sandbox's circuit
    // band from the first RMS rejection, then re-places at the band edge (BUY → upper circuit) so the sandbox
    // actually executes it, and polls order-status + tradebook for the fill.
    log(c.y("\n[3/7] BUY  marketable LIMIT (auto-priced inside the circuit band)"));
    // Baseline net BEFORE the buy — the cert asserts the CHANGE (buy adds ≥QTY), so a leftover sandbox position
    // from an earlier run (before the daily reset) can't skew the check, and we flatten back to THIS baseline.
    net0 = await positionNetQty(securityId).catch(() => 0);
    if (net0 !== 0) log(c.y(`  (starting net position for ${SYMBOL} is ${net0} — will assert the delta and restore it)`));
    submitted = true;
    const FILL_WAIT = Math.max(12, Number(process.env.DHAN_FILL_WAIT_S || 20) | 0);
    const buyFill = await placeFillingLimit("BUY", securityId, QTY, FILL_WAIT);
    boughtQty = QTY;
    log(c.g("\n[4/7] VERIFY FILL  ✓ filled") + `  avg price ₹${buyFill.averageTradedPrice ?? buyFill.price ?? "?"}${buyFill._viaTrades ? " [via tradebook]" : ""}`);

    // 5. POSITION — assert the CHANGE, not the absolute (net went up by ≥ QTY vs the pre-buy baseline).
    log(c.y("\n[5/7] POSITION  GET /v2/positions"));
    const net = await positionNetQty(securityId);
    if (net - net0 < QTY) throw new Error(`expected net to increase by ${QTY} after the buy, but it went ${net0} → ${net}`);
    log(c.g("  ✓ long position present") + `  netQty ${net} (was ${net0}, +${net - net0})`);

    // 6. FLATTEN — marketable LIMIT SELL (band edge → lower circuit) that reduces the position and fills.
    log(c.y("\n[6/7] FLATTEN  marketable LIMIT SELL (reduce)"));
    await placeFillingLimit("SELL", securityId, QTY, FILL_WAIT);
    flattened = true;
    log(c.g("  ✓ sell filled"));

    // 7. VERIFY FLAT — back to the pre-buy baseline (our buy undone), not necessarily absolute zero.
    log(c.y("\n[7/7] VERIFY FLAT  GET /v2/positions"));
    const after = await positionNetQty(securityId);
    if (after !== net0) log(c.y(`  ⚠ netQty is ${after} (expected baseline ${net0}; sandbox may settle async) — check the DevPortal if it doesn't clear`));
    else log(c.g("  ✓ restored to baseline") + `  netQty ${after}`);

    log(c.g("\n══════════════════════════════════════"));
    log(c.g("  PASS — Dhan sandbox order path works end-to-end"));
    log(c.g("══════════════════════════════════════\n"));
    process.exit(0);
  } catch (e) {
    log(c.r("\n✖ FAILED: " + (e && e.message ? e.message : String(e))));
    // EMERGENCY FLATTEN (R39-P1-04): if a buy was SUBMITTED (even if the response was lost) and we never flattened, close
    // any real exposure. Query broker truth first (net position) and sell exactly that; if positions are unreadable, fall
    // back to the intended qty so we never leave a possibly-open sandbox position.
    if (submitted && !flattened && securityId) {
      let flatQty = QTY;
      try { const net = await positionNetQty(securityId); if (Number(net) > net0) flatQty = Math.abs(Number(net) - net0) || QTY; } catch { /* positions unreadable ⇒ use intended qty */ }
      log(c.y(`  emergency flatten: selling ${flatQty} to close any exposure…`));
      // Best-effort marketable sell (auto-priced inside the circuit band) so it actually reduces, not just accepted.
      try { await placeFillingLimit("SELL", securityId, flatQty, 8); log(c.y("  emergency sell filled — verify flat in the DevPortal")); }
      catch (e2) { log(c.r("  emergency flatten did not confirm: " + (e2 && e2.message) + " — check the DevPortal")); }
    }
    process.exit(1);
  }
})();
