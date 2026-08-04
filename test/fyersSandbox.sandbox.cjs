/* R36-P1-01 — FYERS broker-sandbox certification. FYERS has no public order-simulation endpoint, so certification runs
 * against a FYERS account token in the sandbox/UAT base (FYERS_SANDBOX_BASE) and exercises the authenticated
 * READ + ORDER-VERIFY lifecycle: profile → funds → orderbook → order-verify. If FYERS_SANDBOX_PLACE=1 (a genuine
 * sandbox that accepts test orders), it additionally places a far-from-market limit order, reads it back and cancels
 * it. It publishes LITERAL read/verify/placement call counts.
 *
 * Certification gate (same contract as the Delta suite):
 *   • Runs only when BROKER_SANDBOX=1 and a COMPLETE credential set (FYERS_SANDBOX_APP_ID + FYERS_SANDBOX_TOKEN) is set.
 *   • BROKER_SANDBOX=1 with missing creds ⇒ setup THROWS (never a silent pass/skip — the R36-P1-01 false-green).
 *   • Without BROKER_SANDBOX it self-skips; the CI job only invokes it behind the credential gate and enforces
 *     pass>0 / fail=0 / skipped=0.
 */
const test = require("node:test");
const assert = require("node:assert");

const CERT = /^(1|true|yes)$/i.test(String(process.env.BROKER_SANDBOX || ""));
const APP_ID = process.env.FYERS_SANDBOX_APP_ID || "";
const TOKEN = process.env.FYERS_SANDBOX_TOKEN || "";
const BASE = (process.env.FYERS_SANDBOX_BASE || "https://api-t1.fyers.in/api/v3").replace(/\/+$/, "");
const PLACE = /^(1|true|yes)$/i.test(String(process.env.FYERS_SANDBOX_PLACE || ""));
const READY = APP_ID && TOKEN;

const calls = { read: 0, verify: 0, placement: 0, cancel: 0 };

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

test.before(() => {
  if (!CERT) return;
  if (!READY) throw new Error("FYERS_SANDBOX_APP_ID/TOKEN required for a BROKER_SANDBOX=1 certification run");
});

function guard(t) { if (CERT && READY) return true; if (CERT) throw new Error("fyers sandbox creds missing"); t.skip("BROKER_SANDBOX not set / no FYERS sandbox creds"); return false; }

test("fyers-sandbox: authenticated profile + funds read (connectivity + auth)", async (t) => {
  if (!guard(t)) return;
  const prof = await fy("GET", "/profile", { kind: "read" });
  assert.equal(prof.status, 200, "profile read returns 200");
  assert.ok(prof.json && prof.json.s === "ok", "profile is a success envelope");
  const funds = await fy("GET", "/funds", { kind: "read" });
  assert.ok(funds.json && funds.json.s === "ok", "funds read is a success envelope");
});

test("fyers-sandbox: orderbook read + order-verify path (+ optional place/cancel), with literal call counts", async (t) => {
  if (!guard(t)) return;
  // Read the order book (the authoritative read path the reconciler uses to verify fills).
  const ob = await fy("GET", "/orders", { kind: "verify" });
  assert.ok(ob.json && (ob.json.s === "ok" || Array.isArray(ob.json.orderBook)), "orderbook is retrievable");
  if (PLACE) {
    // A genuine sandbox: place a far-from-market limit BUY (rests, not filled), read back, cancel.
    const place = await fy("POST", "/orders", { kind: "placement", body: { symbol: process.env.FYERS_SANDBOX_SYMBOL || "NSE:SBIN-EQ", qty: 1, type: 1, side: 1, productType: "CNC", limitPrice: 1, offlineOrder: false } });
    assert.ok(place.json && place.json.s === "ok" && place.json.id, "sandbox accepted the order and returned an id");
    const oid = place.json.id;
    const ob2 = await fy("GET", "/orders", { kind: "verify" });
    const rows = (ob2.json && ob2.json.orderBook) || [];
    assert.ok(rows.some((o) => String(o.id) === String(oid)), "placed order retrievable from the book");
    const cancel = await fy("DELETE", "/orders", { kind: "cancel", body: { id: oid } });
    assert.ok(cancel.json && cancel.json.s === "ok", "resting order cancelled");
    assert.ok(calls.placement > 0, "nonzero placement calls");
  }
  assert.ok(calls.read > 0 && calls.verify > 0, "nonzero read/verify broker calls");
  console.log(`fyers-sandbox call counts: ${JSON.stringify(calls)} place=${PLACE}`);
});
