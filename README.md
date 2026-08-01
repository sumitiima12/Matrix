# Matrix One — Backend

The API server behind **Matrix One**, a mobile-first trading app covering Indian equities/F&O, US stocks, crypto, and commodities. It powers live quotes, charts, news, AI research ("Neo"), paper (virtual) trading, and **real** order execution across a dozen brokers — plus the automation engines that run strategies and screeners unattended.

This is a single Node/Express service (`server.js`) backed by PostgreSQL, deployed on Render.

> ⚠️ **Real money.** This service can place live orders on connected broker accounts. Read the [Safety & real-order model](#safety--real-order-model) section before touching the auto-buy / auto-exit engines or the broker order route.

---

## Stack

- **Runtime:** Node.js ≥ 18, CommonJS
- **Web:** Express 4, `compression`, `cors`, `express-rate-limit`
- **DB:** PostgreSQL via `pg` (connection pool)
- **HTTP client:** `undici` (needed for proxy dispatchers — see [Delta proxy](#delta-outbound-proxy))
- **Auth:** phone + PIN, `bcryptjs` hashes, JWT sessions
- **No build step** — `node server.js` runs it directly.

## Repository layout

```
server.js          Main app: all routes, market-data adapters, broker adapters,
                   automation engines, AI proxy. (Large — the app's core.)
db.js              Postgres access layer: schema, migrations, encrypted stores.
auth.js            JWT sign/verify + PIN hashing helpers.
riskEngine.js      Server-side order risk checks.
strategyEngine.js  Strategy rule evaluation + entry/exit signal detection.
optimizerCore.js   SL/TP + indicator-length grid/coordinate search.
patterns.js        Candlestick / chart-pattern detection.
marketHours.js     Market-open logic per exchange (testable module).
mcxContract.js     MCX commodity contract resolver (near-month, lot sizes).
test/              Node test suites (node --test).
```

## Quick start (local)

```bash
npm install
cp .env.example .env      # then fill in the vars you need (see below)
npm run dev               # node --watch server.js
# or
npm start                 # node server.js
```

Server listens on `PORT` (default 3000). Health check: `GET /api/health`.

Without a `DATABASE_URL` the server falls back to file-backed JSON stores (the `*_FILE` env vars) so it can run locally without Postgres.

## Scripts

| Command        | What it does                          |
|----------------|---------------------------------------|
| `npm start`    | Run the server (`node server.js`)     |
| `npm run dev`  | Run with `--watch` auto-reload        |
| `npm test`     | Run the Node test suites in `test/`   |

---

## Environment variables

Only `DATABASE_URL` (in production) and at least one AI key are strictly required to boot usefully. Everything else gates a specific feature.

### Core

| Var | Purpose |
|-----|---------|
| `PORT` | Listen port (default 3000) |
| `DATABASE_URL` | Postgres connection string. If unset, file-backed JSON stores are used. |
| `DB_CA_CERT` / `DB_SSL_STRICT` | Postgres TLS: CA bundle and strict-verify toggle |
| `JWT_SECRET` | Signing secret for session tokens (**set a strong value**) |
| `CRED_KEY` | AES key used to encrypt broker credentials at rest (**required for real trading**) |
| `CORS_ORIGINS` | Comma-separated allowed origins for the browser app |
| `READ_CACHE_MS` | TTL for the in-process read cache (default 8000) |

### Admin

| Var | Purpose |
|-----|---------|
| `ADMIN_KEY` | Key for admin-only diagnostic/admin routes |
| `ADMIN_USER_IDS` | Comma-separated user IDs granted admin |
| `HOUSE_OWNER_ID` | The owner user id (house FYERS session, owner-only routes) |

### AI providers (Neo) — configure at least one

`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, with optional model overrides `GROQ_MODEL`, `OPENROUTER_MODEL`, `GEMINI_MODEL`. Providers are tried in a fallback chain.

### Market data

| Var | Purpose |
|-----|---------|
| `NEWS_API_KEY` | News feed provider |
| `FMP_API_KEY` | Financial Modeling Prep (fundamentals/earnings) |
| `INDIANAPI_KEY` | Indian market data provider |
| `EQUITY_HOUSE_FEED` / `MCX_HOUSE_FEED` | Use the house broker feed for equities / MCX quotes |
| `MCX_MASTER_URL` | MCX contract master file URL |

### Brokers & real trading

| Var | Purpose |
|-----|---------|
| `BROKER_TRADING_ENABLED` | Master switch for any real broker calls |
| `DELTA_API_KEY` / `DELTA_API_SECRET` | House Delta Exchange keys (crypto) |
| `DELTA_PROXY_URL` (or `DELTA_PROXY`) | **Static-IP proxy for Delta.** See below. |
| `DELTA_TESTNET` / `DELTA_TESTNET_BASE` | Point Delta calls at testnet |
| `FYERS_APP_ID`, `FYERS_SECRET_ID`, `FYERS_REDIRECT_URI` | FYERS app (Indian equities/F&O) |
| `FYERS_FY_ID`, `FYERS_TOTP_SECRET`, `FYERS_PIN` | House FYERS unattended TOTP auto-login |
| `FYERS_ACCESS_TOKEN` / `FYERS_REFRESH_TOKEN` | Seed tokens (optional) |
| `FYERS_PROXY_URL` | Whitelisted-IP proxy for FYERS order traffic |
| `SCHWAB_APP_KEY` / `SCHWAB_APP_SECRET` | Charles Schwab OAuth app (US) |
| `DHAN_PARTNER_ID` / `DHAN_PARTNER_SECRET` | Dhan partner OAuth |
| `BROKER_STATIC_IP` | The IP to display for users to whitelist (else derived from proxy URL) |

### Automation engines

| Var | Purpose |
|-----|---------|
| `AUTO_BUY_LIVE` | If true, the auto-buy engine places **real** entry orders (else dry-run) |
| `AUTO_BUY_MS` | Auto-buy poll interval |
| `AUTO_BUY_MAX_POSITIONS` | Cap on concurrent auto-buy positions (default effectively unlimited) |
| `AUTO_BUY_MAX_NOTIONAL` | Per-order notional cap |
| `AUTO_BUY_RECONCILE_MS` | Interval to reconcile pending intents against fills |
| `AUTO_EXIT_LIVE` / `AUTO_EXIT_MS` | Real exit executor toggle + interval |
| `EXIT_MONITOR` / `EXIT_MONITOR_MS` | SL/TP monitor toggle + interval |

### File-store fallbacks (used only when `DATABASE_URL` is unset)

`STATE_FILE`, `USERS_FILE`, `TRADES_FILE`, `IDEAS_FILE`, `SCREENERS_FILE`, `PUBLIC_STRATS_FILE`, `REAL_STRATS_FILE`, `MANAGED_FILE`, `CREDS_FILE`, `BROKER_APPS_FILE`, `APP_SETTINGS_FILE`.

---

## Supported brokers

| Broker | Market | Connect method |
|--------|--------|----------------|
| **FYERS** | Indian equity / F&O | OAuth, or house TOTP auto-login (owner) |
| **Zerodha (Kite)** | Indian equity / F&O | OAuth request-token exchange |
| **Dhan** | Indian equity / F&O | Partner OAuth, or pasted access token |
| **Angel One (SmartAPI)** | Indian equity / F&O | API key + client code + PIN + TOTP |
| **Groww** | Indian equity | Pasted access token |
| **IND Money (INDstocks)** | US stocks | Pasted bearer token |
| **Charles Schwab** | US stocks | OAuth2 authorization-code |
| **Delta Exchange** | Crypto perps | User API key + secret (BYOA) via static-IP proxy |
| **CoinDCX** | Crypto | API key + secret |
| **Binance** | Crypto | API key + secret (may be geo-blocked from server region) |
| **CoinSwitch** | Crypto | API key + secret |

Credentials are AES-encrypted with `CRED_KEY` before storage. Real trading is **bring-your-own-account (BYOA)** for retail users; the house keys are owner-only.

---

## Delta outbound proxy

Delta Exchange whitelists API keys **by source IP**. Render's outbound IP isn't stable/whitelistable, so Delta signed calls are routed through a **static-IP proxy**.

For this deployment the proxy is a self-hosted **Oracle Cloud Always-Free** instance with a **reserved static public IP** — that IP is the one whitelisted on the Delta API key. Point `DELTA_PROXY_URL` at it:

```
DELTA_PROXY_URL=http://<user>:<pass>@<oracle-instance-public-ip>:<port>
```

Credentials in the URL are sent as a `Proxy-Authorization` header via undici's `ProxyAgent`. If the var is unset, Delta calls go out directly.

**Diagnostics:** `GET /api/diag/delta` (admin only) reports the proxy TCP reachability probe, the server's direct vs proxied outbound IP, and whether public + signed Delta calls succeed. Use it when a connect fails.

Signed Delta reads use a **bounded 15s timeout and retry once** on transport failure (cold dyno / briefly-unreachable proxy). Order placement (POST) is **never** retried, to avoid duplicate orders.

---

## Safety & real-order model

- **Dry-run by default.** The auto-buy and auto-exit engines only place real orders when `AUTO_BUY_LIVE` / `AUTO_EXIT_LIVE` are explicitly enabled. Otherwise they simulate.
- **Idempotency.** Auto-buy uses a pending-intent + reconciliation loop so a retry or restart doesn't double-fire an entry.
- **One position per strategy.** A strategy won't open a new position while its previous one is still open.
- **Identity binding.** Financial routes resolve the acting user from the verified JWT, not client-supplied ids.
- **Real mode is PIN-gated** on the client, and credentials are encrypted at rest.

---

## API overview

All under `/api`. Auth via `Authorization: Bearer <jwt>` (and `X-User-Id` where noted). This is a summary, not an exhaustive contract.

**Health/diag:** `GET /api/health`, `/api/feeds-status`, `/api/monitor`, `/api/diag/delta`, `/api/diag/candles`

**Auth & account:** `POST /api/register`, `/api/login`, `/api/pin/verify`, `/api/pin/change`, `GET /api/security-question`, `POST /api/security-question`, `GET /api/forgot/question`, `POST /api/forgot/reset`, `GET /api/username/available`, `POST /api/username`, `POST /api/account/delete`

**Market data:** `GET /api/quote`, `/api/history`, `/api/intraday`, `/api/indicators`, `/api/news`, `/api/news/feed`, `/api/fundamentals`, `/api/earnings`

**AI (Neo):** `POST /api/ask`, `/api/ai/strategy`

**Scanners:** `POST /api/screener-scan`, `/api/momentum-scan`, `/api/pattern-scan`, `/api/idea-scan`

**Optimizers:** `POST /api/optimize-exits`, `/api/optimize-indicators`

**Strategies / screeners / ideas:** `GET|POST /api/screeners`, `GET|POST|DELETE /api/public-strategies`, `GET|POST|DELETE /api/ideas`, `POST /api/ideas/:id/review`

**State / trades:** `GET|POST /api/state`, `GET|POST /api/trades`, `POST /api/trades/clear-virtual`

**Brokers:** `GET /api/broker/status`, `/api/broker/connect-info`, `/api/broker/login-url`, `/api/broker/quotes`, `/api/broker/portfolio`, `/api/broker/optionchain`; `POST /api/broker/app-creds`, `/api/broker/session`, `/api/broker/resume`, `/api/broker/order`, `/api/broker/logout`

**Automation:** `GET /api/autobuy`, `POST /api/autobuy/register|cancel|pause|live|close|update`; `GET /api/autoexit`, `/api/autoexit/status`, `POST /api/autoexit/register|cancel`

**Admin:** `GET /api/admin/check`, `/api/admin/is-admin-user`, `/api/admin/users`, `/api/admin/user`, `/api/admin/pending-users`; `POST /api/admin/approve|block|delete-user|reset-pin|clear-trades|clear-virtual`; `GET|POST /api/app-settings`

---

## Deployment (Render)

Deployed as a Render Web Service running `node server.js`, with a Render PostgreSQL instance (`DATABASE_URL`). Delta traffic egresses via the Oracle Cloud static-IP proxy.

Deploy is git-push based:

```bash
cd ~/Documents/matrix-backend
rm -f .git/index.lock .git/HEAD.lock
git add -A && git commit -m "your message" && \
  (git push || (git pull --no-rebase -X ours --no-edit origin main && git push))
```

Render auto-builds on push to `main`. Confirm the live build via `GET /api/health` (append `?cb=$RANDOM` to bypass any edge cache).

> **Note on the free tier:** a free Render dyno spins down after ~15 min idle. The first request after idle triggers a cold start; the Delta connect retry handles the transient outbound failure this can cause. Moving to a paid instance removes cold starts.

---

## Testing

```bash
npm test      # node --test test/*.cjs
```

Covers `strategyEngine`, patterns/TA, `marketHours`, and `mcxContract`.
