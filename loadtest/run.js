#!/usr/bin/env node
/**
 * loadtest/run.js — REC-9 HTTP load test. Drives concurrent READ-ONLY traffic at a deployed MatrixOne backend
 * and reports latency percentiles + error rate. Manual ops tool — point it at STAGING, never production with a
 * real user's token. It never hits an order/write endpoint.
 *
 *   BASE_URL=https://... TOKEN=<jwt> CONNS=50 DURATION=20 node loadtest/run.js
 */
"use strict";

const BASE_URL = process.env.BASE_URL;
const TOKEN = process.env.TOKEN || "";
const CONNS = Number(process.env.CONNS) || 50;
const DURATION = Number(process.env.DURATION) || 20;

if (!BASE_URL) { console.error("Set BASE_URL to the target origin (staging)."); process.exit(2); }

let autocannon;
try { autocannon = require("autocannon"); }
catch { console.error("autocannon not installed. Run:  npm i -g autocannon   (or npx autocannon)"); process.exit(2); }

// READ-ONLY endpoints only. Authed ones are included only when a TOKEN is provided.
const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const requests = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/api/broker/capabilities" },
  ...(TOKEN ? [
    { method: "GET", path: "/api/portfolio/risk" },
    { method: "GET", path: "/api/analytics/trades?scope=all" },
    { method: "GET", path: "/api/suitability/questions" },
  ] : []),
];

console.log(`Load test → ${BASE_URL}  (${CONNS} conns, ${DURATION}s, ${requests.length} endpoints, ${TOKEN ? "authed" : "unauthed only"})`);

const instance = autocannon({
  url: BASE_URL,
  connections: CONNS,
  duration: DURATION,
  headers,
  requests,
}, (err, result) => {
  if (err) { console.error("load test error:", err.message); process.exit(1); }
  const nonordinary = (result.non2xx || 0) + (result.errors || 0) + (result.timeouts || 0);
  console.log("\n=== Results ===");
  console.log(`Requests:    ${result.requests.total}  (${result.requests.average}/s avg)`);
  console.log(`Latency ms:  p50 ${result.latency.p50}   p97.5 ${result.latency.p97_5}   p99 ${result.latency.p99}   max ${result.latency.max}`);
  console.log(`Throughput:  ${(result.throughput.average / 1024).toFixed(1)} KB/s avg`);
  console.log(`Non-2xx:     ${result.non2xx || 0}    Errors: ${result.errors || 0}    Timeouts: ${result.timeouts || 0}`);
  // Non-zero exit if the error rate under load is material (>1%), so it can gate a staging check.
  const errRate = result.requests.total ? nonordinary / result.requests.total : 0;
  if (errRate > 0.01) { console.error(`\n⚠ error rate ${(errRate * 100).toFixed(2)}% exceeds 1% — investigate before adding load.`); process.exit(1); }
  console.log("\n✓ error rate within tolerance.");
});

autocannon.track(instance, { renderProgressBar: true });
