const test = require("node:test");
const assert = require("node:assert/strict");
const OT = require("../orderTypes");

test("normalizeOrderType maps variants + fails safe to MARKET", () => {
  assert.equal(OT.normalizeOrderType("market"), "MARKET");
  assert.equal(OT.normalizeOrderType("MKT"), "MARKET");
  assert.equal(OT.normalizeOrderType(""), "MARKET");
  assert.equal(OT.normalizeOrderType(null), "MARKET");
  assert.equal(OT.normalizeOrderType("weird"), "MARKET");
  assert.equal(OT.normalizeOrderType("limit"), "LIMIT");
  assert.equal(OT.normalizeOrderType("L"), "LIMIT");
  assert.equal(OT.normalizeOrderType("sl"), "SL");
  assert.equal(OT.normalizeOrderType("SL-M"), "SL");
  assert.equal(OT.normalizeOrderType("stop-loss"), "SL");
  assert.equal(OT.normalizeOrderType("sl-l"), "SL-L");
  assert.equal(OT.normalizeOrderType("stop-limit"), "SL-L");
  assert.equal(OT.normalizeOrderType("bracket"), "BRACKET");
  assert.equal(OT.normalizeOrderType("BO"), "BRACKET");
});

test("normalizeProduct maps to INTRADAY|NRML|CNC, unknown → CNC", () => {
  assert.equal(OT.normalizeProduct("MIS"), "INTRADAY");
  assert.equal(OT.normalizeProduct("intraday"), "INTRADAY");
  assert.equal(OT.normalizeProduct("NRML"), "NRML");
  assert.equal(OT.normalizeProduct("MARGIN"), "NRML");
  assert.equal(OT.normalizeProduct("CNC"), "CNC");
  assert.equal(OT.normalizeProduct("DELIVERY"), "CNC");
  assert.equal(OT.normalizeProduct("garbage"), "CNC");
});

test("deadlineType: LIMIT + SL-L wait (limit); MARKET/SL/BRACKET prompt (market)", () => {
  assert.equal(OT.deadlineType("LIMIT"), "limit");
  assert.equal(OT.deadlineType("SL-L"), "limit");
  assert.equal(OT.deadlineType("MARKET"), "market");
  assert.equal(OT.deadlineType("SL"), "market");
  assert.equal(OT.deadlineType("BRACKET"), "market");
});

test("validate: LIMIT needs limitPrice", () => {
  assert.equal(OT.validateOrderIntent({ orderType: "LIMIT", side: "BUY" }).ok, false);
  assert.equal(OT.validateOrderIntent({ orderType: "LIMIT", side: "BUY", limitPrice: 100 }).ok, true);
});

test("validate: SL needs triggerPrice", () => {
  assert.equal(OT.validateOrderIntent({ orderType: "SL", side: "SELL" }).ok, false);
  assert.equal(OT.validateOrderIntent({ orderType: "SL", side: "SELL", triggerPrice: 90 }).ok, true);
});

test("validate: SL-L needs trigger + limit with sane side relationship", () => {
  assert.equal(OT.validateOrderIntent({ orderType: "SL-L", side: "BUY", triggerPrice: 100 }).ok, false); // no limit
  assert.equal(OT.validateOrderIntent({ orderType: "SL-L", side: "BUY", triggerPrice: 100, limitPrice: 99 }).ok, false); // buy limit below trigger
  assert.equal(OT.validateOrderIntent({ orderType: "SL-L", side: "BUY", triggerPrice: 100, limitPrice: 101 }).ok, true);
  assert.equal(OT.validateOrderIntent({ orderType: "SL-L", side: "SELL", triggerPrice: 100, limitPrice: 101 }).ok, false); // sell limit above trigger
  assert.equal(OT.validateOrderIntent({ orderType: "SL-L", side: "SELL", triggerPrice: 100, limitPrice: 99 }).ok, true);
});

test("validate: BRACKET needs at least one protective leg", () => {
  assert.equal(OT.validateOrderIntent({ orderType: "BRACKET", side: "BUY" }).ok, false);
  assert.equal(OT.validateOrderIntent({ orderType: "BRACKET", side: "BUY", target: 5 }).ok, true);
  assert.equal(OT.validateOrderIntent({ orderType: "BRACKET", side: "BUY", stopLoss: 3 }).ok, true);
  assert.equal(OT.validateOrderIntent({ orderType: "BRACKET", side: "BUY", tslPct: 2 }).ok, true);
});

test("validate: trailing stop must be 0<pct<100", () => {
  assert.equal(OT.validateOrderIntent({ orderType: "MARKET", side: "BUY", tslPct: 150 }).ok, false);
  assert.equal(OT.validateOrderIntent({ orderType: "MARKET", side: "BUY", tslPct: 2 }).ok, true);
  assert.equal(OT.validateOrderIntent({ orderType: "MARKET", side: "BUY" }).ok, true); // no tsl is fine
});

test("fyers params: market/limit/SL/SL-L type codes + product mapping", () => {
  assert.deepEqual(OT.buildBrokerOrderParams("fyers", { orderType: "MARKET", product: "MIS" }).fields.type, 2);
  assert.deepEqual(OT.buildBrokerOrderParams("fyers", { orderType: "LIMIT", product: "CNC", limitPrice: 100 }).fields, { type: 1, productType: "CNC", limitPrice: 100, stopPrice: 0 });
  const sl = OT.buildBrokerOrderParams("fyers", { orderType: "SL", product: "NRML", triggerPrice: 95 }).fields;
  assert.equal(sl.type, 3); assert.equal(sl.stopPrice, 95); assert.equal(sl.productType, "MARGIN");
  const sll = OT.buildBrokerOrderParams("fyers", { orderType: "SL-L", product: "MIS", triggerPrice: 95, limitPrice: 96 }).fields;
  assert.equal(sll.type, 4); assert.equal(sll.stopPrice, 95); assert.equal(sll.limitPrice, 96); assert.equal(sll.productType, "INTRADAY");
});

test("zerodha params: SL→SL-M, SL-L→SL, trigger/price present", () => {
  assert.equal(OT.buildBrokerOrderParams("zerodha", { orderType: "SL", triggerPrice: 90 }).fields.order_type, "SL-M");
  const sll = OT.buildBrokerOrderParams("zerodha", { orderType: "SL-L", triggerPrice: 90, limitPrice: 89 }).fields;
  assert.equal(sll.order_type, "SL"); assert.equal(sll.trigger_price, "90"); assert.equal(sll.price, "89");
  assert.equal(OT.buildBrokerOrderParams("zerodha", { orderType: "MARKET", product: "NRML" }).fields.product, "NRML");
});

test("dhan params: STOP_LOSS_MARKET / STOP_LOSS + productType", () => {
  assert.equal(OT.buildBrokerOrderParams("dhan", { orderType: "SL", triggerPrice: 90 }).fields.orderType, "STOP_LOSS_MARKET");
  assert.equal(OT.buildBrokerOrderParams("dhan", { orderType: "SL-L", triggerPrice: 90, limitPrice: 91 }).fields.orderType, "STOP_LOSS");
  assert.equal(OT.buildBrokerOrderParams("dhan", { orderType: "MARKET", product: "CNC" }).fields.productType, "CNC");
});

test("coindcx: standalone stop entry is UNSUPPORTED; bracket is managed; limit native", () => {
  const cdSL = OT.buildBrokerOrderParams("coindcx", { orderType: "SL", triggerPrice: 90 });
  assert.equal(cdSL.unsupported, true);
  const cdBr = OT.buildBrokerOrderParams("coindcx", { orderType: "BRACKET", target: 5 });
  assert.equal(cdBr.managed, true); assert.equal(cdBr.fields.order_type, "market_order"); assert.ok(!cdBr.unsupported);
  const cdLim = OT.buildBrokerOrderParams("coindcx", { orderType: "LIMIT", limitPrice: 100 });
  assert.equal(cdLim.fields.order_type, "limit_order"); assert.equal(cdLim.fields.price_per_unit, 100);
});

test("delta: native stop orders (stop_order_type + stop_price); limit + bracket entry", () => {
  const sl = OT.buildBrokerOrderParams("delta", { orderType: "SL", triggerPrice: 90 }).fields;
  assert.equal(sl.order_type, "market_order"); assert.equal(sl.stop_order_type, "stop_loss_order"); assert.equal(sl.stop_price, "90");
  const sll = OT.buildBrokerOrderParams("delta", { orderType: "SL-L", triggerPrice: 90, limitPrice: 89 }).fields;
  assert.equal(sll.order_type, "limit_order"); assert.equal(sll.limit_price, "89"); assert.equal(sll.stop_price, "90");
  const dl = OT.buildBrokerOrderParams("delta", { orderType: "BRACKET", target: 5 });
  assert.equal(dl.fields.order_type, "market_order"); assert.equal(dl.managed, true);
  const dlLimit = OT.buildBrokerOrderParams("delta", { orderType: "LIMIT", limitPrice: 100 });
  assert.equal(dlLimit.fields.order_type, "limit_order"); assert.equal(dlLimit.fields.limit_price, "100"); assert.equal(dlLimit.managed, false);
});

test("BRACKET resolves to underlying entry type (limit if limitPrice set) + managed flag", () => {
  const mkt = OT.buildBrokerOrderParams("zerodha", { orderType: "BRACKET", target: 5 });
  assert.equal(mkt.fields.order_type, "MARKET"); assert.equal(mkt.managed, true);
  const lim = OT.buildBrokerOrderParams("zerodha", { orderType: "BRACKET", target: 5, limitPrice: 100 });
  assert.equal(lim.fields.order_type, "LIMIT"); assert.equal(lim.fields.price, "100"); assert.equal(lim.managed, true);
});

// ── R41-P1-02/03 — server-enforced broker × order-type capability matrix ────────────────────────────
test("supportedOrderTypes: cancel-capable brokers offer resting types; others are MARKET+BRACKET only", () => {
  // Delta/FYERS/Dhan/INDmoney have a tested cancel adapter → full resting-order support.
  for (const b of ["delta", "fyers", "dhan", "indmoney"]) {
    const s = OT.supportedOrderTypes(b);
    for (const t of ["MARKET", "LIMIT", "SL", "SL-L", "BRACKET"]) assert.ok(s.includes(t), `${b} should support ${t}`);
  }
  // Groww/Zerodha have native LIMIT/SL mapping but NO cancel adapter → resting types withheld.
  for (const b of ["groww", "zerodha"]) {
    const s = OT.supportedOrderTypes(b);
    assert.deepEqual(s.sort(), ["BRACKET", "MARKET"].sort(), `${b} must be MARKET+BRACKET only`);
    for (const t of ["LIMIT", "SL", "SL-L"]) assert.ok(!s.includes(t), `${b} must NOT offer ${t}`);
  }
  // CoinDCX: native market/limit only, no cancel adapter → LIMIT withheld too.
  assert.deepEqual(OT.supportedOrderTypes("coindcx").sort(), ["BRACKET", "MARKET"].sort());
  // Unknown broker → MARKET + BRACKET only, never a fabricated resting type.
  assert.deepEqual(OT.supportedOrderTypes("schwab").sort(), ["BRACKET", "MARKET"].sort());
});

test("validateBrokerOrderType: unsupported combo rejects (never a MARKET fallback)", () => {
  // MARKET is always OK.
  for (const b of ["delta", "groww", "zerodha", "coindcx", "schwab"]) {
    assert.ok(OT.validateBrokerOrderType(b, { orderType: "MARKET" }).ok, `${b} MARKET ok`);
  }
  // Resting types on a non-cancel broker are REJECTED with a reason (not downgraded).
  for (const t of ["LIMIT", "SL", "SL-L"]) {
    const r = OT.validateBrokerOrderType("groww", { orderType: t, limitPrice: 100 });
    assert.equal(r.ok, false, `groww ${t} must reject`);
    assert.match(r.error, /groww/);
  }
  // Same types on a cancel-capable broker are accepted.
  for (const t of ["LIMIT", "SL", "SL-L"]) {
    assert.ok(OT.validateBrokerOrderType("dhan", { orderType: t, limitPrice: 100 }).ok, `dhan ${t} ok`);
  }
});

test("validateBrokerOrderType: bracket entry — market always ok; limit entry needs cancel capability", () => {
  // Market-entry bracket (no limitPrice) is fine on every broker (protection is Matrix-managed reduce-only).
  for (const b of ["groww", "zerodha", "coindcx", "delta"]) {
    assert.ok(OT.validateBrokerOrderType(b, { orderType: "BRACKET" }).ok, `${b} market-entry bracket ok`);
  }
  // Limit-entry bracket needs a cancel adapter.
  assert.equal(OT.validateBrokerOrderType("groww", { orderType: "BRACKET", limitPrice: 100 }).ok, false);
  assert.ok(OT.validateBrokerOrderType("delta", { orderType: "BRACKET", limitPrice: 100 }).ok);
});
