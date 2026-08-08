/**
 * test/incidents.test.cjs — REC-7 support + incident handling. Proves the lifecycle transitions are legal-only,
 * severity auto-assignment escalates money/halt reports, tickets normalise safely, and SLA breach is exact.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition, autoSeverity, normalizeTicket, slaBreached, SEVERITIES } = require("../incidents");

test("status transitions: legal moves allowed, illegal + unknown rejected", () => {
  assert.equal(canTransition("new", "acknowledged"), true);
  assert.equal(canTransition("resolved", "reopened"), true);
  assert.equal(canTransition("closed", "reopened"), true);
  assert.equal(canTransition("new", "closed"), true);
  assert.equal(canTransition("resolved", "new"), false);        // can't jump back without reopening
  assert.equal(canTransition("closed", "in_progress"), false);
  assert.equal(canTransition("bogus", "new"), false);           // unknown state → fail closed
});

test("autoSeverity escalates money/halt reports", () => {
  assert.equal(autoSeverity({ category: "money-discrepancy", body: "I was charged twice" }), "sev1");
  assert.equal(autoSeverity({ category: "order-issue", body: "can't close my position" }), "sev1");
  assert.equal(autoSeverity({ category: "order-issue", body: "minor label typo" }), "sev2");
  assert.equal(autoSeverity({ category: "broker-connection", body: "connection is down" }), "sev2");
  assert.equal(autoSeverity({ category: "feature-request", body: "please add dark mode" }), "sev4");
  assert.equal(autoSeverity({ category: "other", body: "just a question" }), "sev3");
});

test("normalizeTicket bounds category + text and assigns a valid severity/status", () => {
  const t = normalizeTicket({ category: "not-a-real-cat", subject: "x".repeat(500), body: "y".repeat(9000) });
  assert.equal(t.category, "other");
  assert.equal(t.subject.length, 140);
  assert.equal(t.body.length, 4000);
  assert.ok(SEVERITIES[t.severity]);
  assert.equal(t.status, "new");
  // explicit valid severity is respected
  assert.equal(normalizeTicket({ category: "bug", severity: "sev1", body: "z" }).severity, "sev1");
});

test("slaBreached: overdue when unacked past target; met when acked within target", () => {
  const t0 = 1_000_000;
  const target = SEVERITIES.sev1.targetMs;                       // 15 min
  assert.equal(slaBreached("sev1", t0, t0 + target + 1), true);  // unacked, past target → breached
  assert.equal(slaBreached("sev1", t0, t0 + target - 1), false); // still within target
  assert.equal(slaBreached("sev1", t0, t0 + 999, t0 + target - 1000), false); // acked in time
  assert.equal(slaBreached("sev1", t0, t0 + 999, t0 + target + 1000), true);  // acked too late
  assert.equal(slaBreached("bogus", t0, t0 + 1e9), false);       // unknown sev → not breached (no target)
});
