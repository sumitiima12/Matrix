/**
 * riskEngine.js — server-side order validation for REAL orders.
 *
 * Ported from the frontend services/riskService.js validateOrder (which is pure and
 * synchronous). The frontend copy is a UX affordance; THIS is the real control — it runs
 * on the server before any live broker call, using server-held / broker-fetched account
 * state, never values supplied by the client.
 *
 * Keep the two in sync when limits change. This file is intentionally dependency-free.
 */

const DEFAULT_LIMITS = {
  maxPositionPct: 25,      // max % of that market's equity in a single position
  maxOpenPositions: 15,    // per market
  maxTradesPerDay: 30,     // per market
  maxDailyLossPct: 5,      // stop trading after losing this % of start-of-day equity
  cooldownMs: 60_000,      // min gap between two orders in the same symbol
};

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * Validate an order against account state.
 * @param order   { sym, side:"BUY"|"SELL", qty, price, market }
 * @param account { wallet, portfolio:[{sym,qty,avg,price,market}], trades:[{entryAt,exitAt,pnl,market}], limits? }
 * @returns { ok, reasons:string[], warnings:string[] }
 */
function validateOrder(order, account) {
  const limits = { ...DEFAULT_LIMITS, ...((account && account.limits) || {}) };
  const reasons = [];
  const warnings = [];

  const { sym, side = "BUY", qty, price, market = "IN" } = order || {};
  const { wallet = 0, portfolio = [], trades = [] } = account || {};

  // --- basic sanity ---
  if (!sym) reasons.push("No symbol on the order.");
  if (!qty || qty <= 0 || !Number.isFinite(qty)) reasons.push("Quantity must be a positive number.");
  // Price gates BUYS only — a SELL closes a position you already own.
  if (side === "BUY" && (!price || price <= 0 || !Number.isFinite(price))) reasons.push("No live price available for this order.");
  if (reasons.length) return { ok: false, reasons, warnings };

  const value = qty * price;
  const held = portfolio.find((h) => h.sym === sym);
  const todays = trades.filter((t) => (t.entryAt || 0) >= startOfDay() && (t.market || "IN") === market);
  const openInMarket = portfolio.filter((h) => (h.market || "IN") === market);

  if (side === "BUY") {
    // --- funds ---
    if (value > wallet) reasons.push(`Insufficient funds: order needs ${value.toFixed(2)} but ${wallet.toFixed(2)} is available.`);

    // --- position sizing ---
    const equity = wallet + portfolio.reduce((a, h) => a + (h.qty || 0) * (h.price || h.avg || 0), 0);
    const existing = held ? (held.qty || 0) * price : 0;
    const pct = equity > 0 ? ((value + existing) / equity) * 100 : 100;
    if (pct > limits.maxPositionPct) {
      reasons.push(`Position size ${pct.toFixed(1)}% of ${market} equity exceeds the ${limits.maxPositionPct}% cap.`);
    }

    // --- max open positions ---
    if (!held && openInMarket.length >= limits.maxOpenPositions) {
      reasons.push(`Already holding ${openInMarket.length} positions in ${market} (cap ${limits.maxOpenPositions}).`);
    }
  }

  if (side === "SELL") {
    if (!held || (held.qty || 0) < qty) {
      reasons.push(`Cannot sell ${qty} ${sym} — you hold ${held ? held.qty : 0}.`);
    }
  }

  // --- trade frequency ---
  if (todays.length >= limits.maxTradesPerDay) {
    reasons.push(`Daily trade cap reached for ${market} (${limits.maxTradesPerDay}).`);
  }

  // --- daily loss limit (based on start-of-day equity, not current wallet) ---
  const realisedToday = trades
    .filter((t) => (t.exitAt || 0) >= startOfDay() && (t.market || "IN") === market)
    .reduce((a, t) => a + (t.pnl || 0), 0);
  const startOfDayWallet = wallet - realisedToday;
  const lossCap = -(startOfDayWallet * limits.maxDailyLossPct) / 100;
  if (realisedToday < lossCap) {
    reasons.push(`Daily loss limit hit in ${market} (${realisedToday.toFixed(0)} vs cap ${lossCap.toFixed(0)}).`);
  }

  // --- duplicate / cooldown ---
  const lastSame = trades
    .filter((t) => t.sym === sym && t.entryAt)
    .sort((a, b) => b.entryAt - a.entryAt)[0];
  if (side === "BUY" && lastSame && Date.now() - lastSame.entryAt < limits.cooldownMs) {
    warnings.push(`Bought ${sym} moments ago — cooling down.`);
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

module.exports = { validateOrder, DEFAULT_LIMITS };
