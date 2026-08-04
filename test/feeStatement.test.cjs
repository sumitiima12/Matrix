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
const { strictCharge, parseIsoDate, normStatementLine, validateStatement, istDayWindow, brokerTradingDay, normalizeDeltaFills } = feeStatement;

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

// ---- R38-P2-02: brokerTradingDay ---------------------------------------------------------------
test("brokerTradingDay: parses epoch seconds, epoch millis and ISO to an IST day; null on garbage", () => {
  const iso = "2026-08-04T09:30:00Z"; // 15:00 IST on 2026-08-04
  assert.equal(brokerTradingDay(iso), "2026-08-04");
  assert.equal(brokerTradingDay(Math.floor(Date.parse(iso) / 1000)), "2026-08-04"); // seconds
  assert.equal(brokerTradingDay(Date.parse(iso)), "2026-08-04");                    // millis
  // 2026-08-04T20:00Z = 01:30 IST next day ⇒ 2026-08-05
  assert.equal(brokerTradingDay("2026-08-04T20:00:00Z"), "2026-08-05");
  for (const bad of ["", "  ", "not-a-date", null, undefined, NaN]) assert.equal(brokerTradingDay(bad), null);
});

// ---- R38-P2-02: normalizeDeltaFills ------------------------------------------------------------
test("normalizeDeltaFills: refuses to finalize when pagination is incomplete (watermark)", () => {
  const r = normalizeDeltaFills([{ id: "1", commission: "1", created_at: "2026-08-04T05:00:00Z" }], { tradingDate: "2026-08-04", complete: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "incomplete-pagination");
});

test("normalizeDeltaFills: keeps only the requested trading day; drops other days", () => {
  const rows = [
    { id: "a", order_id: "OA", commission: "1.50", created_at: "2026-08-04T05:00:00Z" }, // 04
    { id: "b", order_id: "OB", commission: "2.00", created_at: "2026-08-03T05:00:00Z" }, // 03 (off-day)
    { id: "c", order_id: "OC", commission: "3.00", created_at: "2026-08-04T06:00:00Z" }, // 04
  ];
  const r = normalizeDeltaFills(rows, { tradingDate: "2026-08-04", complete: true });
  assert.equal(r.ok, true);
  assert.equal(r.kept, 2);
  assert.equal(r.offday, 1);
  assert.deepEqual(r.lines.map((l) => l.execId).sort(), ["a", "c"]);
  assert.ok(r.lines.every((l) => l.tradingDate === "2026-08-04"));
});

test("normalizeDeltaFills: rejects malformed rows + wrong account; strict commission; de-dupes exec ids", () => {
  const rows = [
    { id: "a", commission: "1.50", created_at: "2026-08-04T05:00:00Z", account_id: "ACC1" }, // good
    { id: "a", commission: "1.50", created_at: "2026-08-04T05:00:00Z", account_id: "ACC1" }, // duplicate exec id ⇒ once
    { id: "b", commission: true, created_at: "2026-08-04T05:00:00Z", account_id: "ACC1" },   // boolean ⇒ reject
    { id: "c", commission: "2", created_at: "2026-08-04T05:00:00Z", account_id: "OTHER" },   // wrong account ⇒ reject
    "garbage",                                                                                // not object ⇒ reject
    { commission: "2", created_at: "2026-08-04T05:00:00Z" },                                  // no id ⇒ reject
  ];
  const r = normalizeDeltaFills(rows, { tradingDate: "2026-08-04", account: "ACC1", complete: true });
  assert.equal(r.ok, true);
  assert.equal(r.kept, 1, "only the single good, de-duped line survives");
  assert.equal(r.lines[0].execId, "a");
  assert.ok(r.rejected >= 3);
});

// ---- R39-P2-01: account provenance (unattributed rows) ----------------------------------------
test("normalizeDeltaFills: an unattributed row (no account field) is REJECTED unless envelope-verified", () => {
  const rows = [{ id: "x", commission: "1", created_at: "2026-08-04T05:00:00Z" }];   // no account_id/account/user_id
  const unverified = normalizeDeltaFills(rows, { tradingDate: "2026-08-04", account: "ACC1", complete: true });
  assert.equal(unverified.kept, 0, "not accepted without envelope proof");
  assert.equal(unverified.unattributed, 1);
  assert.ok(unverified.rejected >= 1, "the unattributed row is rejected");

  const verified = normalizeDeltaFills(rows, { tradingDate: "2026-08-04", account: "ACC1", complete: true, accountVerified: true });
  assert.equal(verified.kept, 1, "accepted once the caller proved the account↔credential binding");
  assert.equal(verified.unattributed, 1);
  assert.equal(verified.accountVerified, true);
});

// ---- R39-P1-02: pure paginator (HTTP-level cursor behavior) ------------------------------------
const { paginateDeltaFills } = feeStatement;
const row = (id) => ({ id, commission: "1", created_at: "2026-08-04T05:00:00Z", account_id: "ACC1" });

test("paginateDeltaFills: page 2 receives the cursor, all pages included once, ends complete on absent cursor", async () => {
  const pages = [
    { result: [row("a"), row("b")], meta: { after: "c1" } },
    { result: [row("c"), row("d")], meta: { after: "c2" } },
    { result: [row("e")], meta: { after: null } },   // authoritative end
  ];
  const seen = []; let i = 0;
  const call = async (query) => { seen.push(query); return pages[i++]; };
  const r = await paginateDeltaFills(call, { pageSize: 2, maxPages: 10 });
  assert.equal(r.complete, true);
  assert.equal(r.rows.length, 5, "every page's rows are included exactly once");
  assert.match(seen[0], /page_size=2/);
  assert.ok(!/after=/.test(seen[0]), "first request carries no cursor");
  assert.match(seen[1], /after=c1/, "second request sends the page-1 cursor");
  assert.match(seen[2], /after=c2/, "third request sends the page-2 cursor");
});

test("paginateDeltaFills: a repeated (non-advancing) cursor FAILS CLOSED (complete:false)", async () => {
  const call = async () => ({ result: [row("z")], meta: { after: "SAME" } });   // never advances
  const r = await paginateDeltaFills(call, { pageSize: 2, maxPages: 10 });
  assert.equal(r.complete, false, "a stuck cursor must not report completion");
});

test("paginateDeltaFills: a malformed/failed mid-page response FAILS CLOSED", async () => {
  const pages = [{ result: [row("a")], meta: { after: "c1" } }, null];   // 2nd fetch failed
  let i = 0;
  const r = await paginateDeltaFills(async () => pages[i++], { pageSize: 2, maxPages: 10 });
  assert.equal(r.complete, false);
  assert.equal(r.rows.length, 1, "only the first page's rows are retained");
});

test("paginateDeltaFills: an empty page ends the loop as complete", async () => {
  const r = await paginateDeltaFills(async () => ({ result: [], meta: { after: "c1" } }), { pageSize: 2, maxPages: 10 });
  assert.equal(r.complete, true);
  assert.equal(r.rows.length, 0);
});

test("paginateDeltaFills: hitting the page cap with a live cursor NEVER reports completion", async () => {
  let n = 0;
  const call = async () => ({ result: [row("a"), row("b")], meta: { after: "c" + (++n) } });   // always advances
  const r = await paginateDeltaFills(call, { pageSize: 2, maxPages: 3 });
  assert.equal(r.pages, 3, "stopped at the cap");
  assert.equal(r.complete, false, "capped pagination is incomplete → fees stay provisional");
});

// ---- module presence sanity --------------------------------------------------------------------
test("feeStatement module file exists at backend root and exports the pure API", () => {
  assert.ok(fs.existsSync(path.join(__dirname, "..", "feeStatement.js")));
  for (const fn of ["strictCharge", "nzId", "parseIsoDate", "normStatementLine", "validateStatement", "istDayWindow", "brokerTradingDay", "normalizeDeltaFills", "paginateDeltaFills"]) {
    assert.equal(typeof feeStatement[fn], "function", `exports ${fn}`);
  }
});
