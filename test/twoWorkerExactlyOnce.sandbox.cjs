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
// Delta drops a filled MARKET order out of /v2/orders immediately, so the fill-truth is the POSITION (same signal the
// passing Delta cert uses). Net size doubles as the exactly-once proof: two workers sending would make it 2.
async function positionOf(productId) {
  const pos = await delta("GET", "/v2/positions", { query: `product_id=${productId}` });
  let rows = pos.json && (Array.isArray(pos.json.result) ? pos.json.result : [pos.json.result]).filter(Boolean);
  let mine = (rows || []).find((r) => r && String(r.product_id) === String(productId));
  if (!mine || Number(mine.size || 0) === 0) {
    const marg = await delta("GET", "/v2/positions/margined");
    const list = (marg.json && (Array.isArray(marg.json.result) ? marg.json.result : [marg.json.result])) || [];
    const m2 = list.filter(Boolean).find((r) => r && String(r.product_id) === String(productId));
    if (m2 && Number(m2.size || 0) !== 0) mine = m2;
  }
  return { size: mine ? Number(mine.size || 0) : 0, avg: mine ? (Number(mine.entry_price ?? mine.avg_price) || null) : null };
}
async function netSize(productId) { return (await positionOf(productId)).size; }
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
        // R43-P1-03: broker ACCEPTANCE is NOT fill truth. Placement leaves the durable attempt SUBMITTED (unresolved) —
        // never FILLED. Only the production reconciler (reconcileUnresolvedAttempts, run by the parent below) may
        // transition it to FILLED, and only after reading the Delta POSITION. The worker never self-declares a fill.
        classify: () => ({ status: "SUBMITTED", patch: {} }),
        fenceGuard: () => db.fenceValid(lease, myFence),   // refuse to send if this worker's fence is no longer live
      });
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
  const orderRecovery = require("../orderRecovery");
  await db.initDb();
  const r = crypto.randomBytes(6).toString("hex");
  const tag = "tw_" + r, attemptId = "oa_" + r, userId = "tw_user_" + r, signalId = "sig_" + r, lease = "autobuy:" + userId;
  const productId = (await resolveProduct()).id;

  const mkWorker = (wid) => fork(__filename, [], {
    env: { ...process.env, WORKER_ROLE: "worker", WORKER_ID: wid, LEASE: lease, SIGNAL_ID: signalId, RA_USER: userId, RA_TAG: tag, RA_ATTEMPT_ID: attemptId, RA_PRODUCT_ID: String(productId) },
    stdio: "inherit", execArgv: [],
  });

  try {
    // 0) Start FLAT so net position size is a clean exactly-once signal.
    await flatten(productId);
    assert.equal(await netSize(productId), 0, "account starts flat for this product");

    // 1) Two workers concurrently, one shared PG + one signal.
    const [w1, w2] = [mkWorker("W1"), mkWorker("W2")];
    const codes = await Promise.all([w1, w2].map((c) => new Promise((res) => c.on("exit", res))));
    assert.ok(codes.every((x) => x === 0), `both workers exited cleanly — codes ${codes}`);
    // let the fill settle into the position (Delta drops a filled market order out of /v2/orders, so the POSITION is
    // the truth — and net size is the exactly-once proof: two sends would make it 2).
    let sz = 0;
    for (let i = 0; i < 20; i++) { sz = await netSize(productId); if (sz >= 1) break; await sleep(1000); }

    // 2) EXACTLY-ONCE across the two workers.
    assert.equal(sz, 1, `exactly ONE lot at the broker across two workers (no double-send) — net size ${sz}`);

    // Before reconciliation the durable attempt is SUBMITTED, NOT filled — broker acceptance is not fill truth.
    const preRecon = await db.getOrderAttempt(attemptId);
    assert.equal(preRecon && preRecon.status, "SUBMITTED", "attempt is SUBMITTED (unresolved) after placement — never self-declared FILLED");

    /* R43-P1-03: FILL TRUTH comes ONLY from the production reconciler reading the Delta POSITION. Run
       reconcileUnresolvedAttempts — the exact code path production uses on startup / periodically — with a
       position-truth probe. It adopts the ONE fill into the immutable ledger and transitions the attempt
       SUBMITTED→FILLED. The workers never wrote a fill or a terminal status themselves. */
    const rec = await orderRecovery.reconcileUnresolvedAttempts({
      db,
      probeByTag: async (a) => { const p = await positionOf(productId); return p.size >= 1 ? { status: "filled", filledQty: p.size, avgPrice: p.avg, orderId: a.orderTag } : { status: "pending" }; },
      adoptFill: async (a, ob) => { await db.recordFill(userId, { broker: "delta", orderId: a.orderTag, qty: ob.filledQty, side: "BUY", entry: ob.avgPrice, market: "Crypto", tradeType: "two-worker", ts: Date.now() }); },
      setLock: (u, v) => db.setRiskLock(u, v),
      setHalt: (u, v) => db.setEntryHalt(u, v),
    });
    assert.equal(rec.adopted, 1, `the production reconciler adopted exactly ONE broker-truth fill — saw ${rec.adopted}`);

    const fills = (await db.getFills(userId, 0, Date.now())).filter((f) => String(f.tradeType) === "two-worker");
    assert.equal(fills.length, 1, `exactly ONE authoritative fill — saw ${fills.length}`);
    assert.equal(await db.claimSignal(signalId, userId), false, "signal is already claimed (no re-claim possible)");
    const after = await db.getOrderAttempt(attemptId);
    assert.equal(after && after.status, "FILLED", "the single durable attempt is FILLED — set by the reconciler from broker truth, not placement");

    // 3) FAILOVER: both owners have exited without releasing the lease ("died"). After it expires a takeover worker
    //    acquires it (fence increments) but must NOT resend — the signal is already claimed.
    await sleep(LEASE_TTL_MS + 800);
    const w3 = mkWorker("W3");
    const tcode = await new Promise((res) => w3.on("exit", res));
    assert.equal(tcode, 0, "takeover worker exited cleanly");
    const lz = await db.getLease(lease);
    assert.ok(lz && lz.fence >= 2, `takeover incremented the fence (new owner) — fence ${lz && lz.fence}`);
    assert.equal(await netSize(productId), 1, "broker position is still exactly ONE lot after failover — no resend");
    assert.equal((await db.getFills(userId, 0, Date.now())).filter((f) => String(f.tradeType) === "two-worker").length, 1, "still exactly ONE fill after failover");
  } finally {
    const flat = await flatten(productId).catch(() => false);
    assert.ok(flat, "teardown proved the testnet account is flat");
  }
});
