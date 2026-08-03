/* C03 harness — fake FYERS adapter.
 *
 * A deterministic, in-memory FYERS whose order book, trade book and positions are driven by the test. It
 * models the exact failure modes C03 must survive:
 *   - place() → accepted then FILLED / PARTIAL / REJECTED / still-PENDING, chosen per order via setNextBehavior
 *   - "timeout": the broker RECEIVES and records the order but the response is LOST (throws) — the canonical
 *     "accepted, response lost" case. The order is discoverable later by its orderTag (restart recovery).
 *   - getOrders({tag}) / tradeBook({tag}) / positions() let startup reconciliation find orphaned fills.
 * A shared `faults` registry can additionally fail any broker read to model an unreachable/partial broker.
 *
 * Order status codes mirror FYERS: 1 cancelled, 2 filled, 4 partial, 5 rejected, 6 pending.
 */
const STATUS = { cancelled: 1, filled: 2, partial: 4, rejected: 5, pending: 6 };

function makeFakeFyers({ clock, faults, fillPrice = 100 } = {}) {
  const now = () => (clock ? clock.now() : Date.now());
  const orders = new Map();       // orderId -> order record
  let seq = 1;
  let nextBehavior = "fill";      // fill | partial | reject | pending | timeout

  function setNextBehavior(b) { nextBehavior = b; return api; }

  async function placeOrder({ symbol, side, qty, product, orderTag }) {
    if (faults) faults.gate("fyers.place");
    const id = `FY${String(seq++).padStart(4, "0")}`;
    const base = { id, tag: orderTag || null, symbol, side, qty: Number(qty), product: product || "CNC", createdAt: now() };
    if (nextBehavior === "timeout") {
      // Broker RECEIVED the order (durably recorded here) but the caller's response is lost → recoverable by tag.
      orders.set(id, { ...base, status: "pending", filledQty: 0, avgPrice: null, responseLost: true });
      throw Object.assign(new Error("fyers submit timed out"), { code: "ETIMEDOUT", lostResponse: true });
    }
    let status = "pending", filledQty = 0, avgPrice = null;
    if (nextBehavior === "fill") { status = "filled"; filledQty = Number(qty); avgPrice = fillPrice; }
    else if (nextBehavior === "partial") { status = "partial"; filledQty = Math.max(1, Math.floor(Number(qty) / 2)); avgPrice = fillPrice; }
    else if (nextBehavior === "reject") { status = "rejected"; }
    orders.set(id, { ...base, status, filledQty, avgPrice });
    return { s: "ok", id };
  }

  // Later fill of a still-pending order (delayed fill), by id or tag.
  function settle(idOrTag, { status = "filled", filledQty, avgPrice = fillPrice } = {}) {
    for (const o of orders.values()) {
      if (o.id === idOrTag || o.tag === idOrTag) {
        o.status = status; o.filledQty = filledQty != null ? filledQty : (status === "rejected" ? 0 : o.qty); o.avgPrice = status === "rejected" ? null : avgPrice;
      }
    }
    return api;
  }

  async function getOrders({ id, tag } = {}) {
    if (faults) faults.gate("fyers.orders");
    let list = [...orders.values()];
    if (id) list = list.filter((o) => o.id === id);
    if (tag) list = list.filter((o) => o.tag === tag);
    return { s: "ok", orderBook: list.map((o) => ({ id: o.id, orderTag: o.tag, status: STATUS[o.status] || 6, qty: o.qty, filledQty: o.filledQty, tradedQty: o.filledQty, tradedPrice: o.avgPrice })) };
  }

  async function tradeBook({ tag } = {}) {
    if (faults) faults.gate("fyers.tradebook");
    const fills = [...orders.values()].filter((o) => (o.status === "filled" || o.status === "partial") && (!tag || o.tag === tag))
      .map((o) => ({ orderId: o.id, orderTag: o.tag, symbol: o.symbol, side: o.side, tradedQty: o.filledQty, tradedPrice: o.avgPrice, tradeTime: o.createdAt }));
    return { s: "ok", tradeBook: fills };
  }

  async function positions() {
    if (faults) faults.gate("fyers.positions");
    const bySym = new Map();
    for (const o of orders.values()) if (o.status === "filled" || o.status === "partial") {
      const dir = String(o.side).toUpperCase() === "SELL" ? -1 : 1;
      bySym.set(o.symbol, (bySym.get(o.symbol) || 0) + dir * o.filledQty);
    }
    return { s: "ok", netPositions: [...bySym.entries()].filter(([, q]) => q !== 0).map(([symbol, netQty]) => ({ symbol, netQty })) };
  }

  const api = { placeOrder, getOrders, tradeBook, positions, settle, setNextBehavior, _orders: orders, STATUS };
  return api;
}

module.exports = { makeFakeFyers, STATUS };
