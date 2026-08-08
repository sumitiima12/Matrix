# MU-3 … MU-7 — external, legal, deferred & ops actions

MU-1 (DPDP scaffolding) and MU-2 (monitoring plumbing) shipped as code. The rest are **not code** — they need
an external party, legal counsel, an org decision, or a deliberate deferral. This is the actionable scope for
each so they can actually be closed, not silently left open.

## MU-3 — Independent security review / penetration test  *(EXTERNAL — cannot be self-attested)*

A team cannot pen-test itself credibly. Procure a third-party test before real-money multi-user launch.
- **Scope to hand the tester:** the real-money order path (`/api/broker/order`, auto-buy/exit engines),
  auth/session (JWT, PIN, token-version revocation), broker-credential encryption at rest, the admin/RBAC
  surface, and the OAuth redirect binding. Give them a staging instance + a test broker (Delta testnet).
- **Deliverable to require:** a report with CVSS-rated findings and retest of fixes.
- **Cadence:** once pre-launch, then annually or after any major auth/money-path change.
- **Status:** OPEN — needs a vendor engagement. No code can close this.

## MU-4 — SEBI + securities-law advice  *(EXTERNAL / LEGAL — cannot be self-attested)*

MatrixOne places real orders on Indian markets for other people. Whether that requires SEBI registration
(e.g. as an investment adviser, research analyst, or authorised person / algo-provider), and what disclosures
/ risk disclaimers / grievance mechanism the law mandates, is a **question for a securities lawyer** — not an
engineering decision.
- **Questions for counsel:** Does offering automated strategy execution to third parties trigger SEBI IA/RA
  registration? Are the "Smart Auto-Buy" / premium strategy recommendations "advice" under the IA regs? What
  algo-trading / API-based-order approvals apply (exchange algo approval, broker tie-up)? What client
  agreement, risk disclosure and grievance-redressal are mandatory?
- **Status:** OPEN — needs a lawyer. The in-app disclaimers, suitability check (REC-5/MU-1) and grievance path
  (REC-7) are the *technical* hooks counsel's answer will plug into.

## MU-5 — KMS for broker tokens  *(DEFERRED by decision)*

Broker access tokens are currently encrypted at rest with an app-held key. Moving the key into a managed KMS
(envelope encryption, rotation, per-tenant keys) is the hardening step. **You chose to keep this for now.**
- **When to revisit:** before onboarding users at scale, or if a KMS is required by MU-3/MU-4 findings.
- **Status:** DEFERRED (intentional).

## MU-6 — Corporate-actions data feed  *(DEFERRED by decision)*

FIN-3 shipped a conservative *detector* (splits/bonuses vs real drift) that's advisory only. A real corporate-
actions **data feed** (authoritative split/dividend/bonus schedule to auto-adjust positions & backtests) is a
paid data subscription + ingestion pipeline. **You chose to defer it.**
- **Status:** DEFERRED (intentional). The detector flags the need; the feed fills it when prioritized.

## MU-7 — Backups tested + remove single-person prod access  *(OPS/ORG — runbook below)*

Two concrete, closeable actions. The verification script is `scripts/verify-restore.sh`.

### 7a. Test the backup / point-in-time restore (don't assume it works)
Render Postgres provides daily backups + PITR on paid tiers. A backup you've never restored is a hope, not a
backup. **Quarterly**, do a real restore drill:
1. In Render → your Postgres → **Recovery**, restore to a **new** scratch instance at a chosen timestamp (do
   NOT overwrite prod).
2. Point the verifier at the restored copy's connection string and run it:
   ```
   RESTORED_DATABASE_URL='postgres://…scratch…' bash scripts/verify-restore.sh
   ```
   It checks the money-critical tables exist and carry rows (trades, fills, managed_positions, order_attempts,
   broker_connections, users) and that the fills ledger is non-empty — i.e. the restore is actually usable.
3. Record the date + result in the ops log (or an incident note). Delete the scratch instance.
Target: restore verified green, RPO ≤ 24h (or your PITR window), RTO measured.

### 7b. Remove single-person production access (no single point of failure/compromise)
- Add a **second owner/admin** to the Render team and the GitHub repo (break-glass, so one person's loss/lockout
  doesn't strand prod).
- Move deploys behind the **protected deploy job** (already implemented) rather than a personal push; use a
  deploy key/CI identity, not an individual's credentials.
- Rotate any prod secrets currently tied to one person's accounts (broker API keys, VAPID, DB) into the
  team/secret store so they survive that person leaving.
- Turn on 2FA for the Render team, GitHub org, and the domain registrar.
- **Status:** ACTIONABLE now — org steps + the drill above. The script makes 7a repeatable.
