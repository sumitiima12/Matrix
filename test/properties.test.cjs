/* L04 — PROPERTY-BASED tests for the pure money-critical helpers. Rather than a few hand-picked cases, we assert
   INVARIANTS that must hold across hundreds of randomized inputs (a tiny seeded PRNG keeps it deterministic — no
   extra dependency). If any invariant ever breaks, the failing seed/input is printed. */
const test = require("node:test");
const assert = require("node:assert");
const risk = require("../riskEngine");
const guards = require("../signalGuards");
const states = require("../strategyStates");
const reconcile = require("../reconcile");

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function Imul(x, y) { return Math.imul(x, y); }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const N = 400;

test("L04 property — a REDUCE-ONLY order with a positive qty is ALWAYS allowed (never blocked by entry gates)", () => {
  const r = rng(12345);
  for (let i = 0; i < N; i++) {
    const qty = 1 + Math.floor(r() * 1000);
    const order = { sym: "SYM" + Math.floor(r() * 9), side: pick(r, ["BUY", "SELL"]), qty, price: r() < 0.3 ? 0 : r() * 5000, market: pick(r, ["IN", "US", "Crypto"]), reduceOnly: true };
    const account = { wallet: r() * 100, portfolio: [], trades: [{ sym: order.sym, entryAt: Date.now(), market: order.market }], limits: { cooldownMs: 15000, maxTradesPerDay: 1 } };
    const res = risk.validateOrder(order, account);
    assert.equal(res.ok, true, `reduce-only must pass; blocked with ${JSON.stringify(res.reasons)} on ${JSON.stringify(order)}`);
  }
});

test("L04 property — a BUY whose notional exceeds the wallet is ALWAYS blocked (funds invariant)", () => {
  const r = rng(999);
  for (let i = 0; i < N; i++) {
    const price = 1 + r() * 1000, qty = 1 + Math.floor(r() * 100), wallet = Math.floor(r() * (price * qty));   // strictly less than notional
    if (wallet >= price * qty) continue;
    const res = risk.validateOrder({ sym: "X", side: "BUY", qty, price, market: "IN" }, { wallet, portfolio: [], trades: [] });
    assert.equal(res.ok, false, `a BUY of ${price * qty} on a ${wallet} wallet must be blocked`);
    assert.ok(res.reasons.some((x) => /funds/i.test(x)), "the block reason cites funds");
  }
});

test("L04 property — signalIdentity is a deterministic function; version/direction always change it", () => {
  const r = rng(7);
  for (let i = 0; i < N; i++) {
    const base = { userId: "u" + Math.floor(r() * 5), strategyId: "s" + Math.floor(r() * 5), version: 1 + Math.floor(r() * 3), symbol: pick(r, ["SBIN", "BTCUSD", "AAPL"]), timeframe: pick(r, ["1m", "15m", "1h"]), candleTime: 1e12 + Math.floor(r() * 1e9), direction: pick(r, ["long", "short"]) };
    assert.equal(states.signalIdentity(base), states.signalIdentity({ ...base }), "same inputs ⇒ same identity");
    assert.notEqual(states.signalIdentity(base), states.signalIdentity({ ...base, version: base.version + 1 }), "a version bump changes identity");
    assert.notEqual(states.signalIdentity(base), states.signalIdentity({ ...base, direction: base.direction === "long" ? "short" : "long" }), "direction changes identity");
  }
});

test("L04 property — staleSignal is MONOTONE in age (once stale, staying older stays stale)", () => {
  const r = rng(42);
  for (let i = 0; i < N; i++) {
    const now = 1e12 + Math.floor(r() * 1e9), tf = pick(r, ["1m", "5m", "15m", "1h", "1d"]);
    const ageA = Math.floor(r() * 5 * 24 * 3600e3), ageB = ageA + Math.floor(r() * 24 * 3600e3);   // B is older
    const sA = guards.staleSignal(now - ageA, now, tf), sB = guards.staleSignal(now - ageB, now, tf);
    if (sA) assert.equal(sB, true, `if age ${ageA} is stale, the older age ${ageB} must also be stale (${tf})`);
  }
});

test("L04 property — brokerFillTsMs returns null OR a timestamp strictly inside the sanity window", () => {
  const r = rng(2024);
  for (let i = 0; i < N; i++) {
    const now = 1e12 + Math.floor(r() * 1e11), window = 2 * 24 * 3600e3;
    const cand = pick(r, [now - Math.floor(r() * 5 * 24 * 3600e3), Math.floor(r() * now), "garbage", null, String(now)]);
    const out = reconcile.brokerFillTsMs([cand], { now });
    if (out !== null) assert.ok(Math.abs(out - now) <= window, `returned ts ${out} must be within ±${window} of ${now}`);
  }
});

test("L04 property — duplicateOpenSymbol: an OPEN position on (broker,symbol) is always a conflict; none is never", () => {
  const r = rng(88);
  for (let i = 0; i < N; i++) {
    const broker = pick(r, ["delta", "fyers"]), sym = pick(r, ["BTCUSD", "NSE:SBIN-EQ", "ETHUSD"]);
    const held = { status: "open", broker, brokerSym: sym };
    assert.equal(guards.duplicateOpenSymbol([held], broker, sym), true, "an open match is a conflict");
    // Only closed positions ⇒ never a conflict.
    assert.equal(guards.duplicateOpenSymbol([{ ...held, status: "closed" }], broker, sym), false, "a closed position is not a conflict");
    // A different broker is never a conflict for this symbol.
    assert.equal(guards.duplicateOpenSymbol([held], broker === "delta" ? "fyers" : "delta", sym), false, "different broker is not a conflict");
  }
});
