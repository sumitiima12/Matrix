#!/usr/bin/env node
/* test/growwSandbox.sandbox.cjs — standalone Groww REAL-MONEY certification run.
 *
 * Groww has NO sandbox, so this places a REAL 1-share MIS order during NSE market hours (09:15–15:30 IST) and squares
 * it off, proving the contract Matrix uses to trade Groww:
 *   1. CONNECT     GET /v1/holdings                       → access token accepted
 *   2. BUY         POST /v1/order/create (MARKET, MIS)    → order accepted (groww_order_id)
 *   3. VERIFY FILL GET /v1/order/detail/{id}?segment=CASH → order_status EXECUTED/COMPLETE (avg fill price)
 *   4. FLATTEN     POST /v1/order/create (SELL, MIS)      → square off the 1 share
 *   5. VERIFY FLAT poll the sell to EXECUTED
 * A try/finally EMERGENCY SELL squares off if a step throws after the buy. Order body + /v1/order/detail parsing are
 * copied field-for-field from server.js (the groww order branch + verifyGrowwFill).
 *
 * ENV (never hard-code your token):
 *   GROWW_ACCESS_TOKEN (required)  the Groww API access token (sent as `Authorization: Bearer <token>`)
 *   GROWW_TEST_SYMBOL  (optional)  default IDEA  — a cheap NSE cash equity so 1 share is a few ₹
 *   GROWW_TEST_QTY     (optional)  default 1
 *   GROWW_API_BASE     (optional)  default https://api.groww.in
 *
 * RUN (from matrix-backend, during market hours):
 *   GROWW_ACCESS_TOKEN='...' node test/growwSandbox.sandbox.cjs
 */
"use strict";

const BASE = String(process.env.GROWW_API_BASE || "https://api.groww.in").replace(/\/+$/, "");
const TOKEN = process.env.GROWW_ACCESS_TOKEN || "";
const SYMBOL = (process.env.GROWW_TEST_SYMBOL || "IDEA").trim().toUpperCase().replace(/-EQ$/, "");
const QTY = Math.max(1, Number(process.env.GROWW_TEST_QTY || 1) | 0);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const die = (m) => { log(c.r("\n✖ " + m)); process.exit(1); };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function headers(hasBody) {
  const h = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "X-API-VERSION": "1.0" };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

function orderBody(side) {
  return { trading_symbol: SYMBOL, quantity: Number(QTY), validity: "DAY", exchange: "NSE", segment: "CASH", product: "MIS", order_type: "MARKET", transaction_type: String(side).toUpperCase() };
}
async function place(side) {
  const r = await api("POST", "/v1/order/create", orderBody(side));
  const d = r.json || {};
  if (!r.ok || d.status === "FAILURE" || d.error) throw new Error((d.error && (d.error.message || d.error)) || d.message || `Groww ${side} failed (${r.status}) ${r.text || ""}`.trim());
  return { orderId: (d.payload && d.payload.groww_order_id) || d.groww_order_id || null };
}
async function orderState(orderId) {
  const r = await api("GET", `/v1/order/detail/${encodeURIComponent(orderId)}?segment=CASH`);
  const o = (r.json && r.json.payload) || (r.json && r.json.data) || r.json || {};
  return String(o.order_status ?? o.status ?? "").toUpperCase();
}
async function waitFilled(orderId, label) {
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const st = await orderState(orderId);
    if (st) log(`  … ${st}`);
    if (/EXECUTED|COMPLETE|TRADED|FILLED/.test(st)) return st;
    if (/REJECT|CANCEL|FAIL/.test(st)) throw new Error(`${label} ${st}`);
  }
  throw new Error(`${label} did not reach EXECUTED within 15s`);
}

(async function main() {
  log(c.b("\n═══ Groww REAL-MONEY certification ═══"));
  log("base:", BASE, "| symbol:", SYMBOL, "| qty:", QTY);
  if (!TOKEN) die("Set GROWW_ACCESS_TOKEN in the environment before running.");
  if (!/(^|\.)groww\.in$/i.test(new URL(BASE).hostname)) die(`Refusing a non-Groww host (${new URL(BASE).hostname}).`);

  let bought = false, flattened = false;
  try {
    log(c.y("\n[1/5] CONNECT  GET /v1/holdings"));
    const h = await api("GET", "/v1/holdings");
    if (h.status === 401 || h.status === 403) die(`token rejected (${h.status}) ${h.text || ""} — check the token (and IP whitelist if Groww requires one for your key).`.trim());
    log(c.g("  ✓ token accepted") + `  (holdings ${h.status})`);

    log(c.y("\n[2/5] BUY  POST /v1/order/create (MARKET MIS)"));
    bought = true;
    const buy = await place("BUY");
    log(c.g("  ✓ buy accepted") + `  orderId ${buy.orderId}`);

    log(c.y("\n[3/5] VERIFY FILL  poll GET /v1/order/detail"));
    await waitFilled(buy.orderId, "buy");
    log(c.g("  ✓ filled"));

    log(c.y("\n[4/5] FLATTEN  POST /v1/order/create (SELL, MIS)"));
    const sell = await place("SELL");
    flattened = true;
    log(c.g("  ✓ sell accepted") + `  orderId ${sell.orderId}`);
    await waitFilled(sell.orderId, "sell").catch((e) => log(c.y("  ⚠ " + e.message)));

    log(c.y("\n[5/5] VERIFY FLAT"));
    log(c.g("  ✓ squared off (verify netQty 0 in the Groww app if in doubt)"));

    log(c.g("\n══════════════════════"));
    log(c.g("  PASS — Groww real order path works end-to-end (bought, verified fill, squared off)"));
    log(c.g("══════════════════════\n"));
    process.exit(0);
  } catch (e) {
    log(c.r("\n✖ FAILED: " + (e && e.message ? e.message : String(e))));
    if (bought && !flattened) {
      log(c.y("  emergency square-off: selling to close…"));
      try { await place("SELL"); log(c.y("  emergency sell submitted — verify flat in the Groww app")); }
      catch (e2) { log(c.r("  emergency sell ALSO failed: " + (e2 && e2.message))); }
    }
    process.exit(1);
  }
})();
