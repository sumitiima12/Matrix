/**
 * test/riskPolicy.test.cjs — the SERVER-OWNED risk policy is the real safety control on every real order,
 * so its merge rule (a client override may only TIGHTEN, never loosen) is proven here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanRiskPolicy, strictestRiskPolicy } = require("../riskPolicy");

test("cleanRiskPolicy keeps only clean positive caps, drops junk/unknown", () => {
  assert.deepEqual(cleanRiskPolicy({ maxOpenPositions: 5, maxDailyLossPct: "10", bogus: 1, maxTradesPerDay: 0, cooldownMs: -3 }),
    { maxOpenPositions: 5, maxDailyLossPct: 10 });
  assert.deepEqual(cleanRiskPolicy(null), {});
  assert.deepEqual(cleanRiskPolicy("nope"), {});
});

test("strictestRiskPolicy: client CANNOT loosen a server cap (the security guarantee)", () => {
  const server = { maxOpenPositions: 5, maxDailyLossPct: 10, cooldownMs: 60000 };
  // Client omits everything → server caps fully preserved.
  assert.deepEqual(strictestRiskPolicy(server, {}), server);
  assert.deepEqual(strictestRiskPolicy(server, null), server);
  // Client tries to LOOSEN → ignored (stays at the stricter server value).
  assert.equal(strictestRiskPolicy(server, { maxOpenPositions: 99 }).maxOpenPositions, 5);
  assert.equal(strictestRiskPolicy(server, { cooldownMs: 1000 }).cooldownMs, 60000);   // shorter wait = looser → ignored
  // Client TIGHTENS → applied.
  assert.equal(strictestRiskPolicy(server, { maxOpenPositions: 3 }).maxOpenPositions, 3);
  assert.equal(strictestRiskPolicy(server, { cooldownMs: 120000 }).cooldownMs, 120000); // longer wait = stricter → applied
});

test("strictestRiskPolicy: a cap present on only one side is carried through", () => {
  assert.deepEqual(strictestRiskPolicy({ maxTradesPerDay: 4 }, { maxPositionPct: 20 }),
    { maxTradesPerDay: 4, maxPositionPct: 20 });
});
