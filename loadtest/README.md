# Load & resilience testing (REC-9)

Two layers prove MatrixOne holds up for many concurrent users:

## 1. Robustness (runs in CI, no server)

`test/resilience.fuzz.test.cjs` throws ~13,000 randomized + adversarial inputs at every pure decision module
on the money path (portfolio risk, smart score, risk-policy merge, market-data governance, trade analytics,
suitability, incidents) and asserts the contract never breaks: no thrown exception, and no non-finite number
(`NaN`/`Infinity`) ever leaks into a price, size, or risk cap. It already found and fixed three real
`Infinity`-through-a-bare-`> 0`-guard bugs. Run it with the rest of the suite:

    npm test

## 2. HTTP load (run against a deployed URL, not in CI)

`loadtest/run.js` drives concurrent traffic at the read endpoints with [autocannon]. It is a manual/ops tool —
point it at staging, never at production with real user tokens. Read-only endpoints only (it never places
orders).

    # one-time
    npm i -g autocannon        # or: npx autocannon ...

    # run: 50 concurrent connections for 20s against the health + capabilities endpoints
    BASE_URL=https://matrix-backend-wcev.onrender.com \
    TOKEN=<a test user's JWT> \
    node loadtest/run.js

Environment:
- `BASE_URL`   target origin (required)
- `TOKEN`      Bearer token for authed endpoints (optional; unauthed endpoints are hit without it)
- `CONNS`      concurrent connections (default 50)
- `DURATION`   seconds (default 20)

What it exercises (all read-only): `/health`, `/api/broker/capabilities`, `/api/portfolio/risk`,
`/api/analytics/trades`, `/api/suitability/questions`. It reports p50/p97.5/p99 latency, throughput, non-2xx
count and timeouts, so you can watch for tail-latency blowups and error rates as concurrency climbs.

Interpreting results: on the free Render tier a cold instance will show a slow first request; warm it before
measuring. Watch p99 latency and the non-2xx count as you raise `CONNS` — a rising non-2xx count under load is
the signal to add rate-limit headroom, a bigger instance, or caching before onboarding more users.
