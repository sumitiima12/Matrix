/**
 * test/suitability.test.cjs — REC-5 onboarding suitability check. Proves grading fails closed and treats
 * safety-critical concepts as mandatory.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { QUESTIONS, gradeSuitability, questionsPublic } = require("../suitability");

const allCorrect = () => Object.fromEntries(QUESTIONS.map((q) => [q.id, q.answer]));

test("public view hides answers but exposes prompt/options/critical + threshold", () => {
  const v = questionsPublic();
  assert.ok(v.questions.length === QUESTIONS.length);
  assert.ok(v.questions.every((q) => !("answer" in q) && Array.isArray(q.options) && typeof q.critical === "boolean"));
  assert.equal(v.passThresholdPct, 80);
});

test("all correct → passed", () => {
  const r = gradeSuitability(allCorrect());
  assert.equal(r.passed, true);
  assert.equal(r.correct, r.total);
  assert.deepEqual(r.missed, []);
});

test("missing ONE critical concept fails even if overall % is high", () => {
  const ans = allCorrect();
  const crit = QUESTIONS.find((q) => q.critical);
  ans[crit.id] = (crit.answer + 1) % crit.options.length;   // wrong on a critical question
  const r = gradeSuitability(ans);
  assert.equal(r.passed, false);
  assert.ok(r.criticalMissed.includes(crit.id));
});

test("unanswered / out-of-range answers count as wrong (fail closed)", () => {
  assert.equal(gradeSuitability({}).passed, false);
  assert.equal(gradeSuitability(null).passed, false);
  const ans = allCorrect(); ans[QUESTIONS[0].id] = 999;
  assert.ok(gradeSuitability(ans).missed.includes(QUESTIONS[0].id));
});

test("non-critical miss can still pass IF threshold met and all critical correct", () => {
  const nonCrit = QUESTIONS.find((q) => !q.critical);
  const criticalCount = QUESTIONS.filter((q) => q.critical).length;
  // Only meaningful if a single non-critical miss keeps us ≥80%.
  if (nonCrit && (QUESTIONS.length - 1) / QUESTIONS.length >= 0.8) {
    const ans = allCorrect(); ans[nonCrit.id] = (nonCrit.answer + 1) % nonCrit.options.length;
    const r = gradeSuitability(ans);
    assert.equal(r.criticalMissed.length, 0);
    assert.equal(r.passed, true);
  }
  assert.ok(criticalCount >= 1, "there must be at least one critical question");
});
