/* Hermetic FAKE DELTA HTTP server for the /api/broker/order Delta (crypto) route journey — the H07 per-broker
   certification harness, mirroring fakeFyers.cjs. It implements the exact endpoints the production Delta path calls:
     • GET  /v2/products            — product lookup (order needs product_id + contract_value)
     • GET  /v2/wallet/balances     — funds for the server-side risk snapshot
     • GET  /v2/positions/margined  — open positions for the risk snapshot + reconcile
     • POST /v2/orders              — order placement (fill / partial / reject controllable)
     • POST /v2/orders/bracket      — exchange-side SL/TP (best-effort)
   Recovery (C03-for-Delta) additions — the durable-attempt PROBE reads these to resolve an ambiguous/lost order from
   broker truth (by our client_order_id tag), mirroring the FYERS orders/tradebook/positions probe:
     • GET  /v2/orders              — LIVE/open orders (optionally filtered by client_order_id / state)
     • GET  /v2/orders/history      — ALL orders incl. filled/closed/rejected (a filled order left the open book)
     • GET  /v2/fills               — executions (order_id + client_order_id + size + price)
   Fault injection for recovery proofs:
     • lostResponse — POST /v2/orders records the order + fill + position (the broker GOT it) but DROPS the HTTP
       response (socket destroyed), so the caller's fetch throws → the durable attempt is left UNKNOWN → the startup
       reconciler must find the fill via the probe and adopt it EXACTLY ONCE, without re-sending.
   Server.js is pointed here via DELTA_API_BASE. Auth/signature headers are ignored. Every request is recorded. */
const http = require("http");

function makeFakeDelta() {
  const state = {
    mode: "fill",            // fill | partial | reject
    failWallet: false,       // when true, /v2/wallet/balances returns 500 (simulated exposure-read outage)
    lostResponse: false,     // when true, POST /v2/orders fills server-side but DROPS the response (ambiguous submit)
    requests: [],
    placeCount: 0,
    bracketCount: 0,
    fillPrice: 100,
    wallet: 1_000_000,       // available balance returned by /v2/wallet/balances
    products: [{ id: 27, symbol: "BTCUSD", contract_value: "1", contract_type: "perpetual_futures" }],
    positions: [],           // { size, product_symbol, entry_price, mark_price }
    orders: new Map(),       // client_order_id -> order record
    ordersById: new Map(),   // numeric id -> order record (both live + historical)
    fills: [],               // { id, order_id, client_order_id, size, price, side, product_symbol, created_at }
  };
  let seq = 900000, fillSeq = 500000;

  const readBody = (req) => new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });

  // Record a fill + reflect it as an open position (the shape the probe + risk snapshot read).
  function bookFill(o, filled, productSymbol) {
    if (filled <= 0) return;
    state.fills.push({ id: ++fillSeq, order_id: o.id, client_order_id: o.client_order_id, size: filled, price: String(state.fillPrice), side: o.side, product_symbol: productSymbol, created_at: new Date().toISOString() });
    state.positions.push({ size: o.side === "buy" ? filled : -filled, product_symbol: productSymbol, entry_price: String(state.fillPrice), mark_price: String(state.fillPrice) });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const coid = u.searchParams.get("client_order_id");

    if (req.method === "GET" && path === "/v2/products") {
      state.requests.push({ method: "GET", path });
      return send(200, { success: true, result: state.products });
    }
    if (req.method === "GET" && path === "/v2/wallet/balances") {
      state.requests.push({ method: "GET", path });
      if (state.failWallet) return send(500, { success: false, error: "simulated broker outage" });
      return send(200, { success: true, result: [{ asset_symbol: "USD", available_balance: String(state.wallet), balance: String(state.wallet) }] });
    }
    if (req.method === "GET" && path === "/v2/positions/margined") {
      state.requests.push({ method: "GET", path });
      return send(200, { success: true, result: state.positions });
    }
    // RECOVERY PROBE READS -----------------------------------------------------------------------------------------
    if (req.method === "GET" && path === "/v2/orders") {
      state.requests.push({ method: "GET", path, coid });
      // "Live" orders = still open/pending. A filled/closed/rejected order has LEFT the open book (must be found in history).
      let live = [...state.orders.values()].filter((o) => o.state === "open" || o.state === "pending");
      if (coid) live = live.filter((o) => String(o.client_order_id) === String(coid));
      return send(200, { success: true, result: live });
    }
    if (req.method === "GET" && path === "/v2/orders/history") {
      state.requests.push({ method: "GET", path, coid });
      let all = [...state.orders.values()];
      if (coid) all = all.filter((o) => String(o.client_order_id) === String(coid));
      return send(200, { success: true, result: all });
    }
    if (req.method === "GET" && path === "/v2/fills") {
      state.requests.push({ method: "GET", path, coid });
      let f = state.fills;
      if (coid) f = f.filter((x) => String(x.client_order_id) === String(coid));
      return send(200, { success: true, result: f });
    }
    // --------------------------------------------------------------------------------------------------------------
    if (req.method === "POST" && path === "/v2/orders/bracket") {
      const body = await readBody(req);
      state.requests.push({ method: "POST", path, body });
      state.bracketCount++;
      return send(200, { success: true, result: { id: ++seq, ...body } });
    }
    if (req.method === "POST" && path === "/v2/orders") {
      const body = await readBody(req);
      state.requests.push({ method: "POST", path, body });
      state.placeCount++;
      const size = Number(body.size) || 0;
      const id = ++seq;
      const productSymbol = (state.products.find((p) => p.id === body.product_id) || {}).symbol || "BTCUSD";
      if (state.mode === "reject") {
        const o = { id, size, unfilled_size: size, state: "rejected", average_fill_price: null, client_order_id: body.client_order_id, side: body.side, cancellation_reason: "insufficient_margin" };
        state.orders.set(String(body.client_order_id || id), o); state.ordersById.set(id, o);
        return send(200, { success: true, result: o });
      }
      const filled = state.mode === "partial" ? Math.max(1, Math.floor(size / 2)) : size;
      const o = {
        id, size, unfilled_size: size - filled,
        state: filled >= size ? "closed" : "open",
        average_fill_price: String(state.fillPrice), client_order_id: body.client_order_id, side: body.side, product_symbol: productSymbol,
      };
      state.orders.set(String(body.client_order_id || id), o); state.ordersById.set(id, o);
      bookFill(o, filled, productSymbol);
      /* LOST RESPONSE: the broker received + filled the order, but the caller never gets the reply (timeout / dropped
         connection). Destroy the socket AFTER booking the fill, so the app's fetch rejects → the durable attempt stays
         UNKNOWN and the reconciler must adopt the real fill from the probe. */
      if (state.lostResponse) { try { req.destroy(); } catch { /* ignore */ } try { res.destroy(); } catch { /* ignore */ } return; }
      return send(200, { success: true, result: o });
    }
    // Any other Delta endpoint → benign empty ok so unrelated calls never throw.
    state.requests.push({ method: req.method, path });
    return send(200, { success: true, result: [] });
  });

  return {
    state,
    async listen() { await new Promise((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; },
    async close() { await new Promise((r) => server.close(r)); },
    setMode(m, opts = {}) { state.mode = m; if (opts.fillPrice != null) state.fillPrice = opts.fillPrice; if (opts.wallet != null) state.wallet = opts.wallet; },
    setLostResponse(v) { state.lostResponse = !!v; },
    placeCount() { return state.placeCount; },
    bracketCount() { return state.bracketCount; },
    fills() { return state.fills.slice(); },
    orderPosts() { return state.requests.filter((r) => r.method === "POST" && r.path === "/v2/orders"); },
    reset() { state.requests.length = 0; state.placeCount = 0; state.bracketCount = 0; state.mode = "fill"; state.failWallet = false; state.lostResponse = false; state.positions.length = 0; state.fills.length = 0; state.orders.clear(); state.ordersById.clear(); },
  };
}

module.exports = { makeFakeDelta };
