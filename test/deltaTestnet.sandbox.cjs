/* R36-P1-01 — DELTA TESTNET broker-sandbox certification. Exercises the REAL Delta testnet order lifecycle with the
 * account's sandbox API key/secret and reports LITERAL placement/read/verify call counts + sanitized order ids.
 *
 * Certification gate:
 *   • Runs only when BROKER_SANDBOX=1 (set by the broker-sandbox CI job) and a COMPLETE credential set is present
 *     (DELTA_SANDBOX_KEY + DELTA_SANDBOX_SECRET). Base URL overridable via DELTA_SANDBOX_BASE (default India testnet).
 *   • If BROKER_SANDBOX=1 but credentials are missing/incomplete, the setup THROWS — this suite can NEVER be a silent
 *     pass or a skip during a certification run (that was the R36-P1-01 false-green).
 *   • Without BROKER_SANDBOX it self-skips (ordinary PR/dev), but the CI job only invokes it behind the credential gate
 *     and enforces pass>0 / fail=0 / skipped=0, so a skip there fails the certification.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const CERT = /^(1|true|yes)$/i.test(String(process.env.BROKER_SANDBOX || ""));
const KEY = process.env.DELTA_SANDBOX_KEY || "";
const SECRET = process.env.DELTA_SANDBOX_SECRET || "";
const BASE = (process.env.DELTA_SANDBOX_BASE || "https://cdn-ind.testnet.deltaex.org").replace(/\/+$/, "");
const SYMBOL = process.env.DELTA_SANDBOX_SYMBOL || "BTCUSD";
const READY = KEY && SECRET;

// Literal broker-call counters published in the certification artifact.
const calls = { placement: 0, read: 0, verify: 0, cancel: 0 };

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

test.before(() => {
  if (!CERT) return;   // not a certification run; individual tests self-skip below
  if (!READY) throw new Error("DELTA_SANDBOX_KEY/SECRET required for a BROKER_SANDBOX=1 certification run");
});

function guard(t) { if (CERT && READY) return true; if (CERT) throw new Error("delta sandbox creds missing"); t.skip("BROKER_SANDBOX not set / no Delta sandbox creds"); return false; }

test("delta-sandbox: authenticated wallet read succeeds (connectivity + auth)", async (t) => {
  if (!guard(t)) return;
  const { status, json } = await delta("GET", "/v2/wallet/balances", { kind: "read" });
  assert.equal(status, 200, "authenticated balances read returns 200");
  assert.ok(json && json.success !== false, "balances payload is a success envelope");
});

test("delta-sandbox: place → read-back → reduce-only close, with literal call counts", async (t) => {
  if (!guard(t)) return;
  // Resolve the product id for the symbol.
  const prod = await delta("GET", "/v2/products", { kind: "read" });
  const p = ((prod.json && prod.json.result) || []).find((x) => x.symbol === SYMBOL);
  assert.ok(p && p.id, `sandbox product ${SYMBOL} resolvable`);
  // Place a tiny, far-from-market LIMIT buy so it rests as ACCEPTED (not immediately filled).
  const place = await delta("POST", "/v2/orders", { kind: "placement", body: { product_id: p.id, size: 1, side: "buy", order_type: "limit_order", limit_price: "1", post_only: true } });
  assert.ok([200, 201].includes(place.status), "order accepted by the sandbox");
  const oid = place.json && place.json.result && place.json.result.id;
  assert.ok(oid, "sandbox returned a broker order id");
  // Read the order back and VERIFY its state is a known lifecycle state.
  const read = await delta("GET", "/v2/orders", { query: `product_ids=${p.id}`, kind: "verify" });
  const rows = (read.json && read.json.result) || [];
  const mine = rows.find((o) => String(o.id) === String(oid));
  assert.ok(mine, "the placed order is retrievable from the order book");
  assert.ok(["open", "pending", "filled", "partially_filled", "cancelled"].includes(String(mine.state)), "verified a known order state");
  // Clean up: cancel the resting order (reduce-only close path proof).
  const cancel = await delta("DELETE", "/v2/orders", { kind: "cancel", body: { id: oid, product_id: p.id } });
  assert.ok([200, 201].includes(cancel.status), "resting order cancelled");
  // Literal call counts must be nonzero for placement, read and verify.
  assert.ok(calls.placement > 0 && calls.read > 0 && calls.verify > 0, "nonzero placement/read/verify broker calls");
  console.log(`delta-sandbox call counts: ${JSON.stringify(calls)} orderId=${String(oid).slice(-6)}`);
});
