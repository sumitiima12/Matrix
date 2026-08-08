/**
 * alertRules.js — UX-3: pure evaluation for user-created price alerts.
 *
 * A user creates an alert from anywhere there's a symbol (the alert-bell icon): "tell me when BTC goes ABOVE
 * 70000", "when RELIANCE drops BELOW 1200", "when NVDA moves ±3% on the day". This module decides, given an
 * alert and a fresh quote, whether it has FIRED and what to say — kept pure so the trigger logic is unit-tested
 * and identical wherever it's evaluated. The server owns storage + the push dispatch + de-dup.
 *
 * An alert: { id, userId, symbol, market, type, threshold, note?, active, lastFiredAt? }
 *   type ∈ "above" | "below" | "pct_up" | "pct_down"
 *   threshold: a price for above/below; a percentage (e.g. 3 = 3%) for pct_up/pct_down.
 * A quote: { price, chgPct? }  (chgPct = day % change; required for pct_* alerts).
 */

const TYPES = ["above", "below", "pct_up", "pct_down"];

/** Validate + normalize a create request into a stored alert shape (minus id/userId which the server assigns). */
function normalizeAlert(raw = {}) {
  const symbol = String(raw.symbol || "").trim().toUpperCase();
  const market = String(raw.market || "").trim() || "IN";
  const type = TYPES.includes(raw.type) ? raw.type : null;
  const threshold = Number(raw.threshold);
  if (!symbol || !type || !Number.isFinite(threshold) || threshold <= 0) {
    return { ok: false, error: "An alert needs a symbol, a valid type (above/below/pct_up/pct_down), and a positive threshold." };
  }
  const note = String(raw.note || "").trim().slice(0, 200);
  return { ok: true, alert: { symbol, market, type, threshold: +threshold, note, active: true } };
}

/**
 * Has this alert fired against the given quote? Returns { fired, message } (fired=false when not, or when the
 * quote can't evaluate it — never throws). Pure; the caller handles de-dup (don't re-fire the same alert within
 * a cooldown) and re-arming.
 */
function evaluateAlert(alert, quote) {
  if (!alert || alert.active === false || !quote) return { fired: false };
  const price = Number(quote.price);
  if (!(Number.isFinite(price) && price > 0)) return { fired: false };
  const thr = Number(alert.threshold);
  const sym = alert.symbol;
  switch (alert.type) {
    case "above":
      return price >= thr ? { fired: true, message: `${sym} is at ${price} — at/above your alert of ${thr}.` } : { fired: false };
    case "below":
      return price <= thr ? { fired: true, message: `${sym} is at ${price} — at/below your alert of ${thr}.` } : { fired: false };
    case "pct_up": {
      const chg = Number(quote.chgPct);
      if (!Number.isFinite(chg)) return { fired: false };
      return chg >= thr ? { fired: true, message: `${sym} is up ${chg.toFixed(2)}% today — past your +${thr}% alert.` } : { fired: false };
    }
    case "pct_down": {
      const chg = Number(quote.chgPct);
      if (!Number.isFinite(chg)) return { fired: false };
      return chg <= -Math.abs(thr) ? { fired: true, message: `${sym} is down ${chg.toFixed(2)}% today — past your -${Math.abs(thr)}% alert.` } : { fired: false };
    }
    default:
      return { fired: false };
  }
}

/** Should we (re)fire this alert now? De-dup: don't push the same alert more than once per cooldown window. */
function shouldFire(alert, quote, nowMs = Date.now(), cooldownMs = 6 * 60 * 60 * 1000) {
  const res = evaluateAlert(alert, quote);
  if (!res.fired) return { fire: false };
  const last = Number(alert.lastFiredAt) || 0;
  if (last > 0 && nowMs - last < cooldownMs) return { fire: false, message: res.message };   // fired before + still in cooldown
  return { fire: true, message: res.message };
}

module.exports = { TYPES, normalizeAlert, evaluateAlert, shouldFire };
