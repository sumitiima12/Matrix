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
| `OAUTH_REDIRECT_ALLOWLIST` | *(required in production)* | Comma-separated exact callback origins or origin+path prefixes, e.g. `https://matrixone.app`. Matching is exact-origin + path-boundary (no subdomain-prefix bypass). **In production the server refuses to boot without this** (see fail-closed note below). |
| `OAUTH_ENFORCE_REDIRECT` | off (**required on in production**) | When on, the session step REQUIRES the client to echo the redirect that started the login (a mismatch is *always* rejected regardless). Safe to enable once both frontend and backend are deployed with redirect-echo support. **In production the server refuses to boot unless this is on.** |
| `OAUTH_ALLOW_INSECURE_REDIRECTS` | off | **Bring-up bypass only.** Set to `1` to let production boot WITHOUT the allow-list / enforcement above (e.g. first deploy before you've configured the callback URL). Do NOT leave this on for a real deployment. |
| `OAUTH_REQUIRE_ALLOWLIST` | off | Legacy switch: hard-fails boot on an empty allow-list even outside production. Redundant with the production fail-closed default; kept for back-compat. |

**Fail-closed default (R8-P1-03):** when `NODE_ENV=production`, the server **refuses to start** unless
`OAUTH_REDIRECT_ALLOWLIST` is set **and** `OAUTH_ENFORCE_REDIRECT=1`. To bring a new production instance up
before the callback URL is finalized, set `OAUTH_ALLOW_INSECURE_REDIRECTS=1` temporarily, then remove it
once the two settings are in place.

**Production checklist:** set `OAUTH_REDIRECT_ALLOWLIST` to your exact broker callback URL (for FYERS this is
your frontend URL, e.g. `https://matrixone.app`), and set `OAUTH_ENFORCE_REDIRECT=1`. Delta Exchange uses
API-key signing (no OAuth redirect), so it needs no allow-list entry.

## Notes

- FYERS shared-app: `FYERS_REDIRECT_URI` pins the callback the server sends to FYERS (it must match the
  app registration exactly). The server returns this canonical redirect to the client so the redirect
  binding check compares like-for-like.
- Delta trades route through a whitelisted static-IP proxy; see the Delta setup notes.
