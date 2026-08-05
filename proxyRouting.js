"use strict";
/* proxyRouting.js — per-user, per-broker outbound proxy routing for the Indian brokers.
 *
 * WHY: FYERS / Dhan / IND Money reject orders that arrive from a non-whitelisted IP, and FYERS will
 * not let one IP be shared across multiple users. So each user brings their OWN proxy (a VPS or
 * static-IP endpoint they control) and whitelists that proxy's exit IP on their broker API key.
 * When MatrixOne places that user's order it must egress through THAT user's proxy.
 *
 * This module is pure/testable: it validates a user-supplied proxy URL and turns it into a cached
 * undici dispatcher per (user, broker). The actual dispatcher factory (undici ProxyAgent) is injected
 * so this file has no hard dependency on undici and can be unit-tested with a fake factory.
 *
 * Crypto (Delta / CoinDCX) does NOT use per-user proxies — all crypto users share the MatrixOne
 * server/proxy IP — so isProxyBroker() returns false for them and get() yields null (direct call).
 */

// Only these brokers route per-user. Everything else (crypto, US) is null => direct / existing path.
const PROXY_BROKERS = new Set(["fyers", "dhan", "indmoney"]);

function isProxyBroker(broker) {
  return PROXY_BROKERS.has(String(broker || "").toLowerCase());
}

/* Validate + normalize a user-supplied proxy URL.
 * Must be a well-formed http(s):// URL with a host. Credentials (user:pass@) are allowed and are
 * carried by the URL. Returns the normalized string, or null if empty/invalid (so a bad value can
 * never silently route a real order the wrong way — it just falls back to no dispatcher, and the
 * caller decides whether that's allowed). */
function normalizeProxyUrl(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.toString();
}

/* Build a per-(user,broker) dispatcher cache.
 *   makeDispatcher(url) -> dispatcher | null   (inject server.js's makeProxyDispatcher / undici ProxyAgent)
 * get() rebuilds only when the stored URL changes, so a user updating their proxy takes effect without
 * a restart, and an unchanged URL reuses the same pooled dispatcher. */
function makeProxyRouter(makeDispatcher) {
  if (typeof makeDispatcher !== "function") throw new Error("makeProxyRouter requires a makeDispatcher(url) function");
  const cache = new Map(); // key `${userId}::${broker}` -> { url, dispatcher }

  function keyOf(userId, broker) { return `${userId}::${String(broker || "").toLowerCase()}`; }

  function get(userId, broker, proxyUrl) {
    if (!isProxyBroker(broker)) return null;      // crypto/US: never proxied here
    const url = normalizeProxyUrl(proxyUrl);
    const key = keyOf(userId, broker);
    if (!url) { cache.delete(key); return null; } // no/invalid proxy => direct (caller enforces policy)
    const hit = cache.get(key);
    if (hit && hit.url === url) return hit.dispatcher;
    const dispatcher = makeDispatcher(url) || null;
    cache.set(key, { url, dispatcher });
    return dispatcher;
  }

  function invalidate(userId, broker) { cache.delete(keyOf(userId, broker)); }
  function size() { return cache.size; }
  return { get, invalidate, size };
}

module.exports = { PROXY_BROKERS, isProxyBroker, normalizeProxyUrl, makeProxyRouter };
