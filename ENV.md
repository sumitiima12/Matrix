# MatrixOne backend — environment variables

Security- and money-relevant settings. Set these in your host's env (Render → Environment). Values are
never committed. Booleans accept `1`/`true`/`yes` (case-insensitive).

## Required

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs session tokens. **Must be ≥32 chars in production** or the server refuses to boot (a weak/rotating secret lets sessions be forged or logs everyone out on each deploy). |
| `DATABASE_URL` | Postgres (Neon) connection string. Without it the app falls back to on-disk JSON (dev only). |

## Live real-money automation (default OFF — dry-run)

| Variable | Default | Purpose |
|---|---|---|
| `AUTO_BUY_LIVE` | off | When on, the auto-buy engine places REAL broker entry orders. Off = logs intended orders only. |
| `AUTO_EXIT_LIVE` | off | When on, the exit engine places REAL reduce-only exits. Off = simulates the close. |
| `ALLOW_INCOMPLETE_HOLIDAY_CALENDAR` | off | **Safety gate.** By default, real IN/F&O/MCX entries FAIL CLOSED because the bundled 2026/2027 holiday lists are high-confidence *subsets*, not verified-complete calendars. Setting this to `1` lets those entries trade on the incomplete list — you accept the risk of trading on an omitted (e.g. lunar) holiday. Prefer loading a complete calendar and marking the year complete in `marketHours.js` instead. |

## OAuth broker-connect hardening

The OAuth login redirect can be allow-listed and bound to the one-time state, so a manipulated or
misconfigured callback can't complete a connect.

| Variable | Default | Purpose |
|---|---|---|
| `OAUTH_REDIRECT_ALLOWLIST` | *(empty = allow any)* | Comma-separated exact callback origins or origin+path prefixes, e.g. `https://app.matrixone.example/oauth`. Matching is exact-origin + path-boundary (no subdomain-prefix bypass). **Set this in production** to your registered broker callback URL(s). |
| `OAUTH_ENFORCE_REDIRECT` | off | When on, the session step REQUIRES the client to echo the redirect that started the login (a mismatch is *always* rejected regardless). Enable this **after** both frontend and backend are deployed with redirect-echo support, so an in-flight old client isn't broken. |
| `OAUTH_REQUIRE_ALLOWLIST` | off | When on, the server **refuses to boot** unless `OAUTH_REDIRECT_ALLOWLIST` is configured — use it in production to guarantee the allow-list is never silently empty. |

**Production checklist:** set `OAUTH_REDIRECT_ALLOWLIST` to your exact broker callback URL(s), then turn on
`OAUTH_ENFORCE_REDIRECT=1` and `OAUTH_REQUIRE_ALLOWLIST=1`. The server logs a warning at boot for any of
these left unset in production.

## Notes

- FYERS shared-app: `FYERS_REDIRECT_URI` pins the callback the server sends to FYERS (it must match the
  app registration exactly). The server returns this canonical redirect to the client so the redirect
  binding check compares like-for-like.
- Delta trades route through a whitelisted static-IP proxy; see the Delta setup notes.
