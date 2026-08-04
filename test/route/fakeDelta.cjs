/* Hermetic FAKE DELTA HTTP server for the /api/broker/order Delta (crypto) route journey — the H07 per-broker
   certification harness, mirroring fakeFyers.cjs. It implements the exact endpoints the production Delta path calls:
     • GET  /v2/products            — product lookup (order needs product_id + contract_value)
     • GET  /v2/wallet/balances     — funds for the server-side risk snapshot
     • GET  /v2/positions/margined  — open positions for the risk snapshot + reconcile
     • POST /v2/orders              — order placement (fill / partial / reject controllable)
     • POST /v2/orders/bracket      — exchange-side SL/TP (best-effort)
   Server.js is pointed at it via DELTA_API_BASE, so every Delta call routes here. Auth/signature headers are ignored
   (the fake trusts the caller). Every request is recorded; placeCount tracks actual order placements. */
const http = require("http");

function makeFakeDelta() {
  const state = {
    mode: "fill",            // fill | partial | reject
    failWallet: false,       // when true, /v2/wallet/balances returns 500 (simulated exposure-read outage)
    requests: [],
    placeCount: 0,
    bracketCount: 0,
    fillPrice: 100,
    wallet: 1_000_000,       // available balance returned by /v2/wallet/balances
    products: [{ id: 27, symbol: "BTCUSD", contract_value: "1", contract_type: "perpetual_futures" }],
    positions: [],           // { size, product_symbol, entry_price, mark_price }
    orders: new Map(),       // client_order_id -> order record
  };
  let seq = 900000;

  const readBody = (req) => new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname;
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (req.method === "GET" && path === "/v2/products") {
      state.requests.push({ method: "GET", path });
      return send(200, { success: true, result: state.products });
    }
    if (req.method === "GET" && path === "/v2/wallet/balances") {
      state.requests.push({ method: "GET", path });
      // Fault injection: simulate a broker outage on the funds/exposure read so fetchBrokerAccount returns null.
      if (state.failWallet) return send(500, { success: false, error: "simulated broker outage" });
      return send(200, { success: true, result: [{ asset_symbol: "USD", available_balance: String(state.wallet), balance: String(state.wallet) }] });
    }
    if (req.method === "GET" && path === "/v2/positions/margined") {
      state.requests.push({ method: "GET", path });
      return send(200, { success: true, result: state.positions });
    }
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
      if (state.mode === "reject") {
        const o = { id, size, unfilled_size: size, state: "rejected", average_fill_price: null, client_order_id: body.client_order_id, cancellation_reason: "insufficient_margin" };
        state.orders.set(String(body.client_order_id || id), o);
        return send(200, { success: true, result: o });
      }
      const filled = state.mode === "partial" ? Math.max(1, Math.floor(size / 2)) : size;
      const o = {
        id, size, unfilled_size: size - filled,
        state: filled >= size ? "closed" : "open",
        average_fill_price: String(state.fillPrice), client_order_id: body.client_order_id, side: body.side,
      };
      state.orders.set(String(body.client_order_id || id), o);
      // reflect the fill as an open position (for a later reconcile/exit stage)
      if (filled > 0) state.positions.push({ size: body.side === "buy" ? filled : -filled, product_symbol: (state.products.find((p) => p.id === body.product_id) || {}).symbol || "BTCUSD", entry_price: String(state.fillPrice), mark_price: String(state.fillPrice) });
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
    placeCount() { return state.placeCount; },
    bracketCount() { return state.bracketCount; },
    orderPosts() { return state.requests.filter((r) => r.method === "POST" && r.path === "/v2/orders"); },
    reset() { state.requests.length = 0; state.placeCount = 0; state.bracketCount = 0; state.mode = "fill"; state.failWallet = false; state.positions.length = 0; state.orders.clear(); },
  };
}

module.exports = { makeFakeDelta };
