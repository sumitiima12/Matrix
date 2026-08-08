"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { detectSplitRatio, looksLikeCorporateAction } = require("../corporateActions");

test("detects a clean 2:1 forward split", () => {
  const d = detectSplitRatio(10, 20);
  assert.ok(d && Math.abs(d.ratio - 2) < 1e-9);
});

test("detects a reverse split (10 -> 2 = 1:5)", () => {
  const d = detectSplitRatio(10, 2);
  assert.ok(d && Math.abs(d.ratio - 0.2) < 1e-9);
});

test("no change is not a corporate action", () => {
  assert.strictEqual(detectSplitRatio(10, 10), null);
  assert.strictEqual(detectSplitRatio(10, 10.1), null);   // within tolerance = unchanged
});

test("a messy, non-clean-ratio change is not flagged", () => {
  assert.strictEqual(detectSplitRatio(10, 13), null);   // 1.3x — not a recognised split
});

test("invalid inputs return null (no false positives)", () => {
  assert.strictEqual(detectSplitRatio(0, 20), null);
  assert.strictEqual(detectSplitRatio(10, 0), null);
  assert.strictEqual(detectSplitRatio(-5, -10), null);
});

test("looksLikeCorporateAction: notional-preserving split is likely", () => {
  // 10 @ 100 -> 20 @ 50: 2:1 split, notional 1000 unchanged.
  const r = looksLikeCorporateAction(10, 100 / 1, 100, 50) && looksLikeCorporateAction(10, 20, 100, 50);
  const res = looksLikeCorporateAction(10, 20, 100, 50);
  assert.ok(res.likely);
  assert.strictEqual(res.notionalPreserved, true);
  assert.strictEqual(res.lowConfidence, false);
});

test("looksLikeCorporateAction: clean ratio but notional NOT preserved is not likely", () => {
  // 10 @ 100 -> 20 @ 100: qty doubled but price unchanged → notional doubled → NOT a split (real drift).
  const res = looksLikeCorporateAction(10, 20, 100, 100);
  assert.strictEqual(res.likely, false);
  assert.strictEqual(res.notionalPreserved, false);
});

test("looksLikeCorporateAction: no prices → low-confidence flag on clean ratio", () => {
  const res = looksLikeCorporateAction(10, 20);
  assert.ok(res.likely);
  assert.strictEqual(res.lowConfidence, true);
  assert.strictEqual(res.notionalPreserved, null);
});
