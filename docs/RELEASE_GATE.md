# MatrixOne real-money release gate

This is the deployment gate for unattended real-money automation. CI green ≠ certified. Three per-SHA evidence
artifacts, plus a MatrixOne-path broker journey, must be present and passing for the **exact deployed commit** before
real-money flags may take effect.

## R38-P3-01 — deployment gate (not just CI)

`REAL_MONEY_RELEASE` is a repository variable and, on its own, is only a CI signal. It must NOT be the sole thing
standing between `main` and live real money. Bind the real-money capability to a **protected GitHub Environment**
(e.g. `production-realmoney`) so deployment — not merely CI — is gated:

1. Create a protected Environment `production-realmoney` with **required reviewers** and a **deployment branch rule**
   limiting it to `main`.
2. Put the real-money secrets/vars (broker prod creds, `REAL_MONEY_RELEASE=1`, `REQUIRE_BROKER_CERT=1`) **in that
   Environment**, not at repo scope, so they are only readable by a job that targets the environment.
3. Add a `deploy` job that `needs: [backend, broker-sandbox]`, sets `environment: production-realmoney`, and refuses to
   run unless the three per-SHA evidence artifacts for `github.sha` exist and report `fail=0`, `skipped=0`, and non-zero
   broker placement/fillVerify/close counts.
4. Require the `backend`, `broker-sandbox`, and frontend `frontend` checks in branch protection for `main`. A cleared or
   missing `REAL_MONEY_RELEASE` then cannot silently downgrade the gate, because the deploy job itself verifies the
   certification artifact for the deploy SHA.

Net effect: real money cannot become effective on a SHA whose certification did not pass, even if someone forgets or
clears a variable.

## Required per-SHA evidence

| Artifact | Must show |
|---|---|
| `backend-evidence-<sha>` | `fail=0`, safety `skipped=0`, all four EOD PG tests + two-instance suites executed |
| `frontend-evidence-<sha>` | Playwright desktop+mobile projects green, zero safety skips |
| `broker-sandbox-evidence-<sha>` | `required=1`, `fyers_creds=1`, `delta_creds=1`, `pass=6`, `fail=0`, `skipped=0`, non-zero placement/fillVerify/close per broker |

## R38-P2-03 — MatrixOne-path broker journey (beyond raw endpoints)

The raw `deltaTestnet.sandbox.cjs` / `fyersSandbox.sandbox.cjs` suites certify broker credentials + broker semantics
(a real fill and a reduce-only close). They do **not** certify MatrixOne's own pipeline. A separate journey
(`test/brokerPipelineE2E.sandbox.cjs`, run with `BROKER_E2E=1`, `DATABASE_URL`, and a complete sandbox credential set)
must drive an order through MatrixOne's authenticated execution boundary against a real broker sandbox and prove:

1. entry via the order route with an idempotency key + a durable order-attempt ledger row;
2. an authoritative fill journaled exactly once from broker truth;
3. managed SL/TP or a managed exit registered and verified;
4. a reduce-only close that leaves the broker flat and projects the local trade closed;
5. local ledger/P&L matching the broker's realized outcome;
6. retry idempotency (replay does not double-submit);
7. lost-response recovery reconciled from broker truth on restart (not re-sent);
8. single-owner behaviour across two app instances (lease/fencing).

Until that journey is wired, `brokerPipelineE2E.sandbox.cjs` **fails loud when enabled** so it can never be mistaken for
certification evidence it has not produced.

## R38-P1-04 — safe certification (host allow-list + guaranteed flatten)

The live broker suites refuse to run unless the resolved base host is on an approved **testnet/UAT allow-list**
(`DELTA_SANDBOX_ALLOWED_HOSTS` / `FYERS_SANDBOX_ALLOWED_HOSTS` may extend it) and never default to a trading endpoint.
Every opened position is wrapped in `try/finally` with a bounded emergency flatten that verifies flat; if flat cannot be
proven the run fails with a `MANUAL INTERVENTION REQUIRED` marker. Use a dedicated isolated sandbox account with strict
broker-side quantity/notional caps (`*_SANDBOX_MAX_SIZE` / `*_SANDBOX_MAX_QTY`).
