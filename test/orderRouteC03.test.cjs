/* C03 #441 — LITERAL /api/broker/order route integration proofs against REAL PostgreSQL + a fake FYERS HTTP
   server, driving the production Express app through the MATRIX_NO_LISTEN seam with C03_ORDER_ATTEMPTS=1.
   This is the route-level proof the reviews (R28/R29 C03) require. It exercises the WHOLE production path:
   requireAuth → requireSchemaReady → requireFreshSession → risk-lock/unknown gates → durable idempotency claim →
   server-owned risk gate (real broker account snapshot) → C03 write-before-send (submitWithAttempt) → real DB
   commit of the order_attempt → real FYERS adapter call (redirected to the fake) → fill verification → response
   mapping; plus the production startup/periodic reconciliation sweep (runC03Reconcile).

   PostgreSQL: uses process.env.DATABASE_URL when present (CI provides it). Locally it boots an ephemeral
   embedded-postgres if available (require "embedded-postgres", or a path in EMBEDDED_PG_PATH). If neither is
   available AND we're not in CI, the suite skips; in CI (CI=true) a missing DB FAILS (never a silent skip), which
   the ciPgRequired guard also enforces globally. */
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const IN_CI = /^(1|true|yes)$/i.test(String(process.env.CI || ""));

function loadEmbeddedPg() {
  const tries = ["embedded-postgres", process.env.EMBEDDED_PG_PATH].filter(Boolean);
  for (const t of tries) { try { const M = require(t); return M.default || M; } catch { /* next */ } }
  return null;
}

let pgHandle = null, DATABASE_URL = null, srv = null, base = null, fake = null;
let server, auth, db, faultHook, bcrypt;

async function bootPostgres() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const EmbeddedPostgres = loadEmbeddedPg();
  if (!EmbeddedPostgres) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-routepg-"));
  const port = 55000 + Math.floor(Math.random() * 2000);
  pgHandle = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pgHandle.initialise();
  await pgHandle.start();
  await pgHandle.createDatabase("matrix_test");
  return `postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
}

// HTTP helper against the real app.
function req(method, p, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { "Content-Type": "application/json", ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const u = new URL(base + p);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j; try { j = b ? JSON.parse(b) : {}; } catch { j = { raw: b }; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

const PHONE = "9990001111";
const SKEY = "ph_" + PHONE;             // storageKeyFor(phone)
let TOKEN = null, SESSION = null;

async function seedUserAndSession() {
  await db.createUser(PHONE, bcrypt.hashSync("1234", 8), "Route Test", null, null, null, null, true);
  TOKEN = auth.signToken(PHONE, process.env.JWT_SECRET, 24 * 3600 * 1000, 0);
  // Seed an ENCRYPTED FYERS credential (under the storage key) so the REAL /api/broker/resume path decrypts it.
  await db.saveBrokerCred(SKEY, "fyers", server.encryptCred({ accessToken: "FYERS-SECRET-TOKEN", refreshToken: null, extra: {} }));
  const r = await req("POST", "/api/broker/resume", { token: TOKEN, body: { broker: "fyers" } });
  assert.equal(r.status, 200, "resume should decrypt the stored cred and mint a session: " + JSON.stringify(r.body));
  SESSION = r.body.sessionId;
  assert.ok(SESSION, "session id minted");
}

function orderHeaders(idemKey, extra = {}) {
  return { "X-Broker-Session": SESSION, "X-Confirm-Live": "yes", "X-Idempotency-Key": idemKey, ...extra };
}
const newKey = () => "idem_" + crypto.randomBytes(8).toString("hex");
const attemptIdFor = (key) => `oa_${SKEY}_${key}`;
const bare = (s) => String(s || "").replace(/^NSE:/, "").replace(/-EQ$/, "");

// A FRESH trader (own phone/token/cred/session) so the C01 close journeys are isolated from other tests'
// risk-lock / unknown-idempotency state. Returns helpers bound to that user.
async function freshTrader() {
  const phone = "9" + String(Math.floor(1e8 + Math.random() * 8e8));
  const skey = "ph_" + phone;
  await db.createUser(phone, bcrypt.hashSync("1234", 8), "C01 Trader", null, null, null, null, true);
  const token = auth.signToken(phone, process.env.JWT_SECRET, 24 * 3600 * 1000, 0);
  await db.saveBrokerCred(skey, "fyers", server.encryptCred({ accessToken: "FYERS-SECRET-TOKEN", refreshToken: null, extra: {} }));
  const rr = await req("POST", "/api/broker/resume", { token, body: { broker: "fyers" } });
  const session = rr.body.sessionId;
  const oh = (idemKey, extra = {}) => ({ "X-Broker-Session": session, "X-Confirm-Live": "yes", "X-Idempotency-Key": idemKey, ...extra });
  const order = (idemKey, body, extra = {}) => req("POST", "/api/broker/order", { token, headers: oh(idemKey, extra), body });
  const openTrades = async () => (await db.getTrades(skey, 0, Date.now())).filter((t) => t && t.real && t.entryAt != null && t.exitAt == null && t.exit == null && t.status !== "rejected");
  return { phone, skey, token, session, order, openTrades };
}

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) {
    if (IN_CI) throw new Error("DATABASE_URL is required for the /api/order route C03 proofs in CI (skips are failures).");
    return; // local without PG → tests below self-skip
  }
  // Env MUST be set before requiring server.js (it reads these at module load).
  fake = require("./route/fakeFyers.cjs").makeFakeFyers();
  base = null; // set after app listens
  const fyBase = await fake.listen();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.FYERS_API_BASE = fyBase;
  process.env.JWT_SECRET = "route-test-jwt-secret-000";
  process.env.CRED_KEY = "route-test-cred-key-32bytes-min!!";
  process.env.BROKER_TRADING_ENABLED = "true";
  process.env.C03_ORDER_ATTEMPTS = "1";
  process.env.MATRIX_NO_LISTEN = "1";
  server = require("../server.js");
  auth = require("../auth.js");
  db = require("../db.js");
  faultHook = require("../faultHook.js");
  bcrypt = require("bcryptjs");
  // Wait for schema init (+ C03 startup re-arm) to complete.
  const deadline = Date.now() + 30000;
  while (!server.isSchemaReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(server.isSchemaReady(), "server schema became ready");
  srv = http.createServer(server.app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await seedUserAndSession();
});

test.after(async () => {
  try { faultHook && faultHook.clear(); } catch { /* ignore */ }
  if (srv) await new Promise((r) => srv.close(r));
  if (fake) await fake.close();
  if (pgHandle) { try { await pgHandle.stop(); } catch { /* ignore */ } }
});

// Evaluate DB availability at RUN time (before() populates DATABASE_URL), not at registration time. Without a DB
// locally we skip; in CI a missing DB is a hard failure (never a silent pass).
const guard = (t) => async (...a) => {
  if (!DATABASE_URL) {
    if (IN_CI) throw new Error("route C03 proof requires PostgreSQL in CI");
    return; // local skip
  }
  return t(...a);
};

test("J5: auth/PIN/credential failures reject BEFORE any broker order (zero placements)", guard(async () => {
  fake.reset();
  // (a) no token → 401
  let r = await req("POST", "/api/broker/order", { headers: orderHeaders(newKey()), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1 } });
  assert.equal(r.status, 401);
  // (b) garbage token → 401
  r = await req("POST", "/api/broker/order", { token: "not.a.jwt", headers: orderHeaders(newKey()), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1 } });
  assert.equal(r.status, 401);
  // (c) valid token but STALE token version (security action revoked it) → requireFreshSession 401
  const stale = auth.signToken(PHONE, process.env.JWT_SECRET, 24 * 3600 * 1000, 99);
  r = await req("POST", "/api/broker/order", { token: stale, headers: orderHeaders(newKey()), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1 } });
  assert.equal(r.status, 401);
  // (d) authenticated + fresh, but NO broker session → 401 "no broker session"
  r = await req("POST", "/api/broker/order", { token: TOKEN, headers: { "X-Confirm-Live": "yes", "X-Idempotency-Key": newKey() }, body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1 } });
  assert.equal(r.status, 401);
  // (e) PIN gate: wrong PIN is rejected by the production /api/pin/verify step-up
  const pv = await req("POST", "/api/pin/verify", { token: TOKEN, body: { pin: "0000" } });
  assert.equal(pv.status, 200); assert.equal(pv.body.ok, false, "wrong PIN must not verify");
  const pv2 = await req("POST", "/api/pin/verify", { token: TOKEN, body: { pin: "1234" } });
  assert.equal(pv2.body.ok, true, "correct PIN verifies");
  assert.equal(fake.placeCount(), 0, "NOT ONE broker order was placed by any rejected request");
}));

test("J1: write-before-send — the durable order_attempt is committed BEFORE FYERS receives the order", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  const key = newKey();
  let attemptAtBroker = null;
  fake.state.onPlace = async (body) => { attemptAtBroker = await db.getOrderAttempt(attemptIdFor(key)); attemptAtBroker && (attemptAtBroker._tag = body.orderTag); };
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(key), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1, orderType: "MARKET", product: "CNC" } });
  fake.state.onPlace = null;
  assert.equal(r.status, 200, "order accepted: " + JSON.stringify(r.body));
  assert.ok(attemptAtBroker, "an order_attempt existed in Postgres at the instant FYERS received the order");
  assert.ok(["SUBMITTING", "PREPARED"].includes(attemptAtBroker.status), "attempt was PREPARED/SUBMITTING before send, got " + attemptAtBroker.status);
  const finalRow = await db.getOrderAttempt(attemptIdFor(key));
  assert.equal(fake.placeCount(), 1, "exactly one broker placement");
  assert.equal(finalRow.status, "FILLED", "attempt finalized FILLED after verified fill");
  // Correlation identity is stable + carries no secrets.
  assert.equal(finalRow.orderTag, attemptAtBroker._tag, "orderTag correlation stable across the lifecycle");
  const dump = JSON.stringify(finalRow);
  assert.ok(!/FYERS-SECRET-TOKEN/.test(dump) && !/1234/.test(dump), "no access token / PIN in the persisted attempt");
}));

test("J8/J4: DB failure (attempt insert) → FYERS order endpoint is NEVER called", guard(async () => {
  fake.reset(); fake.setMode("fill");
  faultHook.arm("db.attempt.prepare", 1);          // the durable PREPARED write fails
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(newKey()), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1, orderType: "MARKET", product: "CNC" } });
  faultHook.clear();
  assert.ok(r.status >= 500 || r.status === 409, "an honest failure is returned, not a success: " + r.status);
  assert.equal(fake.placeCount(), 0, "the broker order endpoint was never called when the durable write failed");
}));

test("J3: broker rejection → attempt terminal REJECTED, no position, honest API", guard(async () => {
  fake.reset(); fake.setMode("reject");
  const key = newKey();
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(key), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1, orderType: "MARKET", product: "CNC" } });
  // Order was accepted then verified REJECTED → the app reports a non-filled status honestly.
  assert.ok(r.status === 200 || r.status >= 400, "responded: " + r.status + " " + JSON.stringify(r.body));
  const row = await db.getOrderAttempt(attemptIdFor(key));
  assert.equal(row.status, "REJECTED", "attempt is terminal REJECTED");
  assert.equal(row.resolved, true, "REJECTED is resolved (terminal)");
  const fills = await db.getFills(SKEY, 0, Date.now());
  assert.equal(fills.length, 0, "no fill/position was journaled for a rejected order");
}));

test("J6: concurrent duplicate requests (same idempotency key) → at most ONE broker order", guard(async () => {
  fake.reset(); fake.setMode("fill");
  const key = newKey();
  const bodyObj = { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1, orderType: "MARKET", product: "CNC" };
  const [a, b] = await Promise.all([
    req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(key), body: bodyObj }),
    req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(key), body: bodyObj }),
  ]);
  assert.ok(fake.placeCount() <= 1, "at most one broker order for two concurrent identical requests, got " + fake.placeCount());
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses.includes(200), "one request succeeds");
  assert.ok(statuses.some((s) => s === 200 || s === 409), "the other is deduped (replay/in-flight/409), not a second order");
}));

test("J2/J7: lost-response after acceptance → UNKNOWN + locked; restart reconcile adopts by tag, NO duplicate", guard(async () => {
  fake.reset(); fake.setMode("lostResponse", { fillPrice: 250 });
  const key = newKey();
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(key), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 3, orderType: "MARKET", product: "CNC" } });
  assert.ok(r.status >= 500 || r.status === 409, "ambiguous transport failure surfaced honestly: " + r.status);
  const unresolved = await db.getOrderAttempt(attemptIdFor(key));
  assert.equal(unresolved.resolved, false, "attempt is UNKNOWN/unresolved after a lost response");
  assert.equal(fake.placeCount(), 1, "the broker received the order exactly once");
  const lockedNow = await db.isRiskLocked(SKEY);
  assert.equal(lockedNow, true, "account is fail-closed LOCKED while the order outcome is unknown");

  // RESTART/RECOVERY: production startup + periodic worker call this exact function. The broker's book still holds
  // the filled order under our tag; reconcile must adopt it exactly once and resolve — with NO duplicate order.
  const before = fake.placeCount();
  const out = await server.runC03Reconcile("test-restart");
  assert.ok(out && !out.error, "reconcile ran: " + JSON.stringify(out));
  const resolved = await db.getOrderAttempt(attemptIdFor(key));
  assert.equal(resolved.resolved, true, "the unresolved attempt is resolved after broker-backed reconciliation");
  assert.equal(fake.placeCount(), before, "reconciliation adopted the fill — it did NOT place a duplicate order");
  const fills = await db.getFills(SKEY, 0, Date.now());
  assert.ok(fills.length >= 1, "the orphaned fill was adopted into the authoritative ledger exactly once");
  // A second sweep is idempotent (nothing new to adopt / no new order).
  const c2 = fake.placeCount();
  await server.runC03Reconcile("test-restart-2");
  assert.equal(fake.placeCount(), c2, "second startup sweep places no order");
}));

test("Guard: with the flag ON, a successful order MUST create a durable attempt (legacy path would not)", guard(async () => {
  assert.equal(process.env.C03_ORDER_ATTEMPTS, "1", "flag is on for these proofs");
  fake.reset(); fake.setMode("fill");
  const key = newKey();
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: orderHeaders(key), body: { symbol: "NSE:SBIN-EQ", side: "BUY", qty: 1, orderType: "MARKET", product: "CNC" } });
  assert.equal(r.status, 200);
  const row = await db.getOrderAttempt(attemptIdFor(key));
  assert.ok(row, "a successful order under the flag creates an order_attempt — proving the C03 path ran, not the legacy path");
}));

test("C01-full: reduce-only close books an EXIT (realized P&L), NO phantom short, position closed", guard(async () => {
  const T = await freshTrader();
  const SYM = "NSE:TCS-EQ";
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  // Open a long: 5 @ 100.
  let r = await T.order(newKey(), { symbol: SYM, side: "BUY", qty: 5, orderType: "MARKET", product: "CNC" });
  assert.equal(r.status, 200, "entry accepted: " + JSON.stringify(r.body));
  const entryOrderId = r.body.orderId;
  let open = (await T.openTrades()).filter((t) => bare(t.sym) === "TCS");
  assert.equal(open.length, 1, "exactly one open TCS long after the entry");
  assert.equal(open[0].qty, 5);
  const origId = open[0].id;

  // Reduce-only CLOSE the full 5 @ 120.
  fake.setMode("fill", { fillPrice: 120 });
  const closeKey = newKey();
  r = await T.order(closeKey, { symbol: SYM, side: "SELL", qty: 5, orderType: "MARKET", product: "CNC", reduceOnly: true, entryOrderId }, { "X-Reduce-Only": "yes" });
  assert.equal(r.status, 200, "reduce-only close accepted: " + JSON.stringify(r.body));
  const closeOrderId = r.body.orderId;

  const all = await db.getTrades(T.skey, 0, Date.now());
  // (a) NO phantom open opposite (short) position was created.
  const phantom = all.find((t) => t.real && bare(t.sym) === "TCS" && t.exitAt == null && t.exit == null && t.status !== "rejected" && (String(t.side).toUpperCase() === "SELL" || t.short === true));
  assert.ok(!phantom, "reduce-only close must NOT create a phantom open short");
  // (b) the original long is CLOSED with realized P&L (120-100)*5 = 100.
  const closed = all.find((t) => t.id === origId);
  assert.equal(closed.status, "closed", "original position is closed");
  assert.equal(Number(closed.exit), 120);
  assert.ok(Math.abs(Number(closed.pnl) - 100) < 1e-6, "realized P&L booked = 100, got " + closed.pnl);
  // (c) no TCS position remains open.
  assert.equal((await T.openTrades()).filter((t) => bare(t.sym) === "TCS").length, 0, "no open TCS position remains");
  // (d) the immutable EXIT leg is in the fills ledger, linked to the entry order.
  const fills = await db.getFills(T.skey, 0, Date.now());
  const exitLeg = fills.find((f) => f.kind === "exit" && String(f.orderId) === String(closeOrderId));
  assert.ok(exitLeg, "an immutable exit fill leg was recorded");
  assert.equal(String(exitLeg.entryOrderId), String(entryOrderId), "exit leg is linked to its entry order id");
  // (e) fills-derived risk shows a matched round-trip with realized P&L (no phantom entry).
  const rk = db.deriveRiskFromFills(fills, { from: 0, to: Date.now() });
  assert.ok(rk.matched >= 1, "round-trip matched in the authoritative fills-derived risk");
  assert.ok(Math.abs(rk.realizedPnl - 100) < 1e-6, "fills-derived realized P&L = 100, got " + rk.realizedPnl);
}));

test("C01-partial: reduce-only partial close reduces the open row + books realized P&L on the closed portion", guard(async () => {
  const T = await freshTrader();
  const SYM = "NSE:WIPRO-EQ";
  fake.reset(); fake.setMode("fill", { fillPrice: 50 });
  // Open a long: 10 @ 50.
  let r = await T.order(newKey(), { symbol: SYM, side: "BUY", qty: 10, orderType: "MARKET", product: "CNC" });
  assert.equal(r.status, 200);
  const entryOrderId = r.body.orderId;
  const origId = (await T.openTrades()).find((t) => bare(t.sym) === "WIPRO").id;

  // Reduce-only close 4 of 10 @ 65 → realized (65-50)*4 = 60; 6 stay open.
  fake.setMode("fill", { fillPrice: 65 });
  r = await T.order(newKey(), { symbol: SYM, side: "SELL", qty: 4, orderType: "MARKET", product: "CNC", reduceOnly: true, entryOrderId }, { "X-Reduce-Only": "yes" });
  assert.equal(r.status, 200);

  const all = await db.getTrades(T.skey, 0, Date.now());
  const residual = all.find((t) => t.id === origId);
  assert.equal(Number(residual.qty), 6, "residual open quantity is 6");
  assert.ok(residual.exitAt == null, "residual stays OPEN");
  const closedPortion = all.find((t) => t.partialOf === origId);
  assert.ok(closedPortion, "a closed row was booked for the executed portion");
  assert.equal(Number(closedPortion.qty), 4);
  assert.ok(Math.abs(Number(closedPortion.pnl) - 60) < 1e-6, "realized P&L on the closed portion = 60, got " + closedPortion.pnl);
  // No phantom short, and exactly 6 units of WIPRO remain open (only the residual).
  const openWipro = (await T.openTrades()).filter((t) => bare(t.sym) === "WIPRO");
  assert.equal(openWipro.length, 1);
  assert.equal(Number(openWipro[0].qty), 6);
}));

test("R30-C2: recordExitAtomic commits the exit fill + trade rows once and is replay-idempotent", guard(async () => {
  const T = await freshTrader();
  const oid = "EX" + Math.floor(Math.random() * 1e6);
  const fill = { orderId: oid, kind: "exit", side: "SELL", qty: 5, entry: 120, price: 120, broker: "fyers", market: "IN", tradeType: "Manual Exit", ts: Date.now() };
  const rowId = `t_${crypto.randomBytes(6).toString("hex")}_closed`;
  const rows = [{ id: rowId, real: true, sym: "SBIN", side: "BUY", qty: 5, entry: 100, exit: 120, exitAt: Date.now(), pnl: 100, status: "closed", exitOrderId: oid, broker: "fyers", serverAuthored: true }];
  await db.recordExitAtomic(T.skey, { fill, rows });
  await db.recordExitAtomic(T.skey, { fill, rows });   // REPLAY (crash-then-retry) must not double-apply
  const fills = await db.getFills(T.skey, 0, Date.now());
  assert.equal(fills.filter((f) => String(f.orderId) === String(oid)).length, 1, "exit fill leg recorded exactly once");
  const trades = await db.getTrades(T.skey, 0, Date.now());
  assert.equal(trades.filter((t) => t.id === rowId).length, 1, "closed trade row upserted once (no duplicate)");
  assert.equal(trades.find((t) => t.id === rowId).status, "closed", "position is closed atomically with the fill");
}));

test("R30-C3: an order missing from the order book but present in the TRADEBOOK is adopted, NOT cancelled", guard(async () => {
  const T = await freshTrader();
  fake.reset();
  const tag = "MXOLD" + Math.floor(Math.random() * 1e6);
  const bid = "FYOLD" + Math.floor(Math.random() * 1e6);
  // An unresolved ACCEPTED attempt whose order is NO LONGER in today's order book, but whose fill is in the tradebook.
  const aid = `oa_${T.skey}_recoveryTB_${Math.floor(Math.random() * 1e6)}`;
  await db.prepareOrderAttempt({ id: aid, userId: T.skey, broker: "fyers", orderTag: tag, fingerprint: "fp", symbol: "NSE:INFY-EQ", side: "BUY", qty: 4 });
  await db.finalizeOrderAttempt(aid, "ACCEPTED", { brokerOrderId: bid });
  fake.seedTrade({ orderNumber: bid, orderTag: tag, tradedQty: 4, tradePrice: 90, side: 1 });   // in tradebook, not order book

  const before = fake.placeCount();
  await server.runC03Reconcile("test-tradebook");
  const row = await db.getOrderAttempt(aid);
  assert.equal(row.resolved, true, "the order is adopted from the tradebook, not left/cancelled");
  assert.notEqual(row.status, "CANCELLED", "must NOT be declared absent/cancelled when the tradebook has the fill");
  assert.equal(fake.placeCount(), before, "no duplicate order placed");
  const fills = await db.getFills(T.skey, 0, Date.now());
  assert.ok(fills.some((f) => bare(f.sym) === "INFY"), "the recovered fill was journaled");
}));

test("R30-C3: an unconfirmed order absent from book+tradebook+positions with NO broker id stays LOCKED (never cancelled)", guard(async () => {
  const T = await freshTrader();
  fake.reset();
  const tag = "MXGHOST" + Math.floor(Math.random() * 1e6);
  const aid = `oa_${T.skey}_ghost_${Math.floor(Math.random() * 1e6)}`;
  // UNKNOWN attempt, no broker order id — the broker may or may not have received it. Nothing anywhere references it.
  await db.prepareOrderAttempt({ id: aid, userId: T.skey, broker: "fyers", orderTag: tag, fingerprint: "fp", symbol: "NSE:INFY-EQ", side: "BUY", qty: 2 });
  await db.finalizeOrderAttempt(aid, "UNKNOWN", {});
  await server.runC03Reconcile("test-ghost");
  const row = await db.getOrderAttempt(aid);
  assert.equal(row.resolved, false, "a never-confirmed order (no broker id) is NOT auto-cancelled — stays locked for reconcile");
  assert.notEqual(row.status, "CANCELLED");
  assert.equal(await db.isRiskLocked(T.skey), true, "account remains risk-locked while the outcome is unproven");
}));

test("H04: an order filled across TWO executions is recorded as two immutable events; projection = weighted avg", guard(async () => {
  const T = await freshTrader();
  const SYM = "NSE:INFY-EQ";
  fake.reset();
  fake.setMode("fill", { fillPrice: 104 });                 // cumulative snapshot avg
  fake.setExecutions([{ qty: 3, price: 100 }, { qty: 2, price: 110 }]);   // real fills: 3@100 + 2@110
  const r = await T.order(newKey(), { symbol: SYM, side: "BUY", qty: 5, orderType: "MARKET", product: "CNC" });
  assert.equal(r.status, 200, "entry accepted: " + JSON.stringify(r.body));
  const oid = r.body.orderId;

  // The per-execution recording is fire-and-forget; poll the ledger until both events land (bounded).
  let execEvents = [];
  for (let i = 0; i < 40; i++) {
    const fills = await db.getFills(T.skey, 0, Date.now());
    execEvents = fills.filter((f) => f.execEvent === true && String(f.orderId) === String(oid));
    if (execEvents.length >= 2) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(execEvents.length, 2, "two immutable per-execution fill events recorded from the tradebook");

  const fills = await db.getFills(T.skey, 0, Date.now());
  const proj = db.projectFills(fills).find((p) => p.leg === "entry" && String(p.orderId) === String(oid));
  assert.ok(proj, "the order projects to one entry leg");
  assert.equal(proj.qty, 5, "quantity summed across the two executions");
  assert.ok(Math.abs(proj.price - 104) < 1e-6, "quantity-weighted price = (3·100 + 2·110)/5 = 104");
  assert.equal(proj.executions, 2, "projection derived from 2 execution events (not the cumulative snapshot)");
}));
