# Matrix — live-data backend (starter)

A thin proxy that lets the Matrix app use **real** prices, candles, news, and a
server-side **Ask Matrix**, without exposing API keys in the browser.

## Run locally
```bash
cd matrix-backend
npm init -y
npm i express cors
ANTHROPIC_API_KEY=sk-ant-...  PORT=8787  node server.js
```
Node 18+ (uses global `fetch`). Optional: `NEWS_API_KEY` for NewsAPI; otherwise
Yahoo's search-news fallback is used.

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/quote?symbols=RELIANCE.NS,AAPL` | live price, % change, volume, P/E |
| GET | `/api/history?symbol=RELIANCE.NS&range=6mo&interval=1d` | OHLC candles |
| GET | `/api/news?symbol=RELIANCE.NS` | recent headlines |
| POST | `/api/ask` `{messages, context}` | Ask Matrix (Claude, key stays server-side) |
| GET | `/health` | liveness |

Indian tickers use Yahoo suffixes: NSE `.NS` (e.g. `RELIANCE.NS`), BSE `.BO`.
Crypto: `BTC-USD`. Commodities/futures: `GC=F` (gold), `CL=F` (WTI).

## Turn on live Yahoo prices in the app
The app already has the wiring. In `Matrix.jsx`, set:
```js
const BACKEND_URL = "https://your-matrix-proxy.onrender.com"; // your deployed proxy
```
On load (and every 30s) the app calls `/api/quote` for the whole universe,
maps app tickers → Yahoo tickers, and overlays **real price + % change** onto
every screen. The header badge flips from **SIM** to **LIVE**. With
`BACKEND_URL` empty (e.g. the chat preview), it stays on simulated data.

Ticker mapping is built in: NSE stocks → `RELIANCE.NS`, US → `AAPL`, crypto →
`BTC-USD`, and indexes/commodities via a small table (`NIFTY50 → ^NSEI`,
`BANKNIFTY → ^NSEBANK`, `SENSEX → ^BSESN`, `SPX → ^GSPC`, `GOLD → GC=F`, …).
Charts/technicals stay simulated for now — only the headline price and change
are live. Wire `/api/history` into `<CandleChart/>` next to make charts live too.

**Update:** charts and news are now wired too. Once `BACKEND_URL` is set, the
candle charts (drawer, Ideas, and the detail page) pull real OHLC from
`/api/history` for the selected timeframe (3m/5m/30m/1h/4h/1d → nearest Yahoo
interval), showing a small "● LIVE" tag, and the detail-page News section pulls
real headlines from `/api/news` (Yahoo, or NewsAPI if `NEWS_API_KEY` is set).
Prices refresh every 1 minute.

## Point the app at it (details)
In `Matrix.jsx`, replace the mock dataset with a fetch layer. Minimal example:

```js
const API = "http://localhost:8787";

export async function getQuotes(symbols) {
  const r = await fetch(`${API}/api/quote?symbols=${symbols.join(",")}`);
  return (await r.json()).quotes;
}
export async function getCandles(symbol, range = "6mo", interval = "1d") {
  const r = await fetch(`${API}/api/history?symbol=${symbol}&range=${range}&interval=${interval}`);
  return (await r.json()).candles; // feed straight into <CandleChart/>
}
```

Then in `useMatrixChat`, swap the direct Anthropic call for:
```js
const res = await fetch(`${API}/api/ask`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: next, context: systemContext }),
});
const { text } = await res.json();
```

## Production notes
- **Lock CORS** to your domain: `cors({ origin: "https://yourapp.com" })`.
- Yahoo endpoints are unofficial + rate-limited — fine for a prototype. For
  scale, license **NSE Data**, **Twelve Data**, or **Alpha Vantage** and keep
  these same response shapes so the app doesn't change.
- Add Redis instead of the in-memory cache if you run more than one instance.
- Deploy on Render / Railway / Fly.io. If you later add real broker order
  placement (Zerodha Kite, Upstox, Dhan…), note SEBI's **static-IP requirement
  for API trading from 1 Apr 2026** — use a fixed-IP host.
- Keep the app's "educational / not investment advice" disclaimer.
