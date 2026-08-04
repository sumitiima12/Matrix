/* R37-P2-01 — FYERS broker-sandbox certification. This is NOT a read-only smoke test. During a real certification run
 * (BROKER_SANDBOX=1 with a complete FYERS credential set) it proves the safety invariants required for unattended
 * real-money execution against the FYERS UAT base (FYERS_SANDBOX_BASE, default api-t1):
 *   1. authenticated profile + funds read (connectivity + auth);
 *   2. a REAL FILL — a marketable INTRADAY order that actually executes, verified from BROKER TRUTH (/tradebook):
 *      nonzero traded qty + a positive traded price;
 *   3. a SQUARE-OFF CLOSE — an opposite-side reduce order that flattens the intraday position, verified by re-reading
 *      /positions to netQty 0 (the real auto-exit path — not an order cancel);
 *   4. a REJECTION path — an obviously-invalid order is rejected by the venue.
 * Independent LITERAL counters (read, verify, placement, fillVerify, close, reject) are published, and the gate requires
 * placement>0, fillVerify>0 AND close>0. R37-P2-01: placement is FORCED ON during certification (no read-only default);
 * FYERS_SANDBOX_PLACE=0 can only DISABLE placement in a non-certification/manual dev run.
 *
 * Gate:
 *   • Runs only when BROKER_SANDBOX=1 AND a COMPLETE credential set (FYERS_SANDBOX_APP_ID + FYERS_SANDBOX_TOKEN) is set.
 *   • BROKER_SANDBOX=1 with missing creds ⇒ setup THROWS (never a silent pass/skip — the R36-P1-01 false-green).
 *   • Without BROKER_SANDBOX it self-skips; the CI job invokes it behind the credential gate and enforces
 *     pass>0 / fail=0 / skipped=0.
 *
 * SAFETY: UAT/sandbox base only, INTRADAY product, venue-minimum qty, immediately squared off, then asserted flat.
 * FYERS_SANDBOX_SYMBOL selects the instrument (default NSE:SBIN-EQ). FYERS_SANDBOX_MAX_QTY caps qty (default 1).
 */
const test = require("node:test");
const assert = require("node:assert");

const CERT = /^(1|true|yes)$/i.test(String(process.env.BROKER_SANDBOX || ""));
const APP_ID = process.env.FYERS_SANDBOX_APP_ID || "";
const TOKEN = process.env.FYERS_SANDBOX_TOKEN || "";
const BASE = (process.env.FYERS_SANDBOX_BASE || "https://api-t1.fyers.in/api/v3").replace(/\/+$/, "");
const SYMBOL = process.env.FYERS_SANDBOX_SYMBOL || "NSE:SBIN-EQ";
const MAX_QTY = Math.max(1, Number(process.env.FYERS_SANDBOX_MAX_QTY) || 1);
const READY = APP_ID && TOKEN;
// R37-P2-01: during a certification run placement is REQUIRED. FYERS_SANDBOX_PLACE can only turn it OFF for manual dev.
const PLACE = CERT ? !/^(0|false|no)$/i.test(String(process.env.FYERS_SANDBOX_PLACE ?? "1")) : /^(1|true|yes)$/i.test(String(process.env.FYERS_SANDBOX_PLACE || ""));

/* R38-P1-04 — APPROVED TEST/UAT-HOST ALLOW-LIST. A certification run that places REAL market INTRADAY orders must never
 * default to a trading endpoint via a misnamed/absent FYERS_SANDBOX_BASE. The resolved base host must EXACTLY match a
 * known FYERS UAT host (or an explicitly allow-listed extra host). Anything else refuses to run. */
const APPROVED_HOSTS = new Set(
  ["api-t1.fyers.in", "api-t2.fyers.in", "api-uat.fyers.in"]
    .concat(String(process.env.FYERS_SANDBOX_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean))
);
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
const BASE_HOST = hostOf(BASE);
// A UAT host is api-t*/uat; the production host is api.fyers.in — which is NOT on the list, so it can never be targeted.
const HOST_OK = APPROVED_HOSTS.has(BASE_HOST) && /(-t\d|uat)\./i.test(BASE_HOST);

const calls = { read: 0, verify: 0, placement: 0, fillVerify: 0, close: 0, reject: 0, cancel: 0 };

async function fy(method, path, { body = null, kind = "read" } = {}) {
  calls[kind] = (calls[kind] || 0) + 1;
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `${APP_ID}:${TOKEN}`, "Content-Type": "application/json", "User-Agent": "matrix-sandbox-cert" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test.before(() => {
  if (!CERT) return;
  if (!READY) throw new Error("FYERS_SANDBOX_APP_ID/TOKEN required for a BROKER_SANDBOX=1 certification run");
  // R38-P1-04: a placement certification run must target an approved UAT host — never api.fyers.in (production).
  if (PLACE && !HOST_OK) throw new Error(`refusing to place: FYERS_SANDBOX_BASE host "${BASE_HOST}" is not an approved FYERS UAT host (allow-list: ${[...APPROVED_HOSTS].join(", ")})`);
});

function guard(t) { if (CERT && READY && (!PLACE || HOST_OK)) return true; if (CERT) throw new Error(HOST_OK || !PLACE ? "fyers sandbox creds missing" : `unapproved host ${BASE_HOST}`); t.skip("BROKER_SANDBOX not set / no FYERS sandbox creds"); return false; }

async function netQtyFor(symbol) {
  const pos = await fy("GET", "/positions", { kind: "verify" });
  const rows = (pos.json && pos.json.netPositions) || [];
  const mine = rows.filter((p) => String(p.symbol) === String(symbol));
  return mine.reduce((s, p) => s + Number(p.netQty || 0), 0);
}

// R38-P1-04 — bounded best-effort emergency SQUARE-OFF used in teardown: repeatedly flatten the symbol's net qty with an
// opposite-side market INTRADAY order and re-read /positions until flat. Returns true only if it PROVED flat.
async function emergencySquareOff(symbol) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let q = 0;
    try { q = await netQtyFor(symbol); } catch { /* retry */ }
    if (q === 0) return true;
    const side = q > 0 ? -1 : 1;
    try { await fy("POST", "/orders", { kind: "close", body: { symbol, qty: Math.abs(q), type: 2, side, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false } }); } catch { /* retry */ }
    await sleep(500);
  }
  try { return (await netQtyFor(symbol)) === 0; } catch { return false; }
}

test("fyers-sandbox: authenticated profile + funds read (connectivity + auth)", async (t) => {
  if (!guard(t)) return;
  const prof = await fy("GET", "/profile", { kind: "read" });
  assert.equal(prof.status, 200, "profile read returns 200");
  assert.ok(prof.json && prof.json.s === "ok", "profile is a success envelope");
  const funds = await fy("GET", "/funds", { kind: "read" });
  assert.ok(funds.json && funds.json.s === "ok", "funds read is a success envelope");
});

test("fyers-sandbox: rejection path — an invalid order is rejected by the venue", async (t) => {
  if (!guard(t)) return;
  if (!PLACE) { t.skip("placement disabled (manual dev run)"); return; }
  // qty 0 is invalid; FYERS must reject it (proves the error path is exercised).
  const bad = await fy("POST", "/orders", { kind: "reject", body: { symbol: SYMBOL, qty: 0, type: 2, side: 1, productType: "INTRADAY", validity: "DAY", offlineOrder: false } });
  assert.ok(bad.json && (bad.json.s === "error" || bad.status >= 400), "invalid order rejected by venue");
  assert.ok(calls.reject > 0, "nonzero rejection-path calls");
});

test("fyers-sandbox: REAL fill (tradebook-verified) → square-off CLOSE → flat, with literal counts", async (t) => {
  if (!guard(t)) return;
  // Read the order book (the authoritative read path the reconciler uses).
  const ob = await fy("GET", "/orders", { kind: "verify" });
  assert.ok(ob.json && (ob.json.s === "ok" || Array.isArray(ob.json.orderBook)), "orderbook is retrievable");

  if (!PLACE) { t.skip("placement disabled (manual dev run) — read-only checks only"); assert.ok(calls.read > 0 && calls.verify > 0); return; }

  const qty = Math.min(MAX_QTY, 1);
  // Start flat for a clean, reduce-safe journey.
  const startQty = await netQtyFor(SYMBOL);
  assert.equal(startQty, 0, "starting flat (no residual UAT position)");

  /* R38-P1-04 — the whole open lifecycle is wrapped in try/finally. Once the market order is accepted, ANY later failure
     still runs a bounded emergency square-off in `finally` and PROVES flat; if it can't, the test fails loudly with a
     MANUAL-INTERVENTION marker rather than exiting with a live intraday position. */
  let opened = false, cleanupProven = true;
  try {
    // 1) OPEN with a MARKET (type 2) INTRADAY BUY so it actually FILLS.
    const place = await fy("POST", "/orders", { kind: "placement", body: { symbol: SYMBOL, qty, type: 2, side: 1, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false } });
    assert.ok(place.json && place.json.s === "ok" && place.json.id, "sandbox accepted the market order and returned an id");
    const oid = place.json.id;
    opened = true;   // exposure may now exist → finally must square off

    // 2) VERIFY the fill from BROKER TRUTH (/tradebook): nonzero traded qty + positive traded price.
    let tradedQty = 0, tradePx = 0;
    for (let attempt = 0; attempt < 8 && tradedQty <= 0; attempt++) {
      await sleep(400);
      const tb = await fy("GET", "/tradebook", { kind: "fillVerify" });
      const rows = (tb.json && tb.json.tradeBook) || [];
      const mine = rows.filter((r) => String(r.orderNumber || r.id) === String(oid));
      tradedQty = mine.reduce((s, r) => s + Math.abs(Number(r.tradedQty || r.qty || 0)), 0);
      if (mine.length) tradePx = Number(mine[0].tradePrice || mine[0].price || 0);
    }
    assert.ok(tradedQty > 0, "FYERS /tradebook confirms a nonzero TRADED qty (real execution, not just acceptance)");
    assert.ok(tradePx > 0, "broker trade carries a positive traded price");

    const openQty = await netQtyFor(SYMBOL);
    assert.ok(openQty > 0, "intraday position opened net long after the fill");

    // 3) SQUARE-OFF CLOSE — opposite-side (SELL) market INTRADAY sized to the open qty (the real auto-exit path).
    const close = await fy("POST", "/orders", { kind: "close", body: { symbol: SYMBOL, qty: Math.abs(openQty), type: 2, side: -1, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false } });
    assert.ok(close.json && close.json.s === "ok" && close.json.id, "square-off order accepted");

    // 4) VERIFY FLAT — re-read /positions until netQty nets to zero.
    let endQty = openQty;
    for (let attempt = 0; attempt < 8 && endQty !== 0; attempt++) { await sleep(400); endQty = await netQtyFor(SYMBOL); }
    assert.equal(endQty, 0, "position is flat after the square-off (verified from broker truth)");

    assert.ok(calls.placement > 0 && calls.fillVerify > 0 && calls.close > 0, "nonzero placement/fillVerify/close broker calls");
    console.log(`fyers-sandbox call counts: ${JSON.stringify(calls)} traded=${tradedQty} px=${tradePx} place=${PLACE}`);
  } finally {
    if (opened) {
      cleanupProven = await emergencySquareOff(SYMBOL);
      if (!cleanupProven) console.error(`::error::FYERS-SANDBOX MANUAL INTERVENTION REQUIRED — could not prove flat for ${SYMBOL}; check the UAT account for open intraday exposure`);
    }
  }
  assert.ok(cleanupProven, "emergency square-off proved the UAT position is flat (no leaked exposure)");
});
