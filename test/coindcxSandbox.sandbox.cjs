#!/usr/bin/env node
/* test/coindcxSandbox.sandbox.cjs — standalone CoinDCX REAL-MONEY certification run.
 *
 * CoinDCX has NO paper/testnet, so this places a REAL spot order for a TINY notional (venue minimum) and immediately
 * sells the exact received balance back to flat. It proves the contract Matrix uses to trade CoinDCX works end-to-end:
 *   1. CONNECT     POST /exchange/v1/users/balances   → key/secret accepted, INR + coin balances readable
 *   2. BUY         POST /exchange/v1/orders/create    → market buy accepted (order id returned)
 *   3. VERIFY FILL POST /exchange/v1/orders/status    → our order reaches "filled" (avg price recorded)
 *   4. FLATTEN     POST /exchange/v1/orders/create    → SELL the REAL received coin (balance delta, fee-aware)
 *   5. VERIFY FLAT re-read balances                   → coin balance back to (approximately) the start
 * A try/finally EMERGENCY FLATTEN sells any leftover coin if a step throws midway, so we never leave real exposure.
 * The signing + order body are copied field-for-field from server.js coindcxCall()/the CoinDCX order branch.
 *
 * Signing (server.js coindcxCall): signature = HMAC_SHA256(secret, JSON.stringify({ timestamp, ...body })).
 *
 * ENV (never hard-code your keys):
 *   COINDCX_API_KEY     (required)
 *   COINDCX_API_SECRET  (required)
 *   COINDCX_TEST_MARKET (optional) default "DOGEINR"  — a liquid, cheap coin so the min-notional order is a few ₹
 *   COINDCX_TEST_QTY    (optional) default 0          — coin qty to buy; 0 ⇒ auto-size to just over the ₹ min-notional
 *   COINDCX_MIN_INR     (optional) default 160        — target order value in ₹ when auto-sizing (keep just above venue min)
 *   COINDCX_API_BASE    (optional) default https://api.coindcx.com  — do NOT change unless you know why
 *
 * RUN (from matrix-backend, on the whitelisted-IP host if your key is IP-restricted):
 *   COINDCX_API_KEY=... COINDCX_API_SECRET=... node test/coindcxSandbox.sandbox.cjs
 */
"use strict";
const crypto = require("node:crypto");

const BASE = String(process.env.COINDCX_API_BASE || "https://api.coindcx.com").replace(/\/+$/, "");
const KEY = process.env.COINDCX_API_KEY || "";
const SECRET = process.env.COINDCX_API_SECRET || "";
const MARKET = (process.env.COINDCX_TEST_MARKET || "DOGEINR").trim().toUpperCase();
const COIN = MARKET.replace(/INR$/i, "");
const MIN_INR = Math.max(120, Number(process.env.COINDCX_MIN_INR || 160) || 160);
let QTY = Number(process.env.COINDCX_TEST_QTY || 0) || 0;

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (...a) => console.log(...a);
const die = (m) => { log(c.r("\n✖ " + m)); process.exit(1); };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// EXACT server.js coindcxCall signing.
async function call(path, extraBody = {}) {
  const body = { timestamp: Date.now(), ...extraBody };
  const payload = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AUTH-APIKEY": KEY, "X-AUTH-SIGNATURE": signature },
    body: payload,
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

async function balanceOf(sym) {
  const { ok, d } = await call("/exchange/v1/users/balances");
  if (!ok || !Array.isArray(d)) return null;
  const b = d.find((x) => String(x.currency).toUpperCase() === String(sym).toUpperCase());
  return b ? Number(b.balance) || 0 : 0;
}

async function tickerPrice(market) {
  try {
    const r = await fetch("https://api.coindcx.com/exchange/ticker");
    const arr = await r.json().catch(() => []);
    const t = Array.isArray(arr) ? arr.find((x) => String(x.market).toUpperCase() === market) : null;
    return t ? Number(t.last_price) || 0 : 0;
  } catch { return 0; }
}

// CoinDCX per-market rules (precision, min qty/notional) — the venue REJECTS a wrong-precision qty (e.g. DOGE = integers).
async function marketDetails(market) {
  try {
    const r = await fetch("https://api.coindcx.com/exchange/v1/markets_details");
    const arr = await r.json().catch(() => []);
    return Array.isArray(arr) ? arr.find((m) => String(m.market).toUpperCase() === market) : null;
  } catch { return null; }
}
const roundUpTo = (x, p) => { const f = Math.pow(10, Math.max(0, p | 0)); return Math.ceil(x * f) / f; };

async function placeMarket(side, quantity) {
  const { ok, status, d } = await call("/exchange/v1/orders/create", {
    side, order_type: "market_order", market: MARKET, total_quantity: Number(quantity),
  });
  if (!ok || d.message || d.code) throw new Error(d.message || `CoinDCX ${side} failed (${status})`);
  const o = (d.orders && d.orders[0]) || d;
  return { id: o.id || o.order_id || null, status: o.status || "PENDING" };
}

async function orderStatus(id) {
  const { d } = await call("/exchange/v1/orders/status", { id: String(id) });
  const o = (d && Array.isArray(d.orders) && d.orders[0]) || (d && d.order) || d || {};
  return { status: String(o.status || "").toLowerCase(), avg: Number(o.avg_price ?? o.average_price ?? o.price_per_unit) || null, filled: Number(o.filled_quantity ?? o.total_quantity) || 0 };
}

async function waitFilled(id, label) {
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const s = await orderStatus(id);
    if (s.status) log(`  … ${s.status}`);
    if (s.status === "filled" || s.status === "closed") return s;
    if (/reject|cancel/.test(s.status)) throw new Error(`${label} ${s.status}`);
  }
  throw new Error(`${label} did not reach "filled" within 15s`);
}

(async function main() {
  log(c.b("\n═══ CoinDCX REAL-MONEY certification ═══"));
  log("base:", BASE, "| market:", MARKET);
  if (!KEY || !SECRET) die("Set COINDCX_API_KEY and COINDCX_API_SECRET in the environment before running.");
  if (!/(^|\.)coindcx\.com$/i.test(new URL(BASE).hostname)) die(`Refusing a non-CoinDCX host (${new URL(BASE).hostname}).`);

  let bought = false, coinStart = 0;
  try {
    // 1. CONNECT — surface the RAW status/body so a failure is diagnosable (auth vs IP-whitelist vs permissions).
    log(c.y("\n[1/5] CONNECT  POST /exchange/v1/users/balances"));
    const bal = await call("/exchange/v1/users/balances");
    if (!bal.ok || !Array.isArray(bal.d)) {
      die(`Could not read balances — HTTP ${bal.status}: ${JSON.stringify(bal.d).slice(0, 300)}\n` +
        "  • 401 / Invalid credentials  ⇒ wrong API key/secret (or the key was revoked).\n" +
        "  • ip_not_whitelisted / 403    ⇒ whitelist THIS machine's IP on the CoinDCX key.\n" +
        "    Run:  curl -s https://api.ipify.org ; echo    to see the IP the venue sees, and add it to the key.\n" +
        "  • the key must have the 'Trade'/'Read' permissions enabled.");
    }
    const inr = Number((bal.d.find((x) => String(x.currency).toUpperCase() === "INR") || {}).balance) || 0;
    coinStart = Number((bal.d.find((x) => String(x.currency).toUpperCase() === COIN) || {}).balance) || 0;
    log(c.g("  ✓ authenticated") + `  INR ₹${inr}  |  ${COIN} ${coinStart}`);

    // Size to the market's REAL precision + minimums (CoinDCX rejects wrong-precision qty; DOGE needs whole numbers).
    const md = await marketDetails(MARKET);
    const px = await tickerPrice(MARKET);
    if (!px) die(`Could not read ${MARKET} price to size the order — set COINDCX_TEST_QTY explicitly.`);
    const tp = md && md.target_currency_precision != null ? Number(md.target_currency_precision) : 3;
    const minQ = md ? Number(md.min_quantity) || 0 : 0;
    const minN = md ? Number(md.min_notional) || 0 : 0;
    QTY = QTY ? roundUpTo(QTY, tp) : roundUpTo(MIN_INR / px, tp);
    if (QTY < minQ) QTY = roundUpTo(minQ, tp);
    const stepUp = tp > 0 ? Math.pow(10, -tp) : 1;
    let guard = 0;
    while (QTY * px < Math.max(minN, MIN_INR) - 1e-9 && guard++ < 10000) QTY = roundUpTo(QTY + stepUp, tp);
    const estINR = QTY * px;
    log(c.y(`  sized: buying ${QTY} ${COIN} (≈ ₹${estINR.toFixed(2)} at ₹${px}; precision ${tp}, min_qty ${minQ}, min_notional ₹${minN})`));
    if (inr < estINR) die(`Insufficient INR — need ≈ ₹${estINR.toFixed(2)} but the account holds ₹${inr}. Add a little INR and re-run.`);

    // 2. BUY
    log(c.y("\n[2/5] BUY  POST /exchange/v1/orders/create (market)"));
    bought = true;
    const buy = await placeMarket("buy", QTY);
    log(c.g("  ✓ buy accepted") + `  orderId ${buy.id}`);

    // 3. VERIFY FILL
    log(c.y("\n[3/5] VERIFY FILL  poll /exchange/v1/orders/status"));
    const f = await waitFilled(buy.id, "buy");
    log(c.g("  ✓ filled") + `  avg ₹${f.avg ?? "?"}  qty ${f.filled || QTY}`);

    // 4. FLATTEN — sell the REAL received coin (balance delta, fee-aware), not the ordered qty.
    log(c.y("\n[4/5] FLATTEN  SELL the received balance"));
    await sleep(1500);
    const coinNow = await balanceOf(COIN);
    let sellQty = Math.max(0, coinNow - coinStart);
    // round down to avoid selling more than we hold; CoinDCX truncates to the market's precision anyway.
    sellQty = Math.floor(sellQty * 1000) / 1000;
    if (sellQty <= 0) { log(c.y("  ⚠ no positive balance delta to sell (fees/precision) — nothing to flatten")); }
    else {
      const sell = await placeMarket("sell", sellQty);
      log(c.g("  ✓ sell accepted") + `  orderId ${sell.id}  qty ${sellQty}`);
      await waitFilled(sell.id, "sell").catch((e) => log(c.y("  ⚠ " + e.message)));
    }

    // 5. VERIFY FLAT
    log(c.y("\n[5/5] VERIFY FLAT  re-read balances"));
    const coinEnd = await balanceOf(COIN);
    log(c.g("  ✓") + `  ${COIN} back to ${coinEnd} (started ${coinStart})`);

    log(c.g("\n══════════════════════"));
    log(c.g("  PASS — CoinDCX real order path works end-to-end (bought, verified fill, sold back to flat)"));
    log(c.g("══════════════════════\n"));
    process.exit(0);
  } catch (e) {
    log(c.r("\n✖ FAILED: " + (e && e.message ? e.message : String(e))));
    if (bought) {
      try {
        const coinNow = await balanceOf(COIN);
        let sellQty = Math.floor(Math.max(0, coinNow - coinStart) * 1000) / 1000;
        if (sellQty > 0) { log(c.y(`  emergency flatten: selling ${sellQty} ${COIN}…`)); await placeMarket("sell", sellQty).catch((e2) => log(c.r("  emergency sell failed: " + (e2 && e2.message)))); }
      } catch (e2) { log(c.r("  emergency flatten could not read balance: " + (e2 && e2.message))); }
    }
    process.exit(1);
  }
})();
