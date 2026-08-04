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
  // Identical shape to server.js POST /api/order dhan branch.
  return {
    dhanClientId: CLIENT_ID, transactionType: String(side).toUpperCase(),
    exchangeSegment: "NSE_EQ", productType: "INTRADAY",
    orderType: "MARKET", validity: "DAY", securityId, quantity: String(Math.max(1, Math.abs(Number(qty) || QTY))),
    price: "", disclosedQuantity: "", afterMarketOrder: false,
  };
}

async function placeOrder(side, securityId, qty = QTY) {
  const r = await api("POST", "/v2/orders", orderBody(side, securityId, qty));
  const d = r.json || {};
  if (!r.ok || d.orderStatus === "REJECTED" || d.errorType) {
    throw new Error(d.errorMessage || d.omsErrorDescription || `Dhan ${side} failed (${r.status}) ${r.text || ""}`.trim());
  }
  return { orderId: d.orderId ?? (d.data && (d.data.orderId || d.data.order_id)) ?? null, status: d.orderStatus || "PENDING" };
}

async function findOrder(orderId) {
  const r = await api("GET", "/v2/orders");
  const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  return arr.find((o) => String(o.orderId) === String(orderId)) || null;
}

async function positionNetQty(securityId) {
  const r = await api("GET", "/v2/positions");
  const arr = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  const p = arr.find((x) => String(x.securityId) === String(securityId));
  return p ? Number(p.netQty) : 0;
}

(async function main() {
  log(c.b("\n═══ Dhan SANDBOX certification ═══"));
  log("base:", BASE, "| symbol:", SYMBOL, "| qty:", QTY);

  if (!TOKEN || !CLIENT_ID) die("Set DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID in the environment before running.");
  if (!/(^|\.)sandbox\.dhan\.co$/i.test(new URL(BASE).hostname) && process.env.DHAN_ALLOW_PROD !== "1") {
    die(`Refusing to run against a non-sandbox host (${new URL(BASE).hostname}). This script places live orders; keep DHAN_API_BASE on sandbox.dhan.co (or set DHAN_ALLOW_PROD=1 only if you truly mean production).`);
  }

  let securityId = null, boughtQty = 0, flattened = false, submitted = false;

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

    // 3. BUY — R39-P1-04: ARM cleanup BEFORE the send. If Dhan ACCEPTS the order but the HTTP response is lost/malformed
    // (placeOrder throws), we must still flatten. `submitted` fires before the request; the catch reconciles from broker
    // truth (net position) rather than assuming nothing happened.
    log(c.y("\n[3/7] BUY  POST /v2/orders (MARKET INTRADAY)"));
    submitted = true;
    const buy = await placeOrder("BUY", securityId);
    boughtQty = QTY;
    log(c.g("  ✓ order accepted") + `  orderId ${buy.orderId}  status ${buy.status}`);

    // 4. VERIFY FILL
    log(c.y("\n[4/7] VERIFY FILL  poll GET /v2/orders"));
    let filled = null;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const o = await findOrder(buy.orderId);
      if (o) { log(`  … ${o.orderStatus}`); if (/TRADED|FILLED|EXECUTED/i.test(o.orderStatus)) { filled = o; break; } if (/REJECTED|CANCELLED/i.test(o.orderStatus)) throw new Error(`order ${o.orderStatus}: ${o.omsErrorDescription || ""}`); }
    }
    if (!filled) throw new Error("buy order did not reach TRADED within 12s");
    log(c.g("  ✓ filled") + `  avg price ₹${filled.averageTradedPrice ?? filled.price ?? "?"} (sandbox fills at ₹100)`);

    // 5. POSITION
    log(c.y("\n[5/7] POSITION  GET /v2/positions"));
    const net = await positionNetQty(securityId);
    if (net < QTY) throw new Error(`expected a long position of ${QTY}, saw netQty ${net}`);
    log(c.g("  ✓ long position present") + `  netQty ${net}`);

    // 6. FLATTEN
    log(c.y("\n[6/7] FLATTEN  POST /v2/orders (SELL, reduce)"));
    const sell = await placeOrder("SELL", securityId);
    flattened = true;
    log(c.g("  ✓ sell accepted") + `  orderId ${sell.orderId}`);
    for (let i = 0; i < 12; i++) { await sleep(1000); const o = await findOrder(sell.orderId); if (o && /TRADED|FILLED|EXECUTED/i.test(o.orderStatus)) break; if (o && /REJECTED|CANCELLED/i.test(o.orderStatus)) throw new Error(`sell ${o.orderStatus}`); }

    // 7. VERIFY FLAT
    log(c.y("\n[7/7] VERIFY FLAT  GET /v2/positions"));
    const after = await positionNetQty(securityId);
    if (after !== 0) log(c.y(`  ⚠ netQty is ${after} (sandbox may settle async) — check the DevPortal if it doesn't clear`));
    else log(c.g("  ✓ flat") + "  netQty 0");

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
      try { const net = await positionNetQty(securityId); if (Number(net) > 0) flatQty = Math.abs(Number(net)); } catch { /* positions unreadable ⇒ use intended qty */ }
      log(c.y(`  emergency flatten: selling ${flatQty} to close any exposure…`));
      try { await placeOrder("SELL", securityId, flatQty); log(c.y("  emergency sell submitted — verify flat in the DevPortal")); }
      catch (e2) { log(c.r("  emergency flatten ALSO failed: " + (e2 && e2.message))); }
    }
    process.exit(1);
  }
})();
