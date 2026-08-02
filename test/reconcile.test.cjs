/**
 * test/reconcile.test.cjs — unit tests for the PURE reconciliation + OAuth-binding decision logic
 * (R6-P2-04). These paths govern real money, so they're tested without a live broker or server.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../reconcile");

test("hasClientOrderId matches our stamped id, tolerates junk", () => {
  const recs = [{ client_order_id: "a" }, { client_order_id: "mx_1" }, {}];
  assert.equal(R.hasClientOrderId(recs, "mx_1"), true);
  assert.equal(R.hasClientOrderId(recs, "mx_2"), false);
  assert.equal(R.hasClientOrderId(null, "mx_1"), false);
});

test("pageConclusive: short page conclusive; full recent page inconclusive; full page past boundary conclusive", () => {
  const now = 1_700_000_000_000;
  const shortPage = [{ created_at: now }];
  assert.equal(R.pageConclusive(shortPage, 500, now), true);         // fewer than page_size → saw them all
  const fullRecent = Array.from({ length: 500 }, () => ({ created_at: now }));
  assert.equal(R.pageConclusive(fullRecent, 500, now - 10 * 60000), false);   // all newer than a 10-min-old order → maybe more
  const fullPast = fullRecent.slice(0, 499).concat([{ created_at: now - 3 * 3600_000 }]);   // one record 3h older than boundary
  assert.equal(R.pageConclusive(fullPast, 500, now - 60000), true);  // scanned past where our order would be
  assert.equal(R.pageConclusive("nope", 500, now), false);           // bad schema → inconclusive
});

test("pageConclusive: unparseable timestamps never falsely conclude a full page", () => {
  const full = Array.from({ length: 500 }, () => ({ created_at: "not-a-date" }));
  assert.equal(R.pageConclusive(full, 500, 1_700_000_000_000), false);
});

test("parseDeltaTs handles ISO, ms, µs, seconds", () => {
  assert.equal(R.parseDeltaTs(1_700_000_000_000), 1_700_000_000_000);          // ms passthrough
  assert.equal(R.parseDeltaTs(1_700_000_000_000_000), 1_700_000_000_000);      // µs → ms
  assert.equal(R.parseDeltaTs(1_700_000_000), 1_700_000_000_000);              // s → ms
  assert.equal(R.parseDeltaTs("2023-11-14T22:13:20.000Z"), Date.parse("2023-11-14T22:13:20.000Z"));
  assert.equal(R.parseDeltaTs("garbage"), null);
});

test("redirectAllowed: exact origin + path boundary, no subdomain prefix bypass", () => {
  const allow = ["https://matrixone.app/oauth"];
  assert.equal(R.redirectAllowed("https://matrixone.app/oauth", allow), true);
  assert.equal(R.redirectAllowed("https://matrixone.app/oauth/callback", allow), true);
  assert.equal(R.redirectAllowed("https://matrixone.app/other", allow), false);   // wrong path
  assert.equal(R.redirectAllowed("https://matrixone.app.attacker.example/oauth", allow), false);  // subdomain attack blocked
  assert.equal(R.redirectAllowed("http://matrixone.app/oauth", allow), false);    // scheme mismatch
  assert.equal(R.redirectAllowed("https://matrixone.app/anything", ["https://matrixone.app"]), true);  // bare origin allows any path
  assert.equal(R.redirectAllowed("https://x.example/y", []), true);   // empty allow-list = opt-in
  assert.equal(R.redirectAllowed(null, allow), true);                 // no redirect = nothing to gate
});

test("classifyDeltaOrder: fully-filled / partial / rejected fill truth", () => {
  const full = R.classifyDeltaOrder({ id: 7, size: 5, unfilled_size: 0, state: "closed", average_fill_price: 100 }, 5);
  assert.equal(full.fullyFilled, true); assert.equal(full.partial, false); assert.equal(full.filled, 5); assert.equal(full.orderId, 7);
  const part = R.classifyDeltaOrder({ id: 8, size: 5, unfilled_size: 2, state: "open" }, 5);
  assert.equal(part.fullyFilled, false); assert.equal(part.partial, true); assert.equal(part.filled, 3); assert.equal(part.unfilled, 2);
  const rej = R.classifyDeltaOrder({ id: 9, size: 5, unfilled_size: 5, state: "rejected" }, 5);
  assert.equal(rej.rejected, true); assert.equal(rej.fullyFilled, false); assert.equal(rej.filled, 0);
  // Missing size falls back to the requested contracts; a plain "closed" implies fully filled.
  const closed = R.classifyDeltaOrder({ id: 10, state: "closed" }, 4);
  assert.equal(closed.fullyFilled, true); assert.equal(closed.filled, 4);
});

test("classifyFyersOrder: acceptance is not execution — only status 2 with qty is filled", () => {
  // status 2 = traded/filled
  const filled = R.classifyFyersOrder({ status: 2, qty: 10, filledQty: 10, tradedPrice: 250.5 });
  assert.equal(filled.filled, true); assert.equal(filled.rejected, false); assert.equal(filled.pending, false);
  assert.equal(filled.filledQty, 10); assert.equal(filled.avgPrice, 250.5);
  // status 6 = pending: accepted but NOT filled → must be pending, never filled
  const pending = R.classifyFyersOrder({ status: 6, qty: 10, filledQty: 0 });
  assert.equal(pending.filled, false); assert.equal(pending.pending, true); assert.equal(pending.rejected, false);
  // status 4 = transit → pending
  assert.equal(R.classifyFyersOrder({ status: 4, qty: 5 }).pending, true);
  // status 5 = rejected, status 1 = cancelled → rejected, nothing executed
  assert.equal(R.classifyFyersOrder({ status: 5, qty: 5 }).rejected, true);
  assert.equal(R.classifyFyersOrder({ status: 1, qty: 5 }).rejected, true);
  // status 2 but zero filledQty (schema oddity) → NOT treated as filled (safe direction)
  assert.equal(R.classifyFyersOrder({ status: 2, qty: 5, filledQty: 0 }).filled, false);
  // empty/garbage → pending, never a phantom fill
  assert.equal(R.classifyFyersOrder(null).pending, true);
  assert.equal(R.classifyFyersOrder({}).filled, false);
});

test("fyersOrderTag: FYERS-safe, deterministic, ≤20 chars; hasFyersOrderTag scans the order book", () => {
  const cid = "mx_abcdef123_1700000000000";
  const tag = R.fyersOrderTag(cid);
  assert.ok(tag && tag.length <= 20 && /^[a-zA-Z0-9]+$/.test(tag));   // FYERS orderTag rules
  assert.equal(R.fyersOrderTag(cid), tag);                            // deterministic (stamp == probe)
  assert.equal(R.fyersOrderTag(""), null);
  assert.equal(R.fyersOrderTag(null), null);
  const book = [{ orderTag: "other" }, { orderTag: tag }, {}];
  assert.equal(R.hasFyersOrderTag(book, tag), true);
  assert.equal(R.hasFyersOrderTag(book, "missing"), false);
  assert.equal(R.hasFyersOrderTag(book, null), false);
  assert.equal(R.hasFyersOrderTag(null, tag), false);
});

test("attributeFyersFills: sums ONLY our tagged fills, weighted avg; ignores others' holdings", () => {
  const book = [
    { orderTag: "mine", status: 2, qty: 6, filledQty: 6, tradedPrice: 100 },   // ours
    { orderTag: "mine", status: 2, qty: 4, filledQty: 4, tradedPrice: 110 },   // ours (second slice)
    { orderTag: "other", status: 2, qty: 50, filledQty: 50, tradedPrice: 90 }, // someone else's / pre-existing
    { orderTag: "mine", status: 6, qty: 5, filledQty: 0 },                      // ours but not filled
  ];
  const r = R.attributeFyersFills(book, "mine");
  assert.equal(r.filledQty, 10);                        // 6 + 4, NOT the 50 from "other"
  assert.equal(r.avgPrice, (6 * 100 + 4 * 110) / 10);   // 104 weighted
  assert.deepEqual(R.attributeFyersFills(book, "missing"), { filledQty: 0, avgPrice: null });
  assert.deepEqual(R.attributeFyersFills(null, "mine"), { filledQty: 0, avgPrice: null });
  // No priced fills → filledQty counted, avgPrice null (caller falls back).
  const noPrice = R.attributeFyersFills([{ orderTag: "t", status: 2, qty: 3, filledQty: 3 }], "t");
  assert.equal(noPrice.filledQty, 3); assert.equal(noPrice.avgPrice, null);
});

test("fyersExitPlan: fails CLOSED on unknown holding; clamps to holding; refuses flat/short", () => {
  // Holdings read failed → place NO order (caller retries) — must NOT fall back to requested qty.
  assert.deepEqual(R.fyersExitPlan(null, 10), { action: "unverified", sellQty: 0 });
  // Flat or short → nothing to close with a SELL.
  assert.deepEqual(R.fyersExitPlan(0, 10), { action: "flat", sellQty: 0 });
  assert.deepEqual(R.fyersExitPlan(-5, 10), { action: "flat", sellQty: 0 });
  // Normal: sell what we want, capped at the real holding (retry after a partial can't oversell).
  assert.deepEqual(R.fyersExitPlan(10, 10), { action: "sell", sellQty: 10 });
  assert.deepEqual(R.fyersExitPlan(4, 10), { action: "sell", sellQty: 4 });   // only 4 left → sell 4, never 10
  assert.deepEqual(R.fyersExitPlan(10, 3), { action: "sell", sellQty: 3 });
});

test("closingIsStale: fresh claim waits; missing/old timestamp reconciles (never skipped forever)", () => {
  const now = 1_700_000_000_000, stale = 3 * 60_000;
  assert.equal(R.closingIsStale(now - 10_000, now, stale), false);   // 10s old → still in-flight, wait
  assert.equal(R.closingIsStale(now - 5 * 60_000, now, stale), true); // 5 min old → stranded, reconcile
  assert.equal(R.closingIsStale(now, now, stale), false);            // just claimed → wait
  assert.equal(R.closingIsStale(0, now, stale), true);               // no timestamp (legacy/crash) → reconcile now
  assert.equal(R.closingIsStale(null, now, stale), true);
  assert.equal(R.closingIsStale(undefined, now, stale), true);
});

test("redirectBindingOk: mismatch always rejected; missing rejected only when enforcing", () => {
  assert.deepEqual(R.redirectBindingOk(null, null, true), { ok: true });                 // nothing bound
  assert.equal(R.redirectBindingOk("https://a/x", "https://a/x", false).ok, true);       // match
  assert.equal(R.redirectBindingOk("https://a/x", "https://a/y", false).ok, false);      // mismatch always rejected
  assert.equal(R.redirectBindingOk("https://a/x", null, false).ok, true);                // missing + not enforcing → allowed
  assert.equal(R.redirectBindingOk("https://a/x", null, true).ok, false);                // missing + enforcing → rejected
});
