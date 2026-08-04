/* R37-P2-01 — DELTA TESTNET real-money certification. This is NOT a place+cancel smoke test. It proves the safety
 * invariants required for unattended real-money execution against the Delta India TESTNET:
 *   1. authenticated wallet read (connectivity + auth);
 *   2. a REAL FILL — a marketable reduce-safe order that actually executes, verified from BROKER TRUTH (/v2/fills):
 *      nonzero filled size + a positive average fill price;
 *   3. reduce-only CLOSE — an opposite-side reduce_only order that flattens the position, verified by re-reading the
 *      position to net-zero (not a cancel of a resting order — the R36/R37 mislabel is removed);
 *   4. a REJECTION path — an obviously-invalid order is rejected by the venue (proves error handling is exercised).
 * It publishes LITERAL, independent counters: placement, fillVerify, close, reject — and the certification gate requires
 * ALL of placement>0, fillVerify>0 and close>0 (a run that never filled or never closed CANNOT pass).
 *
 * Gate:
 *   • Runs only when BROKER_SANDBOX=1 AND a COMPLETE credential set (DELTA_SANDBOX_KEY + DELTA_SANDBOX_SECRET) is set.
 *   • BROKER_SANDBOX=1 with missing creds ⇒ setup THROWS (never a silent pass/skip — the R36-P1-01 false-green).
 *   • Without BROKER_SANDBOX it self-skips (ordinary PR/dev); the CI job invokes it behind the credential gate and
 *     enforces pass>0 / fail=0 / skipped=0.
 *
 * SAFETY: testnet only (paper funds). Size is the venue minimum. Every path is reduce-safe: we open a tiny position and
 * immediately close it reduce-only, then assert flat. DELTA_SANDBOX_MAX_SIZE caps the contract size (default 1).
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const CERT = /^(1|true|yes)$/i.test(String(process.env.BROKER_SANDBOX || ""));
const KEY = process.env.DELTA_SANDBOX_KEY || "";
const SECRET = process.env.DELTA_SANDBOX_SECRET || "";
const BASE = (process.env.DELTA_SANDBOX_BASE || "https://cdn-ind.testnet.deltaex.org").replace(/\/+$/, "");
const SYMBOL = process.env.DELTA_SANDBOX_SYMBOL || "BTCUSD";
const MAX_SIZE = Math.max(1, Number(process.env.DELTA_SANDBOX_MAX_SIZE) || 1);
const READY = KEY && SECRET;

// Literal, INDEPENDENT broker-call counters published in the certification artifact.
const calls = { placement: 0, read: 0, verify: 0, fillVerify: 0, close: 0, reject: 0, cancel: 0 };

function sign(method, path, body, ts) {
  const payload = method + ts + path + (body || "");
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}
async function delta(method, path, { query = "", body = null, kind = "read" } = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const full = path + (query ? `?${query}` : "");
  const bodyStr = body ? JSON.stringify(body) : "";
  const sig = sign(method, full, bodyStr, ts);
  calls[kind] = (calls[kind] || 0) + 1;
  const r = await fetch(BASE + full, {
    method,
    headers: { "api-key": KEY, "signature": sig, "timestamp": ts, "Content-Type": "application/json", "User-Agent": "matrix-sandbox-cert" },
    body: body ? bodyStr : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test.before(() => {
  if (!CERT) return;   // not a certification run; individual tests self-skip below
  if (!READY) throw new Error("DELTA_SANDBOX_KEY/SECRET required for a BROKER_SANDBOX=1 certification run");
});

function guard(t) { if (CERT && READY) return true; if (CERT) throw new Error("delta sandbox creds missing"); t.skip("BROKER_SANDBOX not set / no Delta sandbox creds"); return false; }

async function resolveProduct() {
  const prod = await delta("GET", "/v2/products", { kind: "read" });
  const p = ((prod.json && prod.json.result) || []).find((x) => x.symbol === SYMBOL);
  assert.ok(p && p.id, `sandbox product ${SYMBOL} resolvable`);
  return p;
}
async function netPositionSize(productId) {
  const pos = await delta("GET", "/v2/positions", { query: `product_id=${productId}`, kind: "verify" });
  const rows = pos.json && (Array.isArray(pos.json.result) ? pos.json.result : [pos.json.result]).filter(Boolean);
  const mine = (rows || []).find((r) => r && String(r.product_id) === String(productId));
  return mine ? Number(mine.size || 0) : 0;
}

test("delta-sandbox: authenticated wallet read succeeds (connectivity + auth)", async (t) => {
  if (!guard(t)) return;
  const { status, json } = await delta("GET", "/v2/wallet/balances", { kind: "read" });
  assert.equal(status, 200, "authenticated balances read returns 200");
  assert.ok(json && json.success !== false, "balances payload is a success envelope");
});

test("delta-sandbox: rejection path — an invalid order is rejected by the venue", async (t) => {
  if (!guard(t)) return;
  const p = await resolveProduct();
  // Zero size is invalid; the venue must reject it (proves our error path is actually exercised, not assumed).
  const bad = await delta("POST", "/v2/orders", { kind: "reject", body: { product_id: p.id, size: 0, side: "buy", order_type: "market_order" } });
  assert.ok(bad.status >= 400 || (bad.json && bad.json.success === false), "invalid order rejected by venue");
  assert.ok(calls.reject > 0, "nonzero rejection-path calls");
});

test("delta-sandbox: REAL fill (broker-truth verified) → reduce-only CLOSE → flat, with literal counts", async (t) => {
  if (!guard(t)) return;
  const p = await resolveProduct();
  const size = Math.min(MAX_SIZE, 1);

  // Ensure we start flat for a clean, reduce-safe journey.
  const startSize = await netPositionSize(p.id);
  assert.equal(startSize, 0, "starting flat (no residual testnet position)");

  // 1) OPEN with a MARKET order so it actually FILLS (not a resting limit). Testnet paper funds only.
  const open = await delta("POST", "/v2/orders", { kind: "placement", body: { product_id: p.id, size, side: "buy", order_type: "market_order" } });
  assert.ok([200, 201].includes(open.status), "market open accepted by the sandbox");
  const oid = open.json && open.json.result && open.json.result.id;
  assert.ok(oid, "sandbox returned a broker order id");

  // 2) VERIFY the fill from BROKER TRUTH (/v2/fills): nonzero filled size + positive average price.
  let filledSize = 0, avgPx = 0;
  for (let attempt = 0; attempt < 8 && filledSize <= 0; attempt++) {
    await sleep(400);
    const fills = await delta("GET", "/v2/fills", { query: `product_ids=${p.id}`, kind: "fillVerify" });
    const rows = (fills.json && fills.json.result) || [];
    const mine = rows.filter((f) => String(f.order_id) === String(oid));
    filledSize = mine.reduce((s, f) => s + Math.abs(Number(f.size || 0)), 0);
    if (mine.length) { const f = mine[0]; avgPx = Number(f.price || f.fill_price || 0); }
  }
  assert.ok(filledSize > 0, "broker /v2/fills confirms a nonzero FILLED size (real execution, not just acceptance)");
  assert.ok(avgPx > 0, "broker fill carries a positive average fill price");

  // Confirm the position actually opened (net long).
  const openPos = await netPositionSize(p.id);
  assert.ok(openPos > 0, "position opened net long after the fill");

  // 3) REDUCE-ONLY CLOSE — opposite side, reduce_only, sized to the open position. This is the real close path used by
  //    the auto-exit executor (not a cancel of a resting order).
  const close = await delta("POST", "/v2/orders", { kind: "close", body: { product_id: p.id, size: Math.abs(openPos), side: "sell", order_type: "market_order", reduce_only: true } });
  assert.ok([200, 201].includes(close.status), "reduce-only close accepted");

  // 4) VERIFY FLAT — re-read the position until it nets to zero.
  let endSize = openPos;
  for (let attempt = 0; attempt < 8 && endSize !== 0; attempt++) { await sleep(400); endSize = await netPositionSize(p.id); }
  assert.equal(endSize, 0, "position is flat after the reduce-only close (verified from broker truth)");

  // Independent counters must ALL be nonzero: we placed, we verified a real fill, and we closed.
  assert.ok(calls.placement > 0 && calls.fillVerify > 0 && calls.close > 0, "nonzero placement/fillVerify/close broker calls");
  console.log(`delta-sandbox call counts: ${JSON.stringify(calls)} filled=${filledSize} avg=${avgPx} orderId=${String(oid).slice(-6)}`);
});
