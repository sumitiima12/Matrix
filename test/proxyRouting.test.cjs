const test = require("node:test");
const assert = require("node:assert/strict");
const { isProxyBroker, normalizeProxyUrl, makeProxyRouter, PROXY_BROKERS } = require("../proxyRouting");

test("isProxyBroker: only Indian brokers route per-user", () => {
  for (const b of ["fyers", "dhan", "indmoney", "FYERS", "Dhan"]) assert.equal(isProxyBroker(b), true, b);
  for (const b of ["delta", "coindcx", "coinswitch", "binance", "schwab", "zerodha", "", null, undefined]) {
    assert.equal(isProxyBroker(b), false, String(b));
  }
  assert.deepEqual([...PROXY_BROKERS].sort(), ["dhan", "fyers", "indmoney"]);
});

test("normalizeProxyUrl: accepts valid http(s) proxies, rejects junk", () => {
  assert.equal(normalizeProxyUrl("http://1.2.3.4:8080"), "http://1.2.3.4:8080/");
  assert.equal(normalizeProxyUrl("  http://user:pass@1.2.3.4:8080  ").startsWith("http://user:pass@1.2.3.4:8080"), true);
  assert.equal(normalizeProxyUrl("https://proxy.example.com:3128"), "https://proxy.example.com:3128/");
  // rejects
  for (const bad of ["", "   ", null, undefined, "1.2.3.4:8080", "ftp://1.2.3.4", "socks5://1.2.3.4:1080", "not a url", "javascript:alert(1)"]) {
    assert.equal(normalizeProxyUrl(bad), null, JSON.stringify(bad));
  }
});

test("router: returns null for crypto/US brokers regardless of proxy", () => {
  let built = 0;
  const r = makeProxyRouter((url) => { built++; return { url }; });
  assert.equal(r.get("u1", "delta", "http://1.2.3.4:8080"), null);
  assert.equal(r.get("u1", "coindcx", "http://1.2.3.4:8080"), null);
  assert.equal(built, 0, "must not build a dispatcher for non-proxy brokers");
});

test("router: builds a dispatcher for an Indian broker and caches it", () => {
  let built = 0;
  const r = makeProxyRouter((url) => { built++; return { tag: url }; });
  const d1 = r.get("u1", "dhan", "http://1.2.3.4:8080");
  assert.deepEqual(d1, { tag: "http://1.2.3.4:8080/" });
  const d2 = r.get("u1", "dhan", "http://1.2.3.4:8080");
  assert.equal(d1, d2, "same url reuses cached dispatcher");
  assert.equal(built, 1, "must build only once for an unchanged url");
});

test("router: rebuilds when the user's proxy url changes", () => {
  let built = 0;
  const r = makeProxyRouter((url) => { built++; return { tag: url, n: built }; });
  const a = r.get("u1", "fyers", "http://1.1.1.1:8080");
  const b = r.get("u1", "fyers", "http://2.2.2.2:8080");
  assert.notEqual(a, b);
  assert.equal(built, 2, "changed url rebuilds");
});

test("router: per-user AND per-broker isolation (different IPs for FYERS vs Dhan)", () => {
  const r = makeProxyRouter((url) => ({ tag: url }));
  const fy = r.get("u1", "fyers", "http://11.11.11.11:8080");
  const dh = r.get("u1", "dhan", "http://22.22.22.22:8080");
  assert.notDeepEqual(fy, dh);
  // different users, same broker, different proxies
  const u2 = r.get("u2", "dhan", "http://33.33.33.33:8080");
  assert.notDeepEqual(dh, u2);
});

test("router: empty/invalid proxy => null and drops any cached entry", () => {
  const r = makeProxyRouter((url) => ({ tag: url }));
  assert.ok(r.get("u1", "dhan", "http://1.2.3.4:8080"));
  assert.equal(r.size(), 1);
  assert.equal(r.get("u1", "dhan", ""), null, "empty proxy => no dispatcher");
  assert.equal(r.size(), 0, "cache entry dropped when proxy removed");
  assert.equal(r.get("u1", "dhan", "socks5://x"), null, "invalid proxy => null");
});

test("router: invalidate() forces a rebuild", () => {
  let built = 0;
  const r = makeProxyRouter((url) => { built++; return { n: built }; });
  r.get("u1", "dhan", "http://1.2.3.4:8080");
  r.invalidate("u1", "dhan");
  r.get("u1", "dhan", "http://1.2.3.4:8080");
  assert.equal(built, 2);
});
