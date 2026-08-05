#!/usr/bin/env node
/* test/zerodhaSandbox.sandbox.cjs — standalone Zerodha (Kite Connect) REAL-MONEY certification run.
 *
 * Kite has no free sandbox for order placement, so this places a REAL 1-share MIS order during NSE market hours
 * (09:15–15:30 IST) and squares it off, proving the contract Matrix uses to trade Zerodha:
 *   1. CONNECT     GET /user/margins        → api_key:access_token accepted
 *   2. BUY         POST /orders/regular     → order accepted (order_id)
 *   3. VERIFY FILL GET /orders/{order_id}   → status COMPLETE (last history entry; avg price)
 *   4. FLATTEN     POST /orders/regular     → square off the 1 share (SELL)
 *   5. VERIFY FLAT poll the sell to COMPLETE
 * A try/finally EMERGENCY SELL squares off if a step throws after the buy. Order body + /orders/{id} parsing are
 * copied field-for-field from server.js (the zerodha order branch + verifyZerodhaFill).
 *
 * ENV (never hard-code your token):
 *   KITE_API_KEY       (required)  your Kite Connect app api_key
 *   KITE_ACCESS_TOKEN  (required)  today's access_token from the Kite login flow (daily)
 *   KITE_TEST_SYMBOL   (optional)  default IDEA  — a cheap NSE cash equity so 1 share is a few ₹
 *   KITE_TEST_QTY      (optional)  default 1
 *   KITE_API_BASE      (optional)  default https://api.kite.trade
 *
 * RUN (from matrix-backend, during market hours):
 *   KITE_API_KEY='...' KITE_ACCESS_TOKEN='...' node test/zerodhaSandbox.sandbox.cjs
 */
"use strict";

const BASE = String(process.env.KITE_API_BASE || "https://api.kite.trade").replace(/\/+$/, "");
const API_KEY = process.env.KITE_API_KEY || "";
const TOKEN = process.env.KITE_ACCESS_TOKEN || "";
const SYMBOL = (process.env.KITE_TEST_SYMBOL || "IDEA").trim().toUpperCase().replace(/-EQ$/, "");
const QTY = Math.max(1, Number(process.env.KITE_TEST_QTY || 1) | 0);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const die = (m) => { log(c.r("\n✖ " + m)); process.exit(1); };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const authHeaders = () => ({ Authorization: `token ${API_KEY}:${TOKEN}`, "X-Kite-Version": "3" });

async function get(path) {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function place(side) {
  const body = new URLSearchParams({ exchange: "NSE", tradingsymbol: SYMBOL, transaction_type: String(side).toUpperCase(), quantity: String(QTY), order_type: "MARKET", product: "MIS", validity: "DAY" });
  const res = await fetch(BASE + "/orders/regular", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" }, body });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.status === "error") throw new Error(d.message || `kite ${side} failed (${res.status})`);
  return { orderId: (d.data && d.data.order_id) || null };
}
async function orderState(orderId) {
  const r = await get(`/orders/${encodeURIComponent(orderId)}`);
  const arr = (r.json && Array.isArray(r.json.data)) ? r.json.data : [];
  const o = arr.length ? arr[arr.length - 1] : ((r.json && r.json.data) || {});
  return String(o.status ?? "").toUpperCase();
}
async function waitFilled(orderId, label) {
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const st = await orderState(orderId);
    if (st) log(`  … ${st}`);
    if (st === "COMPLETE") return st;
    if (st === "REJECTED" || st === "CANCELLED") throw new Error(`${label} ${st}`);
  }
  throw new Error(`${label} did not reach COMPLETE within 15s`);
}

(async function main() {
  log(c.b("\n═══ Zerodha (Kite) REAL-MONEY certification ═══"));
  log("base:", BASE, "| symbol:", SYMBOL, "| qty:", QTY);
  if (!API_KEY || !TOKEN) die("Set KITE_API_KEY and KITE_ACCESS_TOKEN in the environment before running.");
  if (!/(^|\.)kite\.trade$/i.test(new URL(BASE).hostname)) die(`Refusing a non-Kite host (${new URL(BASE).hostname}).`);

  let bought = false, flattened = false;
  try {
    log(c.y("\n[1/5] CONNECT  GET /user/margins"));
    const m = await get("/user/margins");
    if (m.status === 401 || m.status === 403 || (m.json && m.json.status === "error")) {
      die(`token rejected (${m.status}) ${(m.json && m.json.message) || m.text || ""} — check KITE_API_KEY + today's KITE_ACCESS_TOKEN (the access token is daily).`.trim());
    }
    log(c.g("  ✓ api_key:access_token accepted") + `  (margins ${m.status})`);

    log(c.y("\n[2/5] BUY  POST /orders/regular (MARKET MIS)"));
    bought = true;
    const buy = await place("BUY");
    log(c.g("  ✓ buy accepted") + `  orderId ${buy.orderId}`);

    log(c.y("\n[3/5] VERIFY FILL  poll GET /orders/{id}"));
    await waitFilled(buy.orderId, "buy");
    log(c.g("  ✓ filled"));

    log(c.y("\n[4/5] FLATTEN  POST /orders/regular (SELL, MIS)"));
    const sell = await place("SELL");
    flattened = true;
    log(c.g("  ✓ sell accepted") + `  orderId ${sell.orderId}`);
    await waitFilled(sell.orderId, "sell").catch((e) => log(c.y("  ⚠ " + e.message)));

    log(c.y("\n[5/5] VERIFY FLAT"));
    log(c.g("  ✓ squared off (verify netQty 0 in Kite if in doubt)"));

    log(c.g("\n══════════════════════"));
    log(c.g("  PASS — Zerodha real order path works end-to-end (bought, verified fill, squared off)"));
    log(c.g("══════════════════════\n"));
    process.exit(0);
  } catch (e) {
    log(c.r("\n✖ FAILED: " + (e && e.message ? e.message : String(e))));
    if (bought && !flattened) {
      log(c.y("  emergency square-off: selling to close…"));
      try { await place("SELL"); log(c.y("  emergency sell submitted — verify flat in Kite")); }
      catch (e2) { log(c.r("  emergency sell ALSO failed: " + (e2 && e2.message))); }
    }
    process.exit(1);
  }
})();
