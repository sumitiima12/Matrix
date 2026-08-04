/* Hermetic FAKE FYERS HTTP server for the literal /api/order route tests. It implements the exact endpoints the
   production FYERS code path calls (order placement, funds/positions/holdings for the risk snapshot, order-book
   read for fill verification and the reconcile probe) and RECORDS every request it receives. Behaviour is
   controllable per test: fill / reject / pending / lost-response (socket reset AFTER the broker recorded the
   order, i.e. "sent but response lost") / connection-reset-before-record / delayed-response. Server.js is pointed
   at it via FYERS_API_BASE, so the real fyFetch chokepoint routes every FYERS call here. */
const http = require("http");

function makeFakeFyers() {
  const state = {
    mode: "fill",             // fill | reject | pending | lostResponse | resetBeforeRecord | delay
    delayMs: 0,
    orders: new Map(),        // orderTag -> { id, orderTag, symbol, qty, side, status, filledQty, tradedPrice }
    requests: [],             // every received request { method, path, body }
    placeCount: 0,            // number of ACTUAL order-placement calls that reached the broker
    fillPrice: 100,
    markPrice: 100,           // live mark returned by GET /data/quotes (risk-gate sizing for market orders)
    nextExecutions: null,     // H04: [{qty,price}] to split the NEXT order into multiple executions (else one)
    tradeBook: [],            // H04: per-execution trade lines { orderNumber, tradeNumber, tradePrice, tradedQty, side }
  };
  let seq = 1000, tradeSeq = 5000;

  function readBody(req) {
    return new Promise((resolve) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    });
  }
  function orderBookArray(filterId) {
    const all = [...state.orders.values()].map((o) => ({
      id: o.id, orderTag: o.orderTag, symbol: o.symbol, qty: o.qty, side: o.side,
      status: o.status, filledQty: o.filledQty, tradedPrice: o.tradedPrice,
    }));
    return filterId ? all.filter((o) => String(o.id) === String(filterId)) : all;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    // ---- live quotes (risk-gate mark for a market order with no client price) ------------------------
    // liveMarkForOrder → fyersHouseQuotes hits GET /data/quotes?symbols=NSE:SBIN-EQ,... . Return the
    // configured mark so the server can size real-money risk exactly as it does in production.
    if (req.method === "GET" && path === "/data/quotes") {
      state.requests.push({ method: "GET", path });
      const syms = String(u.searchParams.get("symbols") || "").split(",").filter(Boolean);
      return send(200, { s: "ok", d: syms.map((n) => ({ n, v: { lp: state.markPrice, chp: 0 } })) });
    }

    // ---- account snapshot (risk gate) ---------------------------------------------------------------
    if (req.method === "GET" && path === "/api/v3/funds") { state.requests.push({ method: "GET", path }); return send(200, { s: "ok", fund_limit: [{ title: "Available Balance", equityAmount: 1_000_000 }] }); }
    if (req.method === "GET" && path === "/api/v3/holdings") { state.requests.push({ method: "GET", path }); return send(200, { s: "ok", holdings: [] }); }
    if (req.method === "GET" && path === "/api/v3/positions") { state.requests.push({ method: "GET", path }); return send(200, { s: "ok", netPositions: state.netPositions || [] }); }

    // ---- order-book reads (fill verification + reconcile probe) --------------------------------------
    if (req.method === "GET" && path === "/api/v3/orders") {
      state.requests.push({ method: "GET", path: req.url });
      const id = u.searchParams.get("id");
      return send(200, { s: "ok", orderBook: orderBookArray(id) });
    }

    // ---- tradebook (H04: per-execution fills) --------------------------------------------------------
    if (req.method === "GET" && path === "/api/v3/tradebook") {
      state.requests.push({ method: "GET", path });
      return send(200, { s: "ok", tradeBook: state.tradeBook });
    }

    // ---- order placement ----------------------------------------------------------------------------
    if (req.method === "POST" && path === "/api/v3/orders/sync") {
      const body = await readBody(req);
      state.requests.push({ method: "POST", path, body });
      // Write-before-send probe: let the test inspect durable state AT THE MOMENT the broker receives the order.
      if (typeof state.onPlace === "function") { try { await state.onPlace(body); } catch { /* test hook must never break the fake */ } }
      const tag = body.orderTag;

      if (state.mode === "resetBeforeRecord") {
        // The broker NEVER received/recorded the order (connection died before processing). No order stored.
        req.socket.destroy();
        return;
      }

      // Record the order at the broker (this models "the broker received it").
      state.placeCount++;
      const id = "FY" + (++seq);
      let status = 2, filledQty = Number(body.qty) || 0, tradedPrice = state.fillPrice;
      if (state.mode === "reject") { status = 5; filledQty = 0; tradedPrice = 0; }
      else if (state.mode === "pending") { status = 6; filledQty = 0; tradedPrice = 0; }
      // fill / lostResponse / delay ⇒ status 2 (filled) and held in the book under our tag
      if (tag && !state.orders.has(tag)) state.orders.set(tag, { id, orderTag: tag, symbol: body.symbol, qty: Number(body.qty) || 0, side: body.side, status, filledQty, tradedPrice });
      const stored = state.orders.get(tag) || { id };
      // H04: emit per-execution trade lines for a filled order (default: one execution at fillPrice; a test can
      // set nextExecutions to split the order across multiple prices). Weighted average must equal the order avg.
      if (status === 2 && filledQty > 0) {
        const execs = Array.isArray(state.nextExecutions) && state.nextExecutions.length ? state.nextExecutions : [{ qty: filledQty, price: tradedPrice }];
        for (const e of execs) state.tradeBook.push({ orderNumber: stored.id, tradeNumber: "T" + (++tradeSeq), tradePrice: Number(e.price), tradedQty: Number(e.qty), side: body.side, orderDateTime: null });
        state.nextExecutions = null;   // one-shot
      }

      if (state.mode === "lostResponse") {
        // The broker recorded the order, but the RESPONSE is lost — reset the socket after recording. The client
        // sees a transport error; the order truly exists at the broker under our tag (reconcile will find it).
        req.socket.destroy();
        return;
      }
      if (state.mode === "delay" && state.delayMs > 0) { await new Promise((r) => setTimeout(r, state.delayMs)); }
      if (state.mode === "reject") { return send(200, { s: "error", code: -99, message: "RMS: order rejected — insufficient margin" }); }
      return send(200, { s: "ok", code: 1101, message: "Order submitted", id: stored.id });
    }

    // Any other FYERS endpoint the path might hit → benign empty ok (keeps unrelated calls from throwing).
    state.requests.push({ method: req.method, path });
    return send(200, { s: "ok" });
  });

  return {
    state,
    async listen() { await new Promise((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; },
    async close() { await new Promise((r) => server.close(r)); },
    setMode(m, opts = {}) { state.mode = m; if (opts.delayMs != null) state.delayMs = opts.delayMs; if (opts.fillPrice != null) { state.fillPrice = opts.fillPrice; state.markPrice = opts.fillPrice; } if (opts.markPrice != null) state.markPrice = opts.markPrice; },
    // H04: split the NEXT filled order into these executions (each {qty, price}); one-shot.
    setExecutions(execs) { state.nextExecutions = execs; },
    // R30-C3: seed a tradebook execution WITHOUT any matching current order-book row — models an older executed
    // order that has dropped out of the day's order book but still exists in the tradebook/history.
    seedTrade({ orderNumber, orderTag = null, tradedQty, tradePrice, side = 1 }) {
      state.tradeBook.push({ orderNumber, orderTag, tradeNumber: "T" + (++tradeSeq), tradePrice: Number(tradePrice), tradedQty: Number(tradedQty), side, orderDateTime: null });
    },
    // R30-C3: seed a live position WITHOUT any order/tradebook trace (ambiguous fill → recovery must stay locked).
    seedPosition({ symbol, netQty }) { state.netPositions = state.netPositions || []; state.netPositions.push({ symbol, netQty: Number(netQty) }); },
    // Later flip a stored order's status (models a broker fill that settles after an earlier pending/lost response).
    settle(tag, status = 2, filledQty = null, tradedPrice = null) {
      const o = state.orders.get(tag); if (!o) return;
      o.status = status; if (filledQty != null) o.filledQty = filledQty; if (tradedPrice != null) o.tradedPrice = tradedPrice;
    },
    placeCount() { return state.placeCount; },
    orderPosts() { return state.requests.filter((r) => r.method === "POST" && r.path === "/api/v3/orders/sync"); },
    reset() { state.orders.clear(); state.requests.length = 0; state.placeCount = 0; state.mode = "fill"; state.tradeBook.length = 0; state.nextExecutions = null; state.netPositions = []; },
  };
}

module.exports = { makeFakeFyers };
