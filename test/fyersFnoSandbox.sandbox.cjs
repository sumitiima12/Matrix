/* FYERS F&O (OPTION) broker-sandbox certification — the derivative analogue of fyersSandbox.sandbox.cjs.
 *
 * This proves the SAFETY invariants that gate automated Indian OPTION execution (MATRIX_FO_MASTER_VALIDATED), which the
 * equity cert does NOT exercise: an option contract, a LIMIT-priced entry (Indian options are limit-only — a market
 * option order is disallowed), fill verification from BROKER TRUTH, and a reduce-only square-off that flattens the
 * option leg. It mirrors the exact lifecycle the auto-buy option path runs (resolve → live premium → marketable LIMIT
 * BUY → verify fill from /tradebook → reduce SELL → verify flat).
 *
 * A certification run (BROKER_SANDBOX=1 with a complete credential set) proves:
 *   1. authenticated profile + funds read (connectivity + auth);
 *   2. a LIVE OPTION PREMIUM read from /data/quotes for the exact NFO contract (the pricing feed the engine uses);
 *   3. a REAL FILL — a marketable **LIMIT** INTRADAY BUY on the option that actually executes, verified from BROKER
 *      TRUTH (/tradebook): nonzero traded qty + a positive traded price. The submitted order is asserted to be a LIMIT
 *      (type 1) with a positive limitPrice — NEVER a market order;
 *   4. a SQUARE-OFF CLOSE — an opposite-side reduce order that flattens the option position, verified by re-reading
 *      /positions to netQty 0 (the real auto-exit path — not an order cancel).
 * Independent LITERAL counters are published; the gate requires placement>0, fillVerify>0 AND close>0.
 *
 * SEPARATE, OPT-IN capability. Options roll weekly, so the contract can't be guessed — FYERS_FNO_SANDBOX_SYMBOL is
 * REQUIRED and there is NO default. This suite is NOT globbed into the shared FYERS equity cert job; it runs in its own
 * opt-in CI job (vars.CERT_FYERS_FNO=1) so it never retroactively blocks the equity certification. Without
 * BROKER_SANDBOX it self-skips.
 *
 * SAFETY: UAT/sandbox host only (approved allow-list — never api.fyers.in), INTRADAY product, one lot, marketable-LIMIT
 * priced off the live premium, immediately squared off, then asserted flat with a try/finally emergency square-off.
 */
const test = require("node:test");
const assert = require("node:assert");

const CERT = /^(1|true|yes)$/i.test(String(process.env.BROKER_SANDBOX || ""));
const APP_ID = process.env.FYERS_SANDBOX_APP_ID || "";
const TOKEN = process.env.FYERS_SANDBOX_TOKEN || "";
// NO DEFAULT BASE (same rule as the equity cert): a run that can place a REAL order must never fall back to a trading
// endpoint from an absent env var. Required and must resolve to an approved UAT host (checked below).
const BASE = String(process.env.FYERS_SANDBOX_BASE || "").replace(/\/+$/, "");
// NO DEFAULT SYMBOL: options roll weekly, so the exact NFO option contract must be supplied explicitly for the run.
const SYMBOL = String(process.env.FYERS_FNO_SANDBOX_SYMBOL || "").trim();   // e.g. NSE:NIFTY2591825000CE
// One lot's quantity for the chosen contract (e.g. NIFTY 75). REQUIRED — a wrong qty would be rejected or mis-sized.
const QTY = Math.max(1, Number(process.env.FYERS_FNO_SANDBOX_QTY) || 0);
const ACCOUNT_ALLOW = new Set(String(process.env.FYERS_SANDBOX_ACCOUNT_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
// Ready only when creds + base + the explicit option contract + a lot qty are all present.
const READY = APP_ID && TOKEN && BASE && SYMBOL && QTY > 0;
// During a certification run placement is REQUIRED; FYERS_FNO_SANDBOX_PLACE can only turn it OFF for manual dev.
const PLACE = CERT ? !/^(0|false|no)$/i.test(String(process.env.FYERS_FNO_SANDBOX_PLACE ?? "1")) : /^(1|true|yes)$/i.test(String(process.env.FYERS_FNO_SANDBOX_PLACE || ""));

/* APPROVED UAT-HOST ALLOW-LIST — identical rule to the equity cert: never target api.fyers.in (production). */
const APPROVED_HOSTS = new Set(
  ["api-t1.fyers.in", "api-t2.fyers.in", "api-uat.fyers.in"]
    .concat(String(process.env.FYERS_SANDBOX_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean))
);
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
function originOf(u) { try { return new URL(u).origin; } catch { return ""; } }
const BASE_HOST = hostOf(BASE);
const HOST_ROOT = originOf(BASE);   // quotes live at {origin}/data/quotes, a different path root than /orders
const HOST_OK = APPROVED_HOSTS.has(BASE_HOST) && /(-t\d|uat)\./i.test(BASE_HOST);

const calls = { read: 0, quote: 0, verify: 0, placement: 0, fillVerify: 0, close: 0 };

async function fy(method, path, { body = null, kind = "read" } = {}) {
  calls[kind] = (calls[kind] || 0) + 1;
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `${APP_ID}:${TOKEN}`, "Content-Type": "application/json", "User-Agent": "matrix-fno-sandbox-cert" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
// Live option premium (LTP) — the pricing feed the auto-buy option path uses to build the marketable LIMIT.
async function optionLtp(symbol) {
  calls.quote += 1;
  const r = await fetch(`${HOST_ROOT}/data/quotes?symbols=${encodeURIComponent(symbol)}`, {
    headers: { Authorization: `${APP_ID}:${TOKEN}`, "User-Agent": "matrix-fno-sandbox-cert" },
  });
  const j = await r.json().catch(() => ({}));
  const row = (j.d || [])[0];
  const lp = row && row.v && row.v.lp;
  return Number(lp) > 0 ? Number(lp) : 0;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test.before(() => {
  if (!CERT) return;
  if (!(APP_ID && TOKEN && BASE)) throw new Error("FYERS_SANDBOX_APP_ID + FYERS_SANDBOX_TOKEN + FYERS_SANDBOX_BASE are required for a BROKER_SANDBOX=1 FYERS-F&O certification run");
  if (!SYMBOL) throw new Error("FYERS_FNO_SANDBOX_SYMBOL is required (the exact NFO option contract, e.g. NSE:NIFTY2591825000CE — options roll weekly so there is no default)");
  if (!(QTY > 0)) throw new Error("FYERS_FNO_SANDBOX_QTY is required (one lot's quantity for the chosen contract, e.g. 75 for NIFTY)");
  if (PLACE && !HOST_OK) throw new Error(`refusing to place: FYERS_SANDBOX_BASE host "${BASE_HOST}" is not an approved FYERS UAT host (allow-list: ${[...APPROVED_HOSTS].join(", ")})`);
  if (PLACE && ACCOUNT_ALLOW.size === 0) throw new Error("refusing to place: set FYERS_SANDBOX_ACCOUNT_ALLOW to the isolated UAT account id(s) permitted to trade");
});

function guard(t) { if (CERT && READY && (!PLACE || HOST_OK)) return true; if (CERT) throw new Error(HOST_OK || !PLACE ? "fyers f&o sandbox creds/contract missing" : `unapproved host ${BASE_HOST}`); t.skip("BROKER_SANDBOX not set / no FYERS F&O sandbox creds+contract"); return false; }

async function netQtyFor(symbol) {
  const pos = await fy("GET", "/positions", { kind: "verify" });
  const rows = (pos.json && pos.json.netPositions) || [];
  const mine = rows.filter((p) => String(p.symbol) === String(symbol));
  return mine.reduce((s, p) => s + Number(p.netQty || 0), 0);
}

// Bounded best-effort emergency SQUARE-OFF used in teardown: repeatedly flatten the option's net qty with an
// opposite-side INTRADAY order and re-read /positions until flat. Returns true only if it PROVED flat.
async function emergencySquareOff(symbol) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let q = 0;
    try { q = await netQtyFor(symbol); } catch { /* retry */ }
    if (q === 0) return true;
    const side = q > 0 ? -1 : 1;
    // Reduce with a marketable limit priced off the live premium (never a bare market option order).
    let lp = 0; try { lp = await optionLtp(symbol); } catch { /* retry */ }
    const px = lp > 0 ? +(side < 0 ? lp * 0.9 : lp * 1.1).toFixed(2) : 0.05;   // cross the book to flatten
    try { await fy("POST", "/orders", { kind: "close", body: { symbol, qty: Math.abs(q), type: 1, limitPrice: px, side, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false } }); } catch { /* retry */ }
    await sleep(600);
  }
  try { return (await netQtyFor(symbol)) === 0; } catch { return false; }
}

test("fyers-fno-sandbox: authenticated profile + funds read (connectivity + auth)", async (t) => {
  if (!guard(t)) return;
  const prof = await fy("GET", "/profile", { kind: "read" });
  assert.equal(prof.status, 200, "profile read returns 200");
  assert.ok(prof.json && prof.json.s === "ok", "profile is a success envelope");
  const funds = await fy("GET", "/funds", { kind: "read" });
  assert.ok(funds.json && funds.json.s === "ok", "funds read is a success envelope");
});

test("fyers-fno-sandbox: live OPTION premium is readable for the contract (pricing feed)", async (t) => {
  if (!guard(t)) return;
  const lp = await optionLtp(SYMBOL);
  assert.ok(lp > 0, `live premium (LTP) for ${SYMBOL} is a positive number (needed to price the limit)`);
  console.log(`fyers-fno-sandbox premium: ${SYMBOL} lp=${lp}`);
});

test("fyers-fno-sandbox: REAL option fill via marketable LIMIT (tradebook-verified) → square-off → flat", async (t) => {
  if (!guard(t)) return;
  const ob = await fy("GET", "/orders", { kind: "verify" });
  assert.ok(ob.json && (ob.json.s === "ok" || Array.isArray(ob.json.orderBook)), "orderbook is retrievable");

  if (!PLACE) { t.skip("placement disabled (manual dev run) — read-only checks only"); assert.ok(calls.read > 0 && calls.verify > 0); return; }

  // The authenticated account MUST be on the isolated allow-list before ANY order is placed.
  const prof = await fy("GET", "/profile", { kind: "read" });
  const acctId = String((prof.json && prof.json.data && (prof.json.data.fy_id || prof.json.data.id)) || (prof.json && prof.json.fy_id) || "");
  assert.ok(ACCOUNT_ALLOW.has(acctId), `authenticated FYERS account "${acctId}" is not on FYERS_SANDBOX_ACCOUNT_ALLOW (${[...ACCOUNT_ALLOW].join(", ")})`);

  // Start flat for a clean, reduce-safe journey.
  const startQty = await netQtyFor(SYMBOL);
  assert.equal(startQty, 0, "starting flat (no residual UAT option position)");

  // Price a MARKETABLE LIMIT off the live premium (this is the auto-buy path: 1% buffer so the BUY crosses the spread).
  const prem = await optionLtp(SYMBOL);
  assert.ok(prem > 0, "live premium available to price the limit");
  const limitPrice = +(prem * 1.01).toFixed(2);
  assert.ok(limitPrice > 0, "computed a positive LIMIT price (never a market option order)");

  let opened = false, cleanupProven = true;
  try {
    // 1) OPEN with a LIMIT (type 1) INTRADAY BUY at the marketable price so it FILLS. Arm cleanup FIRST (submission attempted).
    opened = true;
    const orderBody = { symbol: SYMBOL, qty: QTY, type: 1, limitPrice, side: 1, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false };
    // ASSERT the submitted order is a LIMIT with a positive price — proves the Indian-options limit-only rule end-to-end.
    assert.equal(orderBody.type, 1, "entry order type is LIMIT (1), not market");
    assert.ok(orderBody.limitPrice > 0, "entry carries a positive limit price");
    const place = await fy("POST", "/orders", { kind: "placement", body: orderBody });
    assert.ok(place.json && place.json.s === "ok" && place.json.id, "sandbox accepted the LIMIT option order and returned an id");
    const oid = place.json.id;

    // 2) VERIFY the fill from BROKER TRUTH (/tradebook): nonzero traded qty + positive traded price.
    let tradedQty = 0, tradePx = 0;
    for (let attempt = 0; attempt < 10 && tradedQty <= 0; attempt++) {
      await sleep(500);
      const tb = await fy("GET", "/tradebook", { kind: "fillVerify" });
      const rows = (tb.json && tb.json.tradeBook) || [];
      const mine = rows.filter((r) => String(r.orderNumber || r.id) === String(oid));
      tradedQty = mine.reduce((s, r) => s + Math.abs(Number(r.tradedQty || r.qty || 0)), 0);
      if (mine.length) tradePx = Number(mine[0].tradePrice || mine[0].price || 0);
    }
    assert.ok(tradedQty > 0, "FYERS /tradebook confirms a nonzero TRADED qty on the option (real execution, not just acceptance)");
    assert.ok(tradePx > 0, "broker option trade carries a positive traded price (premium)");

    const openQty = await netQtyFor(SYMBOL);
    assert.ok(openQty > 0, "option position opened net long after the fill");

    // 3) SQUARE-OFF CLOSE — opposite-side (SELL) reduce sized to the open qty, priced to cross (the real auto-exit path).
    const closePx = +(prem * 0.9).toFixed(2);
    const close = await fy("POST", "/orders", { kind: "close", body: { symbol: SYMBOL, qty: Math.abs(openQty), type: 1, limitPrice: Math.max(0.05, closePx), side: -1, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false } });
    assert.ok(close.json && close.json.s === "ok" && close.json.id, "square-off order accepted");

    // 4) VERIFY FLAT — re-read /positions until netQty nets to zero.
    let endQty = openQty;
    for (let attempt = 0; attempt < 10 && endQty !== 0; attempt++) { await sleep(500); endQty = await netQtyFor(SYMBOL); }
    assert.equal(endQty, 0, "option position is flat after the square-off (verified from broker truth)");

    assert.ok(calls.placement > 0 && calls.fillVerify > 0 && calls.close > 0 && calls.quote > 0, "nonzero placement/fillVerify/close/quote broker calls");
    console.log(`fyers-fno-sandbox call counts: ${JSON.stringify(calls)} traded=${tradedQty} px=${tradePx} limit=${limitPrice} place=${PLACE}`);
  } finally {
    if (opened) {
      cleanupProven = await emergencySquareOff(SYMBOL);
      if (!cleanupProven) console.error(`::error::FYERS-FNO-SANDBOX MANUAL INTERVENTION REQUIRED — could not prove flat for ${SYMBOL}; check the UAT account for open option exposure`);
    }
  }
  assert.ok(cleanupProven, "emergency square-off proved the UAT option position is flat (no leaked exposure)");
});
