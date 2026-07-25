const test = require("node:test");
const assert = require("node:assert/strict");
const { marketOpenIST, minsToCloseIST, intradaySquareDue } = require("../marketHours");

/* Build a UTC epoch that corresponds to a given IST wall-clock on a given weekday.
   IST = UTC+5:30, so IST 09:15 == UTC 03:45. We anchor to known dates whose weekday we control:
   2025-07-21 is a Monday. */
function istEpoch(dateISO, hh, mm) {
  // dateISO is a YYYY-MM-DD in IST; convert IST wall time to UTC by subtracting 5:30.
  const [y, m, d] = dateISO.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3600 * 1000;
}
const MON = "2025-07-21";   // Monday
const SAT = "2025-07-26";   // Saturday
const SUN = "2025-07-27";   // Sunday

test("Crypto is always open", () => {
  assert.equal(marketOpenIST("Crypto", istEpoch(SAT, 3, 0)), true);
  assert.equal(marketOpenIST("Crypto", istEpoch(SUN, 23, 59)), true);
});

test("Indian equity open only 09:15-15:30 on weekdays", () => {
  assert.equal(marketOpenIST("IN", istEpoch(MON, 9, 14)), false);   // before bell
  assert.equal(marketOpenIST("IN", istEpoch(MON, 9, 15)), true);    // at the bell
  assert.equal(marketOpenIST("IN", istEpoch(MON, 12, 0)), true);
  assert.equal(marketOpenIST("IN", istEpoch(MON, 15, 30)), true);   // at close
  assert.equal(marketOpenIST("IN", istEpoch(MON, 15, 31)), false);  // after close
  assert.equal(marketOpenIST("IN", istEpoch(MON, 20, 18)), false);  // the 8:18pm bug
});

test("Indian equity closed on the weekend", () => {
  assert.equal(marketOpenIST("IN", istEpoch(SAT, 11, 0)), false);
  assert.equal(marketOpenIST("IN", istEpoch(SUN, 11, 0)), false);
});

test("Commodity open 09:00-23:30 on weekdays", () => {
  assert.equal(marketOpenIST("Commodity", istEpoch(MON, 8, 59)), false);
  assert.equal(marketOpenIST("Commodity", istEpoch(MON, 9, 0)), true);
  assert.equal(marketOpenIST("Commodity", istEpoch(MON, 23, 30)), true);
  assert.equal(marketOpenIST("Commodity", istEpoch(MON, 23, 31)), false);
  assert.equal(marketOpenIST("Commodity", istEpoch(SAT, 12, 0)), false);
});

test("US session spans the evening into early next morning IST", () => {
  assert.equal(marketOpenIST("US", istEpoch(MON, 19, 0)), true);    // 7:00pm IST Mon
  assert.equal(marketOpenIST("US", istEpoch(MON, 18, 59)), false);
  // 1:00am IST on the following day (Tue) is still the Monday US session
  assert.equal(marketOpenIST("US", istEpoch("2025-07-22", 1, 0)), true);
  assert.equal(marketOpenIST("US", istEpoch("2025-07-22", 1, 31)), false);
});

test("FNO follows the same window as IN", () => {
  assert.equal(marketOpenIST("FNO", istEpoch(MON, 10, 0)), true);
  assert.equal(marketOpenIST("FNO", istEpoch(MON, 16, 0)), false);
});

test("minsToCloseIST: Indian close is 15:30", () => {
  assert.equal(minsToCloseIST("IN", istEpoch(MON, 15, 0)), 30);
  assert.equal(minsToCloseIST("IN", istEpoch(MON, 15, 30)), 0);
  assert.equal(minsToCloseIST("Crypto", istEpoch(MON, 15, 0)), null);
});

test("intradaySquareDue: true within 15 min of Indian close", () => {
  assert.equal(intradaySquareDue("IN", istEpoch(MON, 15, 10)), false);  // 20 min to close -> not yet
  assert.equal(intradaySquareDue("IN", istEpoch(MON, 15, 20)), true);   // 10 min to close -> due
  assert.equal(intradaySquareDue("IN", istEpoch(MON, 12, 0)), false);   // mid-session
});

test("intradaySquareDue: true once the market is closed (never carry overnight)", () => {
  assert.equal(intradaySquareDue("IN", istEpoch(MON, 20, 0)), true);    // after hours
  assert.equal(intradaySquareDue("IN", istEpoch(SAT, 12, 0)), true);    // weekend
});

test("intradaySquareDue: crypto never squares off", () => {
  assert.equal(intradaySquareDue("Crypto", istEpoch(SAT, 3, 0)), false);
});
