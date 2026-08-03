/* C03 slice 2b — the write-before-send submit orchestrator (the seam wired into the live FYERS branch behind
   the C03_ORDER_ATTEMPTS flag). Proves the two hardest mandatory invariants at the orchestration level, with
   the REAL durable attempt store (flat-file) and fault injection — no live server required:
     - DB failure BEFORE submission ⇒ the broker submit() is NEVER called (zero orders)
     - submit() throws (lost response) ⇒ attempt left UNKNOWN (recoverable by tag; never a silent duplicate)
     - a returned fill ⇒ attempt finalized FILLED + resolved */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { submitWithAttempt } = require("../orderRecovery.js");
const faultHook = require("../faultHook.js");

let dir, db;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-c03s-"));
  delete process.env.DATABASE_URL;
  process.env.ORDER_ATTEMPTS_FILE = path.join(dir, "attempts.json");
  db = require("../db.js");
});
test.after(() => { faultHook.clear(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const attempt = (id) => ({ id, userId: "u1", broker: "fyers", orderTag: `mxS_${id}`, symbol: "SBIN", side: "BUY", qty: 5, product: "CNC" });
const classifyFilled = (res) => ({ status: "FILLED", patch: { brokerOrderId: res.id, filledQty: res.filledQty, avgPrice: res.avgPrice, resolved: true } });

test("C03S: DB failure BEFORE submission ⇒ broker submit() is NEVER called (zero orders)", async () => {
  let submitCalls = 0;
  const submit = async () => { submitCalls++; return { id: "FY1", filledQty: 5, avgPrice: 100 }; };
  faultHook.arm("db.attempt.prepare", 1);
  await assert.rejects(
    () => submitWithAttempt({ db, attempt: attempt("S1"), submit, classify: classifyFilled }),
    /injected fault: db.attempt.prepare/,
  );
  assert.equal(submitCalls, 0, "the broker was NOT called because PREPARED did not commit");
  assert.equal(await db.getOrderAttempt("S1"), null, "no attempt persisted");
});

test("C03S: submit() throws (lost response) ⇒ attempt left UNKNOWN (recoverable, not duplicated)", async () => {
  const submit = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
  await assert.rejects(() => submitWithAttempt({ db, attempt: attempt("S2"), submit, classify: classifyFilled }), /timeout/);
  const row = await db.getOrderAttempt("S2");
  assert.equal(row.status, "UNKNOWN");
  assert.equal(row.resolved, false, "unresolved ⇒ startup reconciliation will find it by orderTag");
});

test("C03S: a returned fill ⇒ attempt finalized FILLED + resolved with broker fill facts", async () => {
  const submit = async () => ({ id: "FY3", filledQty: 5, avgPrice: 101.5 });
  const res = await submitWithAttempt({ db, attempt: attempt("S3"), submit, classify: classifyFilled });
  assert.equal(res.id, "FY3");
  const row = await db.getOrderAttempt("S3");
  assert.equal(row.status, "FILLED");
  assert.equal(row.resolved, true);
  assert.equal(row.filledQty, 5);
  assert.equal(row.avgPrice, 101.5);
  assert.equal(row.brokerOrderId, "FY3");
});

test("C03S: the attempt passes through SUBMITTING before the send (crash-mid-send is recoverable)", async () => {
  // Capture the status the row is in AT THE MOMENT submit() runs.
  let statusAtSend = null;
  const submit = async () => { statusAtSend = (await db.getOrderAttempt("S4")).status; return { id: "FY4", filledQty: 5, avgPrice: 100 }; };
  await submitWithAttempt({ db, attempt: attempt("S4"), submit, classify: classifyFilled });
  assert.equal(statusAtSend, "SUBMITTING", "row is SUBMITTING during the broker call — a crash there is recoverable");
});
