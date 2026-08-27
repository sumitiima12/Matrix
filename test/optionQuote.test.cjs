const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeDeltaOptionTicker, normalizeYahooOptionChain, yahooExpiryEpoch, fetchOptionPremium } = require("../optionQuote");

test("Delta option ticker → mark_price is the premium, with bid/ask", () => {
  const r = normalizeDeltaOptionTicker({ mark_price: "1234.5", close: 1230, quotes: { best_bid: "1220", best_ask: "1240" }, timestamp: 1_700_000_000_000_000 });
  assert.equal(r.premium, 1234.5);
  assert.equal(r.bid, 1220);
  assert.equal(r.ask, 1240);
  assert.equal(r.source, "delta");
  assert.equal(r.asOf, 1_700_000_000_000);   // μs → ms
});

test("Delta option ticker fails closed when no mark price", () => {
  assert.equal(normalizeDeltaOptionTicker({ quotes: {} }).premium, null);
  assert.equal(normalizeDeltaOptionTicker(null).reason, "no_ticker");
});

test("Delta falls back to close when mark_price absent", () => {
  assert.equal(normalizeDeltaOptionTicker({ close: 999 }).premium, 999);
});

const YCHAIN = {
  optionChain: { result: [ { options: [ {
    calls: [ { strike: 95, lastPrice: 7.1, bid: 7.0, ask: 7.2 }, { strike: 100, lastPrice: 5.2, bid: 5.1, ask: 5.3, openInterest: 12, impliedVolatility: 0.4 } ],
    puts:  [ { strike: 100, lastPrice: 3.4, bid: 3.3, ask: 3.5 } ],
  } ] } ] },
};

test("Yahoo option chain → picks the exact strike + side", () => {
  const call = normalizeYahooOptionChain(YCHAIN, { strike: 100, optionType: "CALL" });
  assert.equal(call.premium, 5.2); assert.equal(call.bid, 5.1); assert.equal(call.ask, 5.3);
  assert.equal(call.openInterest, 12); assert.equal(call.source, "yahoo");
  const put = normalizeYahooOptionChain(YCHAIN, { strike: 100, optionType: "PUT" });
  assert.equal(put.premium, 3.4);
});

test("Yahoo uses bid/ask mid when lastPrice missing", () => {
  const json = { optionChain: { result: [ { options: [ { calls: [ { strike: 50, bid: 2, ask: 3 } ], puts: [] } ] } ] } };
  assert.equal(normalizeYahooOptionChain(json, { strike: 50, optionType: "CALL" }).premium, 2.5);
});

test("Yahoo fails closed: strike not listed / empty chain", () => {
  assert.equal(normalizeYahooOptionChain(YCHAIN, { strike: 123, optionType: "CALL" }).reason, "strike_not_listed");
  assert.equal(normalizeYahooOptionChain({}, { strike: 100, optionType: "CALL" }).reason, "no_option_chain");
});

test("yahooExpiryEpoch → UTC-midnight epoch seconds; null on bad input", () => {
  assert.equal(yahooExpiryEpoch("2026-08-21"), Math.floor(Date.UTC(2026, 7, 21) / 1000));
  assert.equal(yahooExpiryEpoch("nope"), null);
});

test("fetchOptionPremium routes by market + fails closed without deps", async () => {
  assert.equal((await fetchOptionPremium({ market: "IN" })).reason, "use_fyers_option_chain");
  assert.equal((await fetchOptionPremium({ market: "Commodity" })).reason, "no_option_feed_for_market");
  assert.equal((await fetchOptionPremium({ market: "Crypto" }, {})).reason, "crypto_feed_unavailable");
  // Crypto with an injected getter
  const r = await fetchOptionPremium({ market: "Crypto", deltaSymbol: "C-BTC-100000-261225" }, { deltaGet: async () => ({ result: { mark_price: 42 } }) });
  assert.equal(r.premium, 42);
  // US with an injected getter — strike 100 CALL is in the fixture → premium 5.2
  const u = await fetchOptionPremium({ market: "US", underlying: "TSLA", strike: 100, optionType: "CALL", expiryISO: "2026-08-21" }, { yahooGet: async () => YCHAIN });
  assert.equal(u.premium, 5.2);
  // A strike not listed → fails closed
  const miss = await fetchOptionPremium({ market: "US", underlying: "TSLA", strike: 777, optionType: "CALL", expiryISO: "2026-08-21" }, { yahooGet: async () => YCHAIN });
  assert.equal(miss.premium, null);
});
