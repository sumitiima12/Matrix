"use strict";
/**
 * pinLock.js — per-account brute-force lockout for secrets checked over the network (login PIN, the
 * Real-mode step-up PIN, and the recovery answer). The per-IP rate limiter is dodgeable by rotating
 * IPs and didn't cover the authed step-up at all; this caps attempts per ACCOUNT instead.
 *
 * Factory so server.js and the tests each get an isolated attempt map, and so `now` can be injected
 * to test the lock window deterministically. After `maxFails` wrong tries for one key the key is
 * locked for `lockMs`; a success clears the counter. In-memory by design — a restart just resets the
 * window, which for a brute-force guard is acceptable and never bricks a legitimate account.
 */
function createPinLock({ maxFails = 5, lockMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const fails = new Map();                   // key -> { n, until }
  return {
    /** Is this key currently locked? -> { locked, retrySec? } */
    state(key) {
      const e = fails.get(key);
      if (e && e.until > now()) return { locked: true, retrySec: Math.ceil((e.until - now()) / 1000) };
      return { locked: false };
    },
    /** Record one wrong attempt; trips the lock at maxFails. */
    fail(key) {
      const e = fails.get(key) || { n: 0, until: 0 };
      e.n += 1;
      if (e.n >= maxFails) { e.until = now() + lockMs; e.n = 0; }
      fails.set(key, e);
    },
    /** Clear on success. */
    clear(key) { fails.delete(key); },
  };
}
module.exports = { createPinLock };
