# MatrixOne — Incident Runbook

Operational runbook for the on-call responder. Real money moves through this system, so the priority order is
always: **1) stop new risk, 2) protect open positions, 3) preserve the audit trail, 4) restore service.** Never
skip 1–3 to get to 4 faster.

> Fill in the bracketed placeholders (contacts, dashboard links) before first use.

---

## 0. Contacts & access

| Role | Person | Channel |
|---|---|---|
| Primary on-call | [name] | [phone / Slack] |
| Secondary / escalation | [name] | [phone] |
| Owner (final call) | [name] | [phone] |

**Systems**
- Backend (Render): `matrix-backend-wcev.onrender.com` — dashboard: [Render link]
- Frontend (Vercel): `matrixone.app` — dashboard: [Vercel link]
- Database (Render Postgres): dashboard + PSQL command: [link]
- Admin auth: an admin user's Bearer token **plus** `X-Admin-Key` header (value in Render env `ADMIN_KEY`).
  Admin user-ids are in `ADMIN_USER_IDS`.

**Break-glass:** at least two people must be able to reach Render + the DB. If only one person has access when
this is read, that is itself a SEV2 — fix it before the next incident.

---

## 1. Severity levels

| Sev | Definition | Ack | Update cadence |
|---|---|---|---|
| **SEV1** | Real money at risk *now*: exit engine down, orders firing wrong, positions unprotected, funds/credentials exposed | 5 min | every 30 min |
| **SEV2** | Degraded but contained: one broker down, reconciliation drift, DB slow, readiness failing on one instance | 30 min | every 2 h |
| **SEV3** | Non-urgent: cosmetic, single-user issue, elevated latency within limits | next business day | — |

When unsure, treat as one level higher.

---

## 2. First moves (any SEV1)

1. **Confirm scope.** `GET /api/health` (no auth) and `GET /api/admin/monitoring` (admin) — is it the whole
   backend, one instance, one broker, or one user?
2. **Stop new risk if the cause is unknown.** Real-money entries are gated by the durable entry-halt +
   risk-lock (`automation_flags` in Postgres). To halt a specific user: `POST /api/admin/ops/pause-user`
   (body `{ "userId": "..." }`). If the blast radius is broad or unclear, disable live trading at the source:
   set `TRADING_ENABLED` off (or the live-release flag) in Render env and redeploy — the auto-buy engine
   fails closed when it can't confirm it's allowed.
3. **Record it.** `POST /api/admin/ops/incident-note` to stamp the immutable admin audit trail with what you
   observed and did. Do this as you go, not after.
4. **Do NOT delete anything.** No dropping rows, no clearing idempotency keys, no emptying pending-protection.
   Unresolved orders/fills/risk-locks are the evidence you need to recover correctly.

---

## 3. Playbooks

### 3.1 Exit engine stalled — open positions not being managed
**Detect:** `GET /api/admin/monitoring` shows `_lastEngineTickMs` stale (no recent tick), or users report SL/TP
not firing.
**Diagnose:** Is the whole backend up (`/api/health`)? Is the DB reachable? Did readiness ever complete
(schema init)? Check Render logs for the exit-monitor sweep erroring.
**Mitigate:** If the process is wedged, restart the Render service (it re-arms open positions on boot). If the
DB is the cause, see 3.5. While down, **positions are unprotected** — this is SEV1; if a restart doesn't
immediately resume ticks, consider flattening the most exposed real positions manually via the broker apps and
noting it.
**Verify:** `_lastEngineTickMs` advancing again; `GET /api/admin/ops/overview` shows no growing backlog of
unprotected/pending-protection items.

### 3.2 Order outcome unknown (ambiguous) — account entry-block engaged
**Detect:** a user is blocked from new entries; overview shows an unresolved order intent / unknown outcome.
**This is working as designed** — the account-wide entry block holds until the broker's truth resolves the
order. Do **not** force-unblock.
**Diagnose:** identify the order in `order_attempts` / pending-protection. The reconcile worker polls the broker
on a schedule; confirm it's running (logs).
**Mitigate:** let reconciliation resolve it (succeeded → authoritative row written; rejected/none → cleared). If
it's stuck because the broker API is down, that's the blocker — wait or escalate to the broker. Only lift the
block after broker-confirmed reconciliation, never on assertion.
**Verify:** intent resolved, entry-block cleared automatically, risk ledger matches the fills ledger.

### 3.3 Broker token expired — daily refresh failed
**Detect:** one broker's orders failing auth; per-user token status shows expired.
**Diagnose:** which broker, one user or many? A single user usually means they must re-auth (OAuth). Many users
on one broker means the shared-app/refresh cron failed or the broker rotated something.
**Mitigate:** for one user, prompt re-connect in-app. For a broker-wide failure, check the refresh cron logs;
do NOT paste any user's broker token into chat/logs — if a token leaked, advise the user to rotate it at the
broker. Open positions still exit as long as the token is valid for the exit call; if not, this escalates to
3.1 for those users.
**Verify:** token status healthy; a test read (quote) succeeds for an affected user.

### 3.4 Risk-lock / entry-halt stuck — user can't trade but should be able to
**Detect:** user reports blocked entries; overview shows a durable risk-lock with no matching unresolved order.
**Diagnose:** confirm there is genuinely no pending/unknown order or exposure drift for that user first — the
lock is usually correct.
**Mitigate:** only once reconciliation is clean, `POST /api/admin/ops/resume-user` clears the halt/lock via the
proper path (which reconciles, not just flips a flag). Never edit `automation_flags` by hand.
**Verify:** user can place a virtual then (if intended) real entry; audit note recorded.

### 3.5 Database unreachable / readiness failing
**Detect:** `/api/health` degraded; money routes returning 503; readiness never flips true.
**Diagnose:** Render Postgres status; connection count vs limit (`SELECT count(*) FROM pg_stat_activity;`);
pool exhaustion (`PG_POOL_MAX`). Money routes are *designed* to fail closed here — that's protective, not a
bug to override.
**Mitigate:** if it's connection exhaustion, restart the backend to reset the pool; if it's the DB itself,
that's a Render/DB incident — the app correctly refuses real trading until the store is back. Do not point the
app at a stale/replica DB to "get it up."
**Verify:** health green, readiness true, a read + a write round-trip succeed.

### 3.6 Runaway or clearly-wrong auto-buy
**Detect:** unexpected cluster of entries, wrong symbols/sizes.
**Mitigate (SEV1, act first):** halt broadly — `TRADING_ENABLED` off in Render env + redeploy, and/or
pause-user for the affected accounts. Then use the in-app kill-switch / Exit-all for the affected strategies to
flatten. Capture the offending strategy/signal ids in an incident note before changing anything.
**Verify:** no new entries; exposure matches intent; root-cause the signal before re-enabling.

### 3.7 Reconciliation drift / orphan broker exposure
**Detect:** overview shows exposure at a broker not represented in Matrix, or risk-vs-ledger drift.
**Mitigate:** the account is (or should be) entry-blocked on unknown exposure by default — leave it blocked.
Investigate via the fills ledger and broker statement for that trading day. Resolve by reconciling truth, never
by deleting the drift.
**Verify:** drift reconciled to zero; block lifts via broker-truth.

---

## 4. Escalation & comms

- **Escalate to secondary** if not mitigated within the ack window, or immediately for funds/credential
  exposure.
- **Escalate to owner** for anything touching real money that you can't confidently reverse.
- **User comms:** if real trades were affected, notify affected users factually (what happened, what you did,
  what they should check) — the app's notices/push channel can carry this. Don't speculate on cause before the
  postmortem.

## 5. After every SEV1/SEV2

Write a short postmortem within 48h: timeline, impact (which users / how much money), root cause, what stopped
it, and the one change that prevents recurrence. File the follow-up as a task. Blameless — the goal is the fix,
not fault.
