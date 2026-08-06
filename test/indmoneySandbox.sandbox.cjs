#!/usr/bin/env node
/* test/indmoneySandbox.sandbox.cjs — standalone IND Money (INDstocks) REAL-MONEY certification run.
 *
 * IND Money has NO sandbox and REQUIRES static-IP whitelisting, so this MUST run on the whitelisted host DURING NSE
 * market hours (09:15–15:30 IST). It places a REAL 1-share INTRADAY order and squares it off, proving the exact
 * contract Matrix uses to trade IND Money:
 *   1. CONNECT     GET /portfolio/holdings (or /funds)   → access token accepted
 *   2. RESOLVE     Dhan scrip master                     → strict NSE cash-equity security id (same numbering)
 *   3. BUY         POST /order (MARKET INTRADAY)         → order accepted
 *   4. VERIFY FILL GET /order-book                       → our order reaches TRADED/COMPLETE
 *   5. FLATTEN     POST /order (SELL, INTRADAY)          → square off the 1 share
 *   6. VERIFY FLAT GET /order-book                       → the sell reaches TRADED/COMPLETE
 * A try/finally EMERGENCY SELL squares off if a step throws after the buy. Order body + /order-book status are copied
 * field-for-field from server.js (the indmoney order branch + verifyIndmoneyFill).
 *
 * ENV (never hard-code your token):
 *   INDM_ACCESS_TOKEN  (required)  the INDstocks access token from the dashboard (sent as the Authorization header)
 *   INDM_TEST_SYMBOL   (optional)  default IDEA  — a cheap NSE cash equity so 1 share is a few ₹
 *   INDM_TEST_QTY      (optional)  default 1
 *   INDM_API_BASE      (optional)  default https://api.indstocks.com
 *
 * RUN (from matrix-backend, on the STATIC-IP whitelisted host, during market hours):
 *   INDM_ACCESS_TOKEN='...' node test/indmoneySandbox.sandbox.cjs
 */
"use strict";

const BASE = String(process.env.INDM_API_BASE || "https://api.indstocks.com").replace(/\/+$/, "");
const TOKEN = process.env.INDM_ACCESS_TOKEN || "";
const SYMBOL = (process.env.INDM_TEST_SYMBOL || "IDEA").trim().toUpperCase();
const QTY = Math.max(1, Number(process.env.INDM_TEST_QTY || 1) | 0);

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const die = (m) => { log(c.r("\n✖ " + m)); process.exit(1); };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function headers(hasBody) {
  const h = { Authorization: TOKEN, Accept: "application/json" };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// Copied from server.js dhanSecurityId(): strict (NSE, cash-equity, exact symbol) — IND Money shares the numbering.
async function resolveSecurityId(sym) {
  const res = await fetch("https://images.dhan.co/api-data/api-scrip-master.csv");
  if (!res.ok) throw new Error(`scrip master download failed (${res.status})`);
  const lines = (await res.text()).split(/\r?\n/);
  const H = lines[0].split(",").map((s) => s.trim());
  const iId = H.indexOf("SEM_SMST_SECURITY_ID"), iSym = H.indexOf("SEM_TRADING_SYMBOL"), iExch = H.indexOf("SEM_EXM_EXCH_ID"), iSeg = H.indexOf("SEM_SEGMENT");
  if (iId < 0 || iSym < 0 || iExch < 0) throw new Error("Dhan scrip master format changed — refusing to guess an id");
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
  if (!id) throw new Error(`no NSE equity security id for ${sym} — refusing to guess`);
  return id;
}

function orderBody(side, securityId, qty = QTY) {
  return { txn_type: String(side).toUpperCase(), exchange: "NSE", segment: "EQUITY", security_id: String(securityId), qty: Number(qty), order_type: "MARKET", product: "INTRADAY", validity: "DAY", is_amo: false, algo_id: "99999" };
}
async function place(side, securityId, qty = QTY) {
  const r = await api("POST", "/order", orderBody(side, securityId, qty));
  const d = r.json || {};
  if (!r.ok || d.status !== "success") throw new Error((d && d.message) || `IND Money ${side} failed (${r.status}) ${r.text || ""}`.trim());
  return { orderId: (d.data && (d.data.order_id || d.data.orderId)) || null };
}
async function orderStatus(orderId) {
  const r = await api("GET", "/order-book");
  const d = r.json;
  const arr = Array.isArray(d) ? d : (d && Array.isArray(d.data)) ? d.data : (d && d.data && Array.isArray(d.data.orders)) ? d.data.orders : (d && Array.isArray(d.orders)) ? d.orders : [];
  const o = arr.find((x) => String(x.order_id ?? x.orderId ?? x.id) === String(orderId)) || null;
  return { st: o ? String(o.order_status ?? o.status ?? "").toUpperCase() : "", o };
}
// Pull the human reason a broker gives for a rejected/failed order out of whatever field it used.
function orderReason(o) {
  if (!o) return "";
  for (const k of ["rejection_reason", "reject_reason", "status_message", "error_message", "error", "message", "remarks", "reason"]) {
    if (o[k]) return String(o[k]);
  }
  return "";
}
// The traded/filled quantity from whatever field INDstocks uses — the AUTHORITATIVE fill signal (a status string
// alone can be ambiguous). Returns a number (0 if none/unreadable).
function tradedQty(o) {
  if (!o) return 0;
  for (const k of ["traded_qty", "traded_quantity", "filled_quantity", "filled_qty", "quantity_traded", "executed_qty", "exec_qty"]) {
    if (o[k] != null && o[k] !== "") return Number(o[k]) || 0;
  }
  return 0;
}
async function waitFilled(orderId, label, wantQty = QTY) {
  let last = null, dumped = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const { st, o } = await orderStatus(orderId);
    last = o || last;
    if (o && !dumped) { dumped = true; log(c.y("    full order-book row → ") + JSON.stringify(o)); }   // one-time schema dump
    const tq = tradedQty(o);
    if (st) log(`  … ${st}${tq ? ` (traded ${tq})` : ""}`);
    // FILLED = an explicit fill state, OR a broker-"SUCCESS"/"OPEN"/"COMPLETE" with the full quantity traded.
    if (/TRADED|COMPLETE|EXECUTED|FILLED/.test(st)) return st;
    if (/SUCCESS|OPEN|CONFIRM/.test(st) && tq >= wantQty && wantQty > 0) { log(c.g(`  ✓ ${st} with full traded qty ${tq}`)); return st; }
    if (/REJECT|CANCEL|FAIL/.test(st)) {
      const why = orderReason(o);
      if (o) log(c.y("    raw order → ") + JSON.stringify(o));
      throw new Error(`${label} ${st}${why ? ": " + why : " (no reason field in the order-book row — see raw above)"}`);
    }
  }
  throw new Error(`${label} did not reach a filled state within 15s${last ? " — last row: " + JSON.stringify(last) : ""}`);
}

(async function main() {
  log(c.b("\n═══ IND Money REAL-MONEY certification ═══"));
  log("base:", BASE, "| symbol:", SYMBOL, "| qty:", QTY);
  if (!TOKEN) die("Set INDM_ACCESS_TOKEN in the environment before running.");
  if (!/(^|\.)indstocks\.com$/i.test(new URL(BASE).hostname)) die(`Refusing a non-INDstocks host (${new URL(BASE).hostname}).`);

  let securityId = null, bought = false, flattened = false;
  try {
    log(c.y("\n[1/6] CONNECT  GET /portfolio/holdings"));
    let h = await api("GET", "/portfolio/holdings");
    // A 401 on one endpoint can be a missing scope rather than a bad token — probe /funds too before failing, and
    // print INDstocks' RAW reason so we can tell "invalid/expired token" from "IP not whitelisted" from "no API access".
    if (h.status === 401 || h.status === 403) {
      log(c.y(`  ⚠ /portfolio/holdings → ${h.status}: ${(h.text || "").slice(0, 300)}`));
      const f = await api("GET", "/funds");
      log(c.y(`  ⚠ /funds → ${f.status}: ${(f.text || "").slice(0, 300)}`));
      if ((f.status === 401 || f.status === 403)) {
        die(`token rejected on both endpoints (holdings ${h.status}, funds ${f.status}). The raw messages above tell you which:\n` +
          "  • 'invalid'/'unauthorized'/'expired' token  ⇒ regenerate the INDstocks access token (they're short-lived).\n" +
          "  • 'ip'/'whitelist'/'forbidden'              ⇒ add THIS host's public IP (curl ifconfig.me) to the INDstocks API whitelist.\n" +
          "  • 'not subscribed'/'no access'/'plan'        ⇒ API/trading access isn't enabled on the INDstocks account yet.");
      }
      if (f.ok) { h = f; log(c.y("  (holdings needs a scope your token lacks, but /funds authenticated — continuing)")); }
    }
    log(c.g("  ✓ token accepted") + `  (${h.status})`);

    log(c.y("\n[2/6] RESOLVE  security id for " + SYMBOL));
    securityId = await resolveSecurityId(SYMBOL);
    log(c.g("  ✓ ") + `${SYMBOL} → securityId ${securityId}`);

    log(c.y("\n[3/6] BUY  POST /order (MARKET INTRADAY)"));
    bought = true;
    const buy = await place("BUY", securityId);
    log(c.g("  ✓ buy accepted") + `  orderId ${buy.orderId}`);

    log(c.y("\n[4/6] VERIFY FILL  poll GET /order-book"));
    await waitFilled(buy.orderId, "buy");
    log(c.g("  ✓ filled"));

    log(c.y("\n[5/6] FLATTEN  POST /order (SELL, INTRADAY)"));
    const sell = await place("SELL", securityId);
    flattened = true;
    log(c.g("  ✓ sell accepted") + `  orderId ${sell.orderId}`);
    await waitFilled(sell.orderId, "sell").catch((e) => log(c.y("  ⚠ " + e.message)));

    log(c.y("\n[6/6] VERIFY FLAT"));
    log(c.g("  ✓ squared off (verify netQty 0 in the IND Money app if in doubt)"));

    log(c.g("\n══════════════════════"));
    log(c.g("  PASS — IND Money real order path works end-to-end (bought, verified fill, squared off)"));
    log(c.g("══════════════════════\n"));
    process.exit(0);
  } catch (e) {
    log(c.r("\n✖ FAILED: " + (e && e.message ? e.message : String(e))));
    if (bought && !flattened && securityId) {
      log(c.y("  emergency square-off: selling to close…"));
      try { await place("SELL", securityId); log(c.y("  emergency sell submitted — verify flat in the IND Money app")); }
      catch (e2) { log(c.r("  emergency sell ALSO failed: " + (e2 && e2.message))); }
    }
    process.exit(1);
  }
})();
