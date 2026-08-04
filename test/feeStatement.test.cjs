/* R37-P3-02 / R37-P2-02 — direct fixture tests for the PURE FYERS contract-note statement adapter (feeStatement.js).
 * These prove the most important fee-provenance rules without a live broker: envelope rejection (bare array, missing/
 * mismatched account, wrong currency, missing schema, unsettled), STRICT trading-date validation (missing, bad format,
 * future, out-of-window), malformed/mixed line handling, and strict charge typing.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const feeStatement = require("../feeStatement");
const { strictCharge, parseIsoDate, normStatementLine, validateStatement, istDayWindow } = feeStatement;

// A canonical, well-formed settled statement for trading day 2026-08-04 on account "FY-123".
function goodEnvelope(over = {}) {
  return {
    schemaVersion: "1.0",
    account: "FY-123",
    tradingDate: "2026-08-04",
    settled: true,
    currency: "INR",
    lines: [
      { execId: "E1", orderId: "O1", charges: 12.5 },
      { execId: "E2", orderId: "O1", charges: "3.20" },
      { orderId: "O2", charges: 5 }, // order-level line (no execId)
    ],
    ...over,
  };
}
const ACCT = "FY-123";
const ALLOWED = ["2026-08-02", "2026-08-03", "2026-08-04"];
const NOW = Date.parse("2026-08-04T18:00:00Z");

// ---- strictCharge -------------------------------------------------------------------------------
test("strictCharge: accepts finite non-negative number and strict decimal string; rejects the rest", () => {
  assert.equal(strictCharge(0), 0);
  assert.equal(strictCharge(12.5), 12.5);
  assert.equal(strictCharge("  3.20 "), 3.2);
  for (const bad of [true, false, [], {}, "", "  ", "abc", "1e3", "-1", -1, NaN, Infinity, null, undefined]) {
    assert.equal(strictCharge(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---- parseIsoDate -------------------------------------------------------------------------------
test("parseIsoDate: only strict YYYY-MM-DD real calendar days", () => {
  assert.equal(parseIsoDate("2026-08-04"), "2026-08-04");
  assert.equal(parseIsoDate("  2026-08-04 "), "2026-08-04");
  for (const bad of ["2026-8-4", "04/08/2026", "2026-13-01", "2026-02-30", "2026-08-04T00:00:00Z", "", "  ", "yesterday", 20260804, null]) {
    assert.equal(parseIsoDate(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---- normStatementLine --------------------------------------------------------------------------
test("normStatementLine: identity + strict charge; blank execId routes order-level", () => {
  assert.deepEqual(normStatementLine({ execId: "E1", orderId: "O1", charges: 4 }), { execId: "E1", orderId: "O1", charges: 4, source: "contract-note" });
  assert.deepEqual(normStatementLine({ execId: "  ", orderId: "O1", charges: 4 }), { orderId: "O1", charges: 4, source: "contract-note" });
  assert.equal(normStatementLine({ charges: 4 }), null, "no identity ⇒ reject");
  assert.equal(normStatementLine({ orderId: "O1", charges: true }), null, "boolean charge ⇒ reject");
  assert.equal(normStatementLine([]), null);
  assert.equal(normStatementLine(null), null);
});

// ---- validateStatement: envelope rejections -----------------------------------------------------
test("validateStatement: bare array (no provenance) is rejected", () => {
  const v = validateStatement([{ execId: "E1", charges: 1 }], { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.deepEqual(v.reasons, ["no-envelope"]);
});

test("validateStatement: missing lines array is rejected", () => {
  const v = validateStatement({ schemaVersion: "1", account: ACCT, tradingDate: "2026-08-04", settled: true, currency: "INR" }, { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.deepEqual(v.reasons, ["no-lines"]);
});

test("validateStatement: missing schema version rejected", () => {
  const v = validateStatement(goodEnvelope({ schemaVersion: undefined, version: undefined }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("schemaVersion"));
});

test("validateStatement: account missing and account mismatch rejected", () => {
  const miss = validateStatement(goodEnvelope({ account: undefined, accountId: undefined, fyId: undefined }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(miss.ok, false);
  assert.ok(miss.reasons.includes("account-missing"));
  const wrong = validateStatement(goodEnvelope({ account: "FY-999" }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.reasons.includes("account-mismatch"));
});

test("validateStatement: wrong currency rejected", () => {
  const v = validateStatement(goodEnvelope({ currency: "USD" }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("currency-not-INR"));
});

test("validateStatement: unsettled envelope rejected", () => {
  const v = validateStatement(goodEnvelope({ settled: false, settlement: undefined, final: undefined }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes("not-settled"));
});

// ---- validateStatement: R37-P2-02 trading-date rules --------------------------------------------
test("validateStatement: missing / malformed / future / out-of-window trading dates rejected", () => {
  const missing = validateStatement(goodEnvelope({ tradingDate: undefined, date: undefined }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.ok(!missing.ok && missing.reasons.includes("tradingDate-missing"));

  const badFmt = validateStatement(goodEnvelope({ tradingDate: "04/08/2026" }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.ok(!badFmt.ok && badFmt.reasons.includes("tradingDate-format"));

  const future = validateStatement(goodEnvelope({ tradingDate: "2026-08-05" }), { account: ACCT, allowedDates: null, nowMs: NOW });
  assert.ok(!future.ok && future.reasons.includes("tradingDate-future"));

  const wrongDay = validateStatement(goodEnvelope({ tradingDate: "2026-07-30" }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.ok(!wrongDay.ok && wrongDay.reasons.includes("tradingDate-out-of-window"), "settled statement for a day outside the reconciliation window is rejected");
});

test("validateStatement: date within window and not future is accepted", () => {
  const v = validateStatement(goodEnvelope({ tradingDate: "2026-08-03" }), { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.tradingDate, "2026-08-03");
});

// ---- validateStatement: happy path + malformed/mixed lines --------------------------------------
test("validateStatement: good envelope accepted; malformed lines rejected but good ones kept", () => {
  const env = goodEnvelope({
    lines: [
      { execId: "E1", orderId: "O1", charges: 12.5 }, // good exec-level
      { orderId: "O2", charges: "3.20" },             // good order-level
      { execId: "E3", charges: true },                // bad: boolean charge
      { charges: 9 },                                 // bad: no identity
      "not-an-object",                                // bad: not object
      { execId: "E5", orderId: "O3", charges: -1 },   // bad: negative
    ],
  });
  const v = validateStatement(env, { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.lines.length, 2, "only the two well-formed lines survive");
  assert.equal(v.rejected, 4, "four malformed lines counted as rejected");
  assert.equal(v.tradingDate, "2026-08-04");
  assert.equal(v.account, ACCT);
});

test("validateStatement: accumulates multiple envelope reasons at once", () => {
  const v = validateStatement({ lines: [], account: "X", tradingDate: "2026-08-04", currency: "USD" }, { account: ACCT, allowedDates: ALLOWED, nowMs: NOW });
  assert.equal(v.ok, false);
  for (const r of ["schemaVersion", "account-mismatch", "not-settled", "currency-not-INR"]) assert.ok(v.reasons.includes(r), `expected reason ${r}`);
});

// ---- istDayWindow ------------------------------------------------------------------------------
test("istDayWindow: covers each IST day across the lookback window (inclusive of now)", () => {
  const win = istDayWindow(Date.parse("2026-08-02T02:00:00Z"), Date.parse("2026-08-04T18:00:00Z"));
  for (const d of ["2026-08-02", "2026-08-03", "2026-08-04"]) assert.ok(win.includes(d), `window should include ${d}`);
});

// ---- module presence sanity --------------------------------------------------------------------
test("feeStatement module file exists at backend root and exports the pure API", () => {
  assert.ok(fs.existsSync(path.join(__dirname, "..", "feeStatement.js")));
  for (const fn of ["strictCharge", "nzId", "parseIsoDate", "normStatementLine", "validateStatement", "istDayWindow"]) {
    assert.equal(typeof feeStatement[fn], "function", `exports ${fn}`);
  }
});
