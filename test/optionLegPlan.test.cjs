const { test } = require("node:test");
const assert = require("node:assert");
const { planOptionLegs, expiryIntentOf, optionTypeOf, PLAN_FAILED } = require("../optionLegPlan");

/* Synthetic NIFTY NSE_FO master (already normalised to the fyersOptionChain row shape). Two Sept 2026 expiries
   in the same month → the earlier one is "weekly", the later (last of month) is "monthly". Strikes straddle a
   25000 spot so ATM=25000, OTM1 CALL=25100, OTM1 PUT=24900. Lot size 75. */
const WEEK = Date.UTC(2026, 8, 3);    // 2026-09-03 (weekly)
const MONTH = Date.UTC(2026, 8, 24);  // 2026-09-24 (monthly, last of Sept)
const NOW = Date.UTC(2026, 8, 1);
const STRIKES = [24800, 24900, 25000, 25100, 25200];
const ROWS = [];
for (const expiryMs of [WEEK, MONTH]) {
  for (const strike of STRIKES) {
    for (const optionType of ["CALL", "PUT"]) {
      const suf = optionType === "CALL" ? "CE" : "PE";
      ROWS.push({ ticker: `NSE:NIFTY${expiryMs}${strike}${suf}`, underlying: "NIFTY", productType: "OPTION", optionType, strike, expiryMs, lotSize: 75 });
    }
  }
}

test("label mappers", () => {
  assert.equal(expiryIntentOf("Current week"), "CURRENT_WEEK");
  assert.equal(expiryIntentOf("Current month"), "CURRENT_MONTH");
  assert.equal(expiryIntentOf(undefined), "CURRENT_WEEK");
  assert.equal(optionTypeOf("CE"), "CALL");
  assert.equal(optionTypeOf("PE"), "PUT");
  assert.equal(optionTypeOf("call"), "CALL");
  assert.equal(optionTypeOf("XX"), null);
});

test("single ATM CALL leg resolves to the weekly 25000CE with lots × lotSize qty", () => {
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current week", legs: [{ side: "BUY", type: "CE", mny: "ATM", lots: 2 }] },
    underlying: "NIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.legs.length, 1);
  const leg = r.legs[0];
  assert.equal(leg.optionType, "CALL");
  assert.equal(leg.strike, 25000);
  assert.equal(leg.expiry, WEEK);          // weekly picked
  assert.equal(leg.lots, 2);
  assert.equal(leg.quantity, 150);         // 2 × 75
  assert.equal(leg.side, "BUY");
  assert.equal(leg.tradingSymbol, `NSE:NIFTY${WEEK}25000CE`);
});

test("Current month picks the monthly expiry; OTM1 CALL steps up a strike", () => {
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current month", legs: [{ side: "BUY", type: "CE", mny: "OTM1", lots: 1 }] },
    underlying: "NIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.legs[0].strike, 25100);   // OTM1 call = one strike above ATM
  assert.equal(r.legs[0].expiry, MONTH);
});

test("OTM1 PUT steps DOWN a strike (direction-aware moneyness)", () => {
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current week", legs: [{ side: "BUY", type: "PE", mny: "OTM1", lots: 1 }] },
    underlying: "NIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.legs[0].optionType, "PUT");
  assert.equal(r.legs[0].strike, 24900);   // OTM1 put = one strike below ATM
});

test("multi-leg straddle (BUY CE + BUY PE) resolves both legs", () => {
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current week", strategy: "Straddle",
      legs: [{ side: "BUY", type: "CE", mny: "ATM", lots: 1 }, { side: "BUY", type: "PE", mny: "ATM", lots: 1 }] },
    underlying: "NIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[0].optionType, "CALL");
  assert.equal(r.legs[1].optionType, "PUT");
  assert.equal(r.strategy, "Straddle");
});

test("carries the requested SELL side onto the resolved leg", () => {
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current week", legs: [{ side: "SELL", type: "CE", mny: "OTM1", lots: 1 }] },
    underlying: "NIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.legs[0].side, "SELL");
});

test("FAIL CLOSED: disabled config, no legs, no spot, empty master", () => {
  assert.equal(planOptionLegs({ opt: { enabled: false, legs: [] }, underlying: "NIFTY", spot: 25000, rows: ROWS }).error, PLAN_FAILED);
  assert.equal(planOptionLegs({ opt: { enabled: true, legs: [] }, underlying: "NIFTY", spot: 25000, rows: ROWS }).detail, "no_legs");
  assert.equal(planOptionLegs({ opt: { enabled: true, legs: [{ side: "BUY", type: "CE", mny: "ATM", lots: 1 }] }, underlying: "NIFTY", spot: 0, rows: ROWS }).detail, "no_spot");
  assert.equal(planOptionLegs({ opt: { enabled: true, legs: [{ side: "BUY", type: "CE", mny: "ATM", lots: 1 }] }, underlying: "NIFTY", spot: 25000, rows: [] }).detail, "instrument_master_unavailable");
});

test("FAIL CLOSED: whole plan fails if ANY leg can't resolve (no partial spread)", () => {
  // OTM4 CALL needs a strike 4 rungs above ATM (25000) = beyond 25200, not listed → plan fails, legIndex reported.
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current week",
      legs: [{ side: "BUY", type: "CE", mny: "ATM", lots: 1 }, { side: "BUY", type: "CE", mny: "OTM4", lots: 1 }] },
    underlying: "NIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.error, PLAN_FAILED);
  assert.equal(r.legIndex, 1);
});

test("FAIL CLOSED: unknown underlying yields no chain (won't trade a wrong contract)", () => {
  const r = planOptionLegs({
    opt: { enabled: true, expiry: "Current week", legs: [{ side: "BUY", type: "CE", mny: "ATM", lots: 1 }] },
    underlying: "BANKNIFTY", spot: 25000, rows: ROWS, nowMs: NOW,
  });
  assert.equal(r.error, PLAN_FAILED);
});
