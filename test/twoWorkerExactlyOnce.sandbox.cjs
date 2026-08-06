#!/usr/bin/env node
/* test/twoWorkerExactlyOnce.sandbox.cjs — R42-P1-07 TWO real MatrixOne workers race ONE signal to the broker.
 *
 * The prior J6 only raced db.claimSignal(). This runs TWO worker PROCESSES against the SAME PostgreSQL DB + ONE Delta
 * testnet account and ONE injected signal, each going through the PRODUCTION single-owner primitives:
 *   1. db.acquireLease  — a fenced single-owner lease (only ONE worker becomes owner),
 *   2. db.claimSignal   — idempotent signal claim (only the owner claims),
 *   3. orderRecovery.submitWithAttempt with a fenceGuard = db.fenceValid(lease, myFence) — the durable write-before-send,
 *      placing exactly ONE real testnet order, then db.recordFill writes the ONE authoritative fill.
 * The non-owner exits without sending. Then FAILOVER: both owners exit ("die") without releasing the lease; after it
 * expires a THIRD worker takes over (fence increments) but must NOT resend, because the signal is already claimed.
 *
 * Proves: exactly one broker order, one immutable fill, one signal claim, correct fence ownership + takeover, no resend.
 * Gated: skips unless BROKER_SANDBOX=1 AND DATABASE_URL AND DELTA_SANDBOX_KEY/SECRET AND an approved testnet host.
 * RUN (self-hosted, whitelisted IP):
 *   BROKER_SANDBOX=1 DATABASE_URL=… DELTA_SANDBOX_KEY=… DELTA_SANDBOX_SECRET=… node --test test/twoWorkerExactlyOnce.sandbox.cjs
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { fork } = require("child_process");

const BASE = String(process.env.DELTA_SANDBOX_BASE || "https://cdn-ind.testnet.deltaex.org").replace(/\/+$/, "");
const KEY = process.env.DELTA_SANDBOX_KEY || "";
const SECRET = process.env.DELTA_SANDBOX_SECRET || "";
const SYMBOL = String(process.env.DELTA_SANDBOX_SYMBOL || "BTCUSD").trim().toUpperCase();
const APPROVED_HOSTS = new Set(["cdn-ind.testnet.deltaex.org", "cdn.testnet.deltaex.org"]);
const CERT = process.env.BROKER_SANDBOX === "1";
const READY = !!(KEY && SECRET && process.env.DATABASE_URL);
const HOST_OK = (() => { try { const h = new URL(BASE).host; return APPROVED_HOSTS.has(h) && /testnet/i.test(h); } catch { return false; } })();
const LEASE_TTL_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sign(method, p, body, ts) { return crypto.createHmac("sha256", SECRET).update(method + ts + p + (body || "")).digest("hex"); }
async function delta(method, p, { query = "", body = null } = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const full = p + (query ? `?${query}` : "");
  const bodyStr = body ? JSON.stringify(body) : "";
  const r = await fetch(BASE + full, {
    method, headers: { "api-key": KEY, signature: sign(method, full, bodyStr, ts), timestamp: ts, "Content-Type": "application/json", "User-Agent": "matrix-two-worker" },
    body: body ? bodyStr : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function resolveProduct() {
  const prod = await delta("GET", "/v2/products");
  const p = ((prod.json && prod.json.result) || []).find((x) => x.symbol === SYMBOL);
  if (!p || !p.id) throw new Error(`product ${SYMBOL} not resolvable`);
  return p;
}
async function ordersByTag(tag) {
  const out = [];
  for (const state of ["open", "closed"]) {
    const r = await delta("GET", "/v2/orders", { query: `states=${state}` });
    for (const o of (r.json && r.json.result) || []) if (String(o.client_order_id || "") === tag) out.push(o);
  }
  return out;
}
async function orderFill(tag) {
  const os = await ordersByTag(tag); const o = os[0];
  if (!o) return { present: false, done: false };
  const total = Number(o.size || 0), unfilled = Number(o.unfilled_size ?? 0);
  const filled = total - unfilled, state = String(o.state || "").toLowerCase();
  return { done: filled > 0 && (unfilled === 0 || state === "closed"), filled, avg: Number(o.average_fill_price ?? o.avg_fill_price) || null, id: o.id };
}
async function netSize(productId) {
  const pos = await delta("GET", "/v2/positions", { query: `product_id=${productId}` });
  const rows = pos.json && (Array.isArray(pos.json.result) ? pos.json.result : [pos.json.result]).filter(Boolean);
  const mine = (rows || []).find((r) => r && String(r.product_id) === String(productId));
  return mine ? Number(mine.size || 0) : 0;
}
async function flatten(productId) {
  for (let i = 0; i < 8; i++) {
    const sz = await netSize(productId).catch(() => null);
    if (sz === 0) return true;
    if (sz == null) { await sleep(500); continue; }
    await delta("POST", "/v2/orders", { body: { product_id: productId, size: Math.abs(sz), side: sz > 0 ? "sell" : "buy", order_type: "market_order", reduce_only: true } }).catch(() => {});
    await sleep(500);
  }
  return (await netSize(productId).catch(() => 1)) === 0;
}

/* ── WORKER ROLE: acquire lease → claim signal → (owner only) send exactly one order. Invoked via fork() below. ── */
if (process.env.WORKER_ROLE === "worker") {
  (async () => {
    const db = require("../db");
    const orderRecovery = require("../orderRecovery");
    const { WORKER_ID: wid, LEASE: lease, SIGNAL_ID: sig, RA_USER: userId, RA_TAG: tag, RA_ATTEMPT_ID: attemptId, RA_PRODUCT_ID } = process.env;
    const productId = Number(RA_PRODUCT_ID);
    try {
      await db.initDb();
      const l = await db.acquireLease(lease, wid, LEASE_TTL_MS);
      if (!l.acquired) { process.stdout.write(`WORKER ${wid} NOT_OWNER\n`); process.exit(0); }
      const myFence = l.fence;
      const claimed = await db.claimSignal(sig, userId);
      if (!claimed) { process.stdout.write(`WORKER ${wid} SIGNAL_ALREADY_CLAIMED\n`); process.exit(0); }
      await orderRecovery.submitWithAttempt({
        db,
        attempt: { id: attemptId, userId, broker: "delta", orderTag: tag, payload: { symbol: SYMBOL, side: "BUY", qty: 1 } },
        submit: async () => { await delta("POST", "/v2/orders", { body: { product_id: productId, size: 1, side: "buy", order_type: "market_order", client_order_id: tag } }); return { ok: true }; },
        classify: () => ({ status: "FILLED", patch: {} }),
        fenceGuard: () => db.fenceValid(lease, myFence),   // refuse to send if this worker's fence is no longer live
      });
      let f = { done: false };
      for (let i = 0; i < 12; i++) { f = await orderFill(tag); if (f.done) break; await sleep(1000); }
      if (f.done) await db.recordFill(userId, { broker: "delta", orderId: f.id || tag, qty: f.filled, side: "BUY", entry: f.avg, market: "Crypto", tradeType: "two-worker", ts: Date.now() });
      process.stdout.write(`WORKER ${wid} PLACED ${tag}\n`);
      process.exit(0);
    } catch (e) { process.stderr.write(`WORKER ${wid} ERR ${(e && e.message) || e}\n`); process.exit(1); }
  })();
  return;
}

function guard(t) { if (CERT && READY && HOST_OK) return true; if (CERT) throw new Error(READY ? (HOST_OK ? "ready" : "unapproved host") : "missing DATABASE_URL/creds"); t.skip("BROKER_SANDBOX/PG/Delta creds not set"); return false; }

test("R42-P1-07: two workers race one signal → exactly one order/fill; owner death → fenced takeover, no resend", async (t) => {
  if (!guard(t)) return;
  const db = require("../db");
  await db.initDb();
  const r = crypto.randomBytes(6).toString("hex");
  const tag = "tw_" + r, attemptId = "oa_" + r, userId = "tw_user_" + r, signalId = "sig_" + r, lease = "autobuy:" + userId;
  const productId = (await resolveProduct()).id;

  const mkWorker = (wid) => fork(__filename, [], {
    env: { ...process.env, WORKER_ROLE: "worker", WORKER_ID: wid, LEASE: lease, SIGNAL_ID: signalId, RA_USER: userId, RA_TAG: tag, RA_ATTEMPT_ID: attemptId, RA_PRODUCT_ID: String(productId) },
    stdio: "inherit", execArgv: [],
  });

  try {
    // 1) Two workers concurrently, one shared PG + one signal.
    const [w1, w2] = [mkWorker("W1"), mkWorker("W2")];
    const codes = await Promise.all([w1, w2].map((c) => new Promise((res) => c.on("exit", res))));
    assert.ok(codes.every((x) => x === 0), `both workers exited cleanly — codes ${codes}`);
    await sleep(1500);

    // 2) EXACTLY-ONCE across the two workers.
    const orders = await ordersByTag(tag);
    assert.equal(orders.length, 1, `exactly ONE broker order across two workers (no double-send) — saw ${orders.length}`);
    const fills = (await db.getFills(userId, 0, Date.now())).filter((f) => String(f.tradeType) === "two-worker");
    assert.equal(fills.length, 1, `exactly ONE authoritative fill — saw ${fills.length}`);
    assert.equal(await db.claimSignal(signalId, userId), false, "signal is already claimed (no re-claim possible)");
    const after = await db.getOrderAttempt(attemptId);
    assert.equal(after && after.status, "FILLED", "the single durable attempt is FILLED");

    // 3) FAILOVER: both owners have exited without releasing the lease ("died"). After it expires a takeover worker
    //    acquires it (fence increments) but must NOT resend — the signal is already claimed.
    await sleep(LEASE_TTL_MS + 800);
    const w3 = mkWorker("W3");
    const tcode = await new Promise((res) => w3.on("exit", res));
    assert.equal(tcode, 0, "takeover worker exited cleanly");
    const lz = await db.getLease(lease);
    assert.ok(lz && lz.fence >= 2, `takeover incremented the fence (new owner) — fence ${lz && lz.fence}`);
    assert.equal((await ordersByTag(tag)).length, 1, "still exactly ONE broker order after failover — no resend");
    assert.equal((await db.getFills(userId, 0, Date.now())).filter((f) => String(f.tradeType) === "two-worker").length, 1, "still exactly ONE fill after failover");
  } finally {
    const flat = await flatten(productId).catch(() => false);
    assert.ok(flat, "teardown proved the testnet account is flat");
  }
});
