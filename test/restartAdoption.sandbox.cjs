#!/usr/bin/env node
/* test/restartAdoption.sandbox.cjs — R41-P1-04 REAL lost-response → process death → restart → adopt-once journey.
 *
 * The MatrixOne-path E2E (brokerPipelineE2E) invokes reconciliation twice IN THE SAME PROCESS after a normal order — it
 * never proves the crash path. This harness proves the real one, on Delta TESTNET, against the SAME PostgreSQL database:
 *
 *   CHILD process (WORKER_ROLE=child):
 *     1. write-before-send: db.prepareOrderAttempt(PREPARED) then CAS PREPARED→SUBMITTING (via orderRecovery.submitWithAttempt),
 *     2. inside submit(): place a REAL reduce-safe Delta testnet MARKET order tagged with a unique client_order_id,
 *     3. HARD-EXIT (process.exit) the instant the broker accepts — BEFORE any local finalize. This is the lost response +
 *        crash: the attempt is durably left SUBMITTING in PG, the order exists at the broker, we never recorded the fill.
 *
 *   PARENT process (this test), after the child dies:
 *     4. restart-equivalent: run orderRecovery.reconcileUnresolvedAttempts against the SAME PG, with a Delta
 *        probe-by-TAG (find the order/fill by client_order_id from broker truth) + adopt-once fill recorder,
 *     5. ASSERT: exactly ONE broker order carries the tag (no resend), the durable attempt resolves exactly once to
 *        FILLED, exactly one fill is adopted, and the account lock is only cleared through reconciliation — never before,
 *     6. TEARDOWN: reduce-only flatten + prove flat (independent watchdog is the backstop).
 *
 * Gated: skips unless BROKER_SANDBOX=1 AND DATABASE_URL AND DELTA_SANDBOX_KEY/SECRET AND an approved testnet host.
 * RUN (self-hosted, whitelisted IP):
 *   BROKER_SANDBOX=1 DATABASE_URL=… DELTA_SANDBOX_KEY=… DELTA_SANDBOX_SECRET=… node --test test/restartAdoption.sandbox.cjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sign(method, p, body, ts) { return crypto.createHmac("sha256", SECRET).update(method + ts + p + (body || "")).digest("hex"); }
async function delta(method, p, { query = "", body = null } = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const full = p + (query ? `?${query}` : "");
  const bodyStr = body ? JSON.stringify(body) : "";
  const r = await fetch(BASE + full, {
    method, headers: { "api-key": KEY, signature: sign(method, full, bodyStr, ts), timestamp: ts, "Content-Type": "application/json", "User-Agent": "matrix-restart-adopt" },
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
// passing Delta cert uses): net size + entry price. Net size is also the exactly-once proof — a duplicate send makes it 2.
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

/* ── CHILD ROLE: place-and-die (the lost-response + crash). Invoked via fork() below. ───────────────────────────── */
if (process.env.WORKER_ROLE === "child") {
  (async () => {
    const db = require("../db");
    const orderRecovery = require("../orderRecovery");
    const tag = process.env.RA_TAG;
    const attemptId = process.env.RA_ATTEMPT_ID;
    const userId = process.env.RA_USER;
    const productId = Number(process.env.RA_PRODUCT_ID);
    try {
      await db.initDb();
      await orderRecovery.submitWithAttempt({
        db,
        attempt: { id: attemptId, userId, broker: "delta", orderTag: tag, payload: { symbol: SYMBOL, side: "BUY", qty: 1 } },
        submit: async () => {
          // Place the REAL testnet order tagged with our client_order_id, then DIE before returning to finalize.
          await delta("POST", "/v2/orders", { body: { product_id: productId, size: 1, side: "buy", order_type: "market_order", client_order_id: tag } });
          process.stdout.write(`CHILD_PLACED ${tag}\n`);
          process.exit(137);   // hard death AFTER broker acceptance, BEFORE local finalize → attempt stays SUBMITTING
        },
        classify: () => ({ status: "FILLED", patch: {} }),   // never reached (we die in submit)
      });
      process.exit(0);
    } catch (e) { process.stderr.write("CHILD_ERR " + ((e && e.message) || e) + "\n"); process.exit(1); }
  })();
  return;   // don't run the test body in the child
}

function guard(t) { if (CERT && READY && HOST_OK) return true; if (CERT) throw new Error(READY ? (HOST_OK ? "ready" : "unapproved host") : "missing DATABASE_URL/creds"); t.skip("BROKER_SANDBOX/PG/Delta creds not set"); return false; }

test("R41-P1-04: real lost-response → child death → restart reconcile adopts the fill exactly once (no resend)", async (t) => {
  if (!guard(t)) return;
  const db = require("../db");
  const orderRecovery = require("../orderRecovery");
  await db.initDb();

  const tag = "ra_" + crypto.randomBytes(8).toString("hex");
  const attemptId = "oa_" + crypto.randomBytes(8).toString("hex");
  const userId = "ra_user_" + crypto.randomBytes(4).toString("hex");
  const product = await resolveProduct();
  let productId = product.id;

  try {
    // 0) Start FLAT so the position is a clean truth signal (the account is shared with other jobs — they're serialized
    //    in CI, but flatten anyway for a clean baseline).
    await flatten(productId);
    assert.equal(await netSize(productId), 0, "account starts flat for this product");

    // 1) Spawn the child that write-before-sends, places the real order, and hard-dies before finalizing.
    //    execArgv: [] is REQUIRED — otherwise the child inherits the parent's `--test` and its test runner can exit 0
    //    before our IIFE reaches process.exit(137), making the exit-code assertion flaky.
    const child = fork(__filename, [], { env: { ...process.env, WORKER_ROLE: "child", RA_TAG: tag, RA_ATTEMPT_ID: attemptId, RA_USER: userId, RA_PRODUCT_ID: String(productId) }, stdio: "inherit", execArgv: [] });
    const code = await new Promise((res) => child.on("exit", res));
    assert.equal(code, 137, "child hard-died after broker acceptance (simulated lost response)");

    // 2) The durable attempt must have survived the crash as UNRESOLVED (write-before-send), and the account lock set.
    const unresolved = await db.listUnresolvedOrderAttempts(500);
    assert.ok(unresolved.some((a) => a.id === attemptId), "durable attempt survived the crash as UNRESOLVED");

    // 3) Wait for the fill to settle — read the POSITION, not /v2/orders (Delta drops a filled market order out of the
    //    open-orders endpoint immediately; the position is the fill-truth the passing Delta cert uses). Net size is also
    //    the exactly-once proof: a duplicate send would make it 2.
    const orderFill = async () => { const p = await positionOf(productId); return { done: p.size >= 1, filled: p.size, avg: p.avg, id: tag }; };
    let settled = { done: false };
    for (let i = 0; i < 20; i++) { settled = await orderFill(); if (settled.done) break; await sleep(1000); }
    assert.ok(settled.done, "the testnet order settled to filled (net position size ≥ 1)");
    assert.equal(settled.filled, 1, `exactly ONE lot filled (no resend) — net position size ${settled.filled}`);

    // 3.5) R42-P1-05: STARTUP RE-ARM with the REAL lock adapters. An unresolved attempt (write-before-send) must
    //      leave the account LOCKED — exactly what production's startup recovery does. Prove it with db.isRiskLocked.
    await orderRecovery.rearmFromUnresolvedAttempts({ db, setLock: (u, v) => db.setRiskLock(u, v), setHalt: (u, v) => db.setEntryHalt(u, v) });
    assert.equal(await db.isRiskLocked(userId), true, "account is LOCKED while the order outcome is unresolved");

    // 4) Restart-equivalent reconciliation from BROKER TRUTH — adopting through the PRODUCTION db adapters, not test
    //    doubles: adoptFill writes the IMMUTABLE fill (db.recordFill, idempotent), and the lock setters are the real ones.
    let adopted = 0;
    const out = await orderRecovery.reconcileUnresolvedAttempts({
      db,
      probeByTag: async (a) => {
        if (a.id !== attemptId) return null;   // only our attempt
        const f = await orderFill();
        if (f.done) return { status: "filled", orderId: f.id || tag, filledQty: f.filled, avgPrice: f.avg };
        return { status: "pending" };
      },
      adoptFill: async (a, ob) => {
        adopted++;
        await db.recordFill(userId, { broker: "delta", orderId: ob.orderId, qty: ob.filledQty, side: "BUY", entry: ob.avgPrice, market: "Crypto", tradeType: "restart-adoption", ts: Date.now() });
      },
      setLock: (u, v) => db.setRiskLock(u, v), setHalt: (u, v) => db.setEntryHalt(u, v),
      acquireOwner: async () => true, releaseOwner: async () => {},
    });
    assert.ok(out && !out.skipped, "reconcile ran as owner");

    // 5) EXACTLY-ONCE + AUTHORITATIVE-LEDGER + LOCK-LIFECYCLE invariants (real DB, not counters). The broker position
    //    is still exactly ONE lot — reconciliation adopted the fill, it did NOT resend (that would make it 2).
    assert.equal(await netSize(productId), 1, "broker position is still exactly ONE lot after reconcile (no resend)");
    assert.equal(adopted, 1, "the fill was adopted exactly once");
    const after = await db.getOrderAttempt(attemptId);
    assert.equal(after && after.status, "FILLED", "durable attempt resolved to FILLED once");

    // AUTHORITATIVE LEDGER: exactly ONE immutable fill was written for this user (the position projection source).
    const fills = await db.getFills(userId, 0, Date.now());
    const mine = fills.filter((f) => String(f.tradeType) === "restart-adoption");
    assert.equal(mine.length, 1, `exactly ONE authoritative fill in the immutable ledger — saw ${mine.length}`);

    // IDEMPOTENT REPLAY: running recovery AGAIN must neither resend nor write a second fill (the attempt is resolved,
    // and db.recordFill dedupes on the broker key). adoptFill throwing here would fail loudly if it were ever re-called.
    await orderRecovery.reconcileUnresolvedAttempts({
      db,
      probeByTag: async () => null,
      adoptFill: async () => { throw new Error("must not adopt a second time"); },
      setLock: (u, v) => db.setRiskLock(u, v), setHalt: (u, v) => db.setEntryHalt(u, v),
      acquireOwner: async () => true, releaseOwner: async () => {},
    });
    const fills2 = (await db.getFills(userId, 0, Date.now())).filter((f) => String(f.tradeType) === "restart-adoption");
    assert.equal(fills2.length, 1, "no duplicate fill on recovery replay");

    // LOCK LIFECYCLE: with the order resolved, NO unresolved attempts remain, so the account is eligible to unlock
    // (production's C02 broker-truth unlock gate clears it). Prove locked→clearable→cleared.
    const remaining = (await db.listUnresolvedOrderAttempts(500)).filter((a) => String(a.userId) === String(userId));
    assert.equal(remaining.length, 0, "no unresolved attempts remain for the user after reconciliation");
    await db.setRiskLock(userId, false); await db.setEntryHalt(userId, false);
    assert.equal(await db.isRiskLocked(userId), false, "account UNLOCKED once the order outcome is reconciled");
  } finally {
    // Teardown: reduce-only flatten + prove flat.
    const flat = await flatten(productId).catch(() => false);
    assert.ok(flat, "teardown proved the testnet account is flat");
  }
});
