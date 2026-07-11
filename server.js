import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  Search, User, Wallet, Home, Repeat, Lightbulb, Bot, Bolt, Briefcase,
  Star, TrendingUp, TrendingDown, X, ChevronRight, Send, Plus, Trash2,
  ArrowUpRight, ArrowDownRight, Sparkles, SlidersHorizontal, Check,
  Activity, Newspaper, Building2, Filter, Play, Pause, ChevronLeft, Zap, Sun, Moon, Bell, Pencil, Clock, LogIn, LogOut
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, ResponsiveContainer, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine
} from "recharts";

/* ============================== THEME / CSS ============================== */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&family=Nunito:wght@400;500;600;700;800&display=swap');
.theme-dark{
  --bg:#0B0B0D; --surface:#151517; --elev:#1D1D20; --ink:#F4F4F6; --ink-soft:#C2C2C8;
  --muted:#86868E; --line:#28282C; --primary:#E8E8EC; --primary-2:#9A9AA2;
  --primary-soft:rgba(232,232,236,.12); --up:#22C55E; --up-soft:rgba(34,197,94,.14);
  --down:#EF4444; --down-soft:rgba(239,68,68,.14); --gold:#C9C9D0; --gold-soft:rgba(200,200,208,.14);
  --lime:#C9FF3D; --grid:rgba(180,180,190,.10); --back:#08080A; --amber:#F59E0B;
  --shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 24px 56px -22px rgba(0,0,0,.85), 0 8px 20px rgba(0,0,0,.4);
  --glow:0 16px 40px rgba(0,0,0,.5);
  --gold-grad:linear-gradient(120deg,#8A8A92,#D8D8DE 45%,#F4F4F6 55%,#A8A8B0);
  --silver-grad:linear-gradient(135deg,#6E6E78 0%,#C9C9D4 30%,#F4F4F8 50%,#B7B7C2 72%,#6E6E78 100%);
  --card-grad:linear-gradient(160deg,#17171A,#111113);
  --feature-grad:linear-gradient(150deg,#33333a 0%,#232329 42%,#141417 78%,#0d0d10 100%);
  --app-bg:radial-gradient(120% 60% at 50% -10%, #1A1A1D 0%, #0E0E10 50%, #08080A 100%);
  --header-bg:rgba(11,11,13,.72);
  --on-primary:#141416;
}
.theme-light{
  --bg:#F7F7F8; --surface:#FFFFFF; --elev:#FBFBFC; --ink:#141416; --ink-soft:#55555C;
  --muted:#9A9AA2; --line:#ECECEE; --primary:#1A1A1D; --primary-2:#8A8A92;
  --primary-soft:#F1F1F3; --up:#10B981; --up-soft:#E6F7F0;
  --down:#EF4444; --down-soft:#FDECEC; --gold:#6E6E78; --gold-soft:#F1F1F3;
  --lime:#C9FF3D; --grid:rgba(20,20,25,.06); --back:#F1F1F3; --amber:#F59E0B;
  --shadow:0 1px 0 rgba(255,255,255,.9) inset, 0 18px 44px -22px rgba(20,20,30,.16), 0 6px 16px rgba(20,20,30,.05);
  --glow:0 14px 32px rgba(20,20,30,.12);
  --gold-grad:linear-gradient(120deg,#9A9AA2,#C9C9D0 45%,#6E6E78);
  --silver-grad:linear-gradient(135deg,#9A9AA6 0%,#CFCFDA 30%,#FFFFFF 50%,#BFBFCC 72%,#9A9AA6 100%);
  --card-grad:linear-gradient(170deg,#FFFFFF,#FBFBFC);
  --feature-grad:linear-gradient(150deg,#33333a 0%,#232329 42%,#141417 78%,#0d0d10 100%);
  --app-bg:linear-gradient(180deg,#FAFAFB 0%,#F5F5F7 100%);
  --header-bg:rgba(247,247,248,.8);
  --on-primary:#FFFFFF;
  --header-bg:rgba(255,255,255,.78);
}
*{box-sizing:border-box}
.mx{font-family:'Nunito',system-ui,sans-serif;color:var(--ink)}
.disp{font-family:'Quicksand','Nunito',sans-serif;letter-spacing:-.01em}
.mono{font-family:'Nunito',sans-serif;font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1}
.card{background:var(--card-grad);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow)}
.flat{box-shadow:none}
.pill{border-radius:999px}
.hide-scroll::-webkit-scrollbar{display:none}
.hide-scroll{-ms-overflow-style:none;scrollbar-width:none}
.tap{cursor:pointer;transition:transform .12s ease, box-shadow .12s ease, background .15s ease, opacity .15s}
.tap:active{transform:scale(.97)}
.glow{box-shadow:var(--glow)}
.metal{position:relative;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.06), 0 22px 48px -20px rgba(0,0,0,.72)}
.metal::before{content:"";position:absolute;top:0;left:-30%;width:35%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.10) 50%,transparent);transform:skewX(-16deg);pointer-events:none}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.fade{animation:fadeUp .3s ease both}
@keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
.sheet{animation:sheetUp .28s cubic-bezier(.22,1,.36,1) both}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.shine{background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(160,160,170,.55) 50%,rgba(255,255,255,0) 100%);background-size:200% 100%;animation:shimmer 2.6s infinite}
.gradtext{background:linear-gradient(120deg,var(--primary),var(--primary-2));-webkit-background-clip:text;background-clip:text;color:transparent}
.gold-text{background:var(--gold-grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.gold-line{height:1px;background:var(--gold-grad);opacity:.85}
.silver-line{height:1px;background:var(--silver-grad);opacity:.7}
.gold-border{border:1px solid transparent;background:linear-gradient(var(--surface),var(--surface)) padding-box, var(--gold-grad) border-box}
.glass{backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
input,textarea,select{font-family:inherit;color:var(--ink)}
.no-ring:focus{outline:2px solid var(--primary);outline-offset:1px}
input::placeholder,textarea::placeholder{color:var(--muted)}
select option{background:var(--surface);color:var(--ink)}
`;

/* ============================== HELPERS ============================== */
const CUR = { IN: "₹", US: "$", Crypto: "$", Commodity: "$", FNO: "₹" };
const MKT_LABEL = { IN: "🇮🇳 Indian", US: "🇺🇸 US", Crypto: "₿ Crypto", Commodity: "🪙 Commodity", FNO: "⚡ F&O" };
function fmt(n, market = "IN") {
  const c = CUR[market] || "₹";
  if (n == null || isNaN(n)) return c + "0";
  const a = Math.abs(n);
  const digits = a === 0 ? 2 : a < 0.001 ? 8 : a < 1 ? 4 : 2;
  const grouped = Number(n).toLocaleString(market === "IN" ? "en-IN" : "en-US", { maximumFractionDigits: digits });
  return c + grouped;
}
function compact(n) {
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
// Seeded RNG. The first outputs of a raw Lehmer/LCG are strongly correlated with
// the seed (they skew high for typical seeds), so we warm it up before use —
// otherwise anything deciding an outcome on the first draw is badly biased.
function lcg(seed) {
  let s = seed % 2147483647; if (s <= 0) s += 2147483646;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 8; i++) next();   // warm-up
  return next;
}
// Guarded local storage (won't crash if storage is unavailable, e.g. in preview).
function lsGet(k, fb) { try { const v = window.localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function lsSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
function getUserId() { let id = lsGet("mx_uid", null); if (!id) { id = "u_" + Math.random().toString(36).slice(2, 10); lsSet("mx_uid", id); } return id; }
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }
// Day index — everything seeded with this rotates once per day.
const DAY = Math.floor(Date.now() / 864e5);
// Realistic price path: random walk with drift + volatility + occasional gaps,
// scaled so it ends exactly at `base` (today's price). Changes daily via DAY.
function series(sym, base, chg, points = 60) {
  const r = lcg(hash(sym) + DAY * 101 + 7);
  const trend = (chg / 100) / points;              // gentle drift toward today's move
  const regime = (r() - 0.5) * 0.004;              // slow background bias
  const path = [1];
  for (let i = 1; i < points; i++) {
    const vol = 0.012 + r() * 0.016;               // 1.2%–2.8% daily vol
    let ret = trend + regime + (r() - 0.5) * 2 * vol;
    if (r() > 0.95) ret += (r() - 0.5) * 0.07;      // occasional gap/spike
    path.push(path[i - 1] * (1 + ret));
  }
  const k = base / path[points - 1];               // scale so last point = current price
  return path.map((v, i) => ({ i, p: +(v * k).toFixed(2) }));
}
function candles(sym, base, chg, n = 34) {
  const pts = series(sym + "|c", base, chg, n + 1);
  const r = lcg(hash(sym + "cndl") + DAY * 101 + 11);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const o = pts[i - 1].p, c = pts[i].p;
    const top = Math.max(o, c), bot = Math.min(o, c);
    const range = Math.max(top - bot, base * 0.006);
    const hi = top + range * (0.15 + r() * 0.9);
    const lo = bot - range * (0.15 + r() * 0.9);
    out.push({ i, o: +o.toFixed(2), c: +c.toFixed(2), h: +hi.toFixed(2), l: +lo.toFixed(2), v: Math.round((0.5 + r()) * base * 1000) });
  }
  return out;
}
function quarters(sym, base, growth) {
  const r = lcg(hash(sym) + 3);
  const labels = ["Q1'24", "Q2'24", "Q3'24", "Q4'24", "Q1'25", "Q2'25"];
  let v = base;
  return labels.map((q) => {
    v = v * (1 + growth / 100 + (r() - 0.5) * 0.05);
    return { q, v: Math.round(v) };
  });
}
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ============================== DATA ============================== */
function build(sym, name, price, chg, sector, cap, x = {}) {
  // Indicators / volume / fundamentals are NO LONGER generated here.
  // They start as null and get filled with REAL values from /api/indicators.
  // null means "no data yet" — the UI renders "—" instead of inventing a number.
  const verdict = x.verdict ?? null;
  return {
    sym, name, price, chg, sector, cap,
    hasData: false,
    vol: null, avgVol: null,
    rsi: null, sma50: null, sma200: null, ema20: null, ema50: null,
    macd: null, macdSignal: null, macdHist: null,
    atr: null, adx: null, cci: null, stoch: null, vwap: null, bbPctB: null, mfi: null, obv: null,
    high52: null, low52: null, support: null, resistance: null,
    pe: x.pe ?? null, roe: x.roe ?? null,
    revGrowth: x.revG ?? null, ebitdaGrowth: x.ebG ?? null,
    bull: x.bull ?? null, verdict,
    news: x.news || null,
    inst: x.inst || null,
    revBase: x.revBase ?? null,
  };
}

const IN_STOCKS = [
  build("RELIANCE", "Reliance Industries", 2945.6, 1.42, "Energy", "Large", {
  }),
  build("TCS", "Tata Consultancy Services", 4012.3, -0.86, "IT", "Large", {
  }),
  build("HDFCBANK", "HDFC Bank", 1678.9, 0.94, "Banking", "Large", {
  }),
  build("INFY", "Infosys", 1542.0, 2.31, "IT", "Large", {
  }),
  build("TATAMOTORS", "Tata Motors", 982.4, 3.67, "Auto", "Large", {
  }),
  build("ADANIENT", "Adani Enterprises", 3120.0, -2.14, "Infrastructure", "Large", {
  }),
  build("ETERNAL", "Eternal Ltd", 198.7, 4.85, "Consumer Tech", "Mid", {
  }),
  build("DMART", "Avenue Supermarts", 4480.5, -0.42, "Retail", "Large", { ebG: 12.0 }),
  build("BAJFINANCE", "Bajaj Finance", 7210.0, 1.18, "NBFC", "Large", {
  }),
  build("ITC", "ITC", 462.3, 0.31, "FMCG", "Large", { ebG: 6.5 }),
  build("PAYTM", "One97 (Paytm)", 412.9, -3.92, "Fintech", "Mid", {
  }),
  build("IRCTC", "IRCTC", 902.1, 2.04, "Travel", "Mid", { ebG: 15.0 }),
  build("TATAPOWER", "Tata Power", 412.8, 5.21, "Power", "Mid", {
  }),
  build("HAL", "Hindustan Aeronautics", 4890.0, 1.77, "Defence", "Large", {
  }),
  build("NYKAA", "FSN E-Commerce (Nykaa)", 178.4, 1.05, "Consumer Tech", "Mid", { pe: 95 }),
  build("IDEA", "Vodafone Idea", 8.4, -1.18, "Telecom", "Small", {}),
  build("SBIN", "State Bank of India", 842.6, 1.36, "Banking", "Large", {}),
];

/* ---- Broader Indian universe (symbol, name, price, sector, cap) ---- */
const MORE_IN = [
  ["TCS", "Tata Consultancy", 4120, "IT", "Large"],
  ["KOTAKBANK", "Kotak Mahindra Bank", 1795, "Banking", "Large"], ["AXISBANK", "Axis Bank", 1168, "Banking", "Large"],
  ["BAJFINANCE", "Bajaj Finance", 7220, "NBFC", "Large"], ["BHARTIARTL", "Bharti Airtel", 1520, "Telecom", "Large"],
  ["HINDUNILVR", "Hindustan Unilever", 2460, "FMCG", "Large"], ["ITC", "ITC Ltd", 428, "FMCG", "Large"],
  ["ADANIENT", "Adani Enterprises", 2985, "Conglomerate", "Large"], ["ADANIPORTS", "Adani Ports", 1372, "Infrastructure", "Large"],
  ["ASIANPAINT", "Asian Paints", 2905, "Consumer", "Large"], ["TITAN", "Titan Company", 3410, "Consumer", "Large"],
  ["ULTRACEMCO", "UltraTech Cement", 11250, "Cement", "Large"], ["WIPRO", "Wipro", 292, "IT", "Large"],
  ["HCLTECH", "HCL Technologies", 1642, "IT", "Large"], ["TECHM", "Tech Mahindra", 1585, "IT", "Large"],
  ["POWERGRID", "Power Grid Corp", 328, "Utilities", "Large"], ["NTPC", "NTPC Ltd", 368, "Utilities", "Large"],
  ["ONGC", "ONGC", 268, "Energy", "Large"], ["COALINDIA", "Coal India", 462, "Energy", "Large"],
  ["JSWSTEEL", "JSW Steel", 918, "Metals", "Large"], ["TATASTEEL", "Tata Steel", 152, "Metals", "Large"],
  ["HINDALCO", "Hindalco", 648, "Metals", "Large"], ["GRASIM", "Grasim Industries", 2565, "Cement", "Large"],
  ["NESTLEIND", "Nestle India", 2510, "FMCG", "Large"], ["BAJAJFINSV", "Bajaj Finserv", 1642, "NBFC", "Large"],
  ["BAJAJ-AUTO", "Bajaj Auto", 9720, "Auto", "Large"], ["EICHERMOT", "Eicher Motors", 4780, "Auto", "Large"],
  ["HEROMOTOCO", "Hero MotoCorp", 5240, "Auto", "Large"], ["M&M", "Mahindra & Mahindra", 2890, "Auto", "Large"],
  ["DIVISLAB", "Divi's Labs", 5920, "Pharma", "Large"], ["CIPLA", "Cipla", 1502, "Pharma", "Large"],
  ["APOLLOHOSP", "Apollo Hospitals", 6820, "Healthcare", "Large"], ["BRITANNIA", "Britannia", 5180, "FMCG", "Large"],
  ["PIDILITIND", "Pidilite", 2985, "Chemicals", "Mid"], ["DABUR", "Dabur India", 512, "FMCG", "Large"],
  ["GODREJCP", "Godrej Consumer", 1245, "FMCG", "Mid"], ["SIEMENS", "Siemens India", 6980, "Capital Goods", "Large"],
  ["DMART", "Avenue Supermarts", 4620, "Retail", "Large"], ["PNB", "Punjab National Bank", 104, "Banking", "Mid"],
  ["BANKBARODA", "Bank of Baroda", 242, "Banking", "Mid"], ["CANBK", "Canara Bank", 108, "Banking", "Mid"],
  ["INDUSINDBK", "IndusInd Bank", 985, "Banking", "Large"], ["GAIL", "GAIL India", 208, "Energy", "Large"],
  ["IOC", "Indian Oil", 142, "Energy", "Large"], ["BPCL", "Bharat Petroleum", 312, "Energy", "Large"],
  ["VEDL", "Vedanta", 448, "Metals", "Large"], ["DLF", "DLF Ltd", 815, "Realty", "Large"],
  ["PAYTM", "Paytm (One97)", 445, "Fintech", "Mid"],
  ["POLICYBZR", "PB Fintech", 1520, "Fintech", "Mid"], ["IRCTC", "IRCTC", 812, "Travel", "Mid"],
  ["JUBLFOOD", "Jubilant FoodWorks", 645, "Consumer", "Mid"], ["TVSMOTOR", "TVS Motor", 2380, "Auto", "Mid"],
  ["ASHOKLEY", "Ashok Leyland", 228, "Auto", "Mid"], ["BOSCHLTD", "Bosch", 33200, "Auto", "Large"],
  ["CUMMINSIND", "Cummins India", 3620, "Capital Goods", "Mid"], ["ABB", "ABB India", 8120, "Capital Goods", "Large"],
  ["SBILIFE", "SBI Life", 1512, "Insurance", "Large"], ["HDFCLIFE", "HDFC Life", 645, "Insurance", "Large"],
  ["ICICIGI", "ICICI Lombard", 1920, "Insurance", "Mid"], ["ICICIPRULI", "ICICI Pru Life", 685, "Insurance", "Mid"],
  ["SHRIRAMFIN", "Shriram Finance", 3120, "NBFC", "Mid"], ["CHOLAFIN", "Cholamandalam", 1385, "NBFC", "Mid"],
  ["MUTHOOTFIN", "Muthoot Finance", 1985, "NBFC", "Mid"], ["LTIM", "LTIMindtree", 5620, "IT", "Large"],
  ["PERSISTENT", "Persistent Systems", 5880, "IT", "Mid"], ["COFORGE", "Coforge", 8420, "IT", "Mid"],
  ["MPHASIS", "Mphasis", 2985, "IT", "Mid"], ["OFSS", "Oracle Fin Serv", 12200, "IT", "Mid"],
  ["TATACONSUM", "Tata Consumer", 1085, "FMCG", "Large"], ["COLPAL", "Colgate-Palmolive", 3420, "FMCG", "Mid"],
  ["MARICO", "Marico", 685, "FMCG", "Mid"], ["BERGEPAINT", "Berger Paints", 528, "Consumer", "Mid"],
  ["HAVELLS", "Havells India", 1885, "Consumer", "Mid"], ["VOLTAS", "Voltas", 1685, "Consumer", "Mid"],
  ["TORNTPHARM", "Torrent Pharma", 3285, "Pharma", "Mid"], ["LUPIN", "Lupin", 2185, "Pharma", "Mid"],
  ["AUROPHARMA", "Aurobindo Pharma", 1385, "Pharma", "Mid"], ["ALKEM", "Alkem Labs", 5620, "Pharma", "Mid"],
  ["ZYDUSLIFE", "Zydus Lifesciences", 1085, "Pharma", "Mid"], ["MANKIND", "Mankind Pharma", 2385, "Pharma", "Mid"],
  ["INDIGO", "InterGlobe (IndiGo)", 4620, "Aviation", "Large"], ["JINDALSTEL", "Jindal Steel", 985, "Metals", "Mid"],
  ["SAIL", "SAIL", 128, "Metals", "Mid"], ["NMDC", "NMDC", 218, "Metals", "Mid"],
  ["PFC", "Power Finance Corp", 512, "NBFC", "Mid"], ["RECLTD", "REC Ltd", 528, "NBFC", "Mid"],
  ["IRFC", "Indian Rlwy Finance", 158, "NBFC", "Mid"], ["TRENT", "Trent Ltd", 6820, "Retail", "Large"],
  ["ADANIGREEN", "Adani Green", 1085, "Utilities", "Large"], ["ADANIPOWER", "Adani Power", 612, "Utilities", "Large"],
  ["MOTHERSON", "Samvardhana Motherson", 168, "Auto", "Mid"], ["BHEL", "BHEL", 248, "Capital Goods", "Mid"],
];
const MORE_US = [
  ["JPM", "JPMorgan Chase", 212, "Banking", "Large"], ["V", "Visa", 278, "Fintech", "Large"],
  ["MA", "Mastercard", 462, "Fintech", "Large"], ["JNJ", "Johnson & Johnson", 158, "Healthcare", "Large"],
  ["UNH", "UnitedHealth", 512, "Healthcare", "Large"], ["XOM", "Exxon Mobil", 118, "Energy", "Large"],
  ["CVX", "Chevron", 158, "Energy", "Large"], ["WMT", "Walmart", 68, "Retail", "Large"],
  ["PG", "Procter & Gamble", 168, "FMCG", "Large"], ["KO", "Coca-Cola", 62, "FMCG", "Large"],
  ["PEP", "PepsiCo", 172, "FMCG", "Large"], ["COST", "Costco", 872, "Retail", "Large"],
  ["HD", "Home Depot", 362, "Retail", "Large"], ["MCD", "McDonald's", 262, "Consumer", "Large"],
  ["NKE", "Nike", 78, "Consumer", "Large"], ["DIS", "Disney", 98, "Media", "Large"],
  ["NFLX", "Netflix", 685, "Media", "Large"], ["CRM", "Salesforce", 268, "Software", "Large"],
  ["ORCL", "Oracle", 142, "Software", "Large"], ["ADBE", "Adobe", 528, "Software", "Large"],
  ["INTC", "Intel", 32, "Semiconductors", "Large"], ["CSCO", "Cisco", 52, "Tech", "Large"],
  ["QCOM", "Qualcomm", 172, "Semiconductors", "Large"], ["TXN", "Texas Instruments", 198, "Semiconductors", "Large"],
  ["AVGO", "Broadcom", 168, "Semiconductors", "Large"], ["MU", "Micron", 108, "Semiconductors", "Large"],
  ["IBM", "IBM", 192, "Tech", "Large"], ["ACN", "Accenture", 342, "IT Services", "Large"],
  ["ABT", "Abbott Labs", 112, "Healthcare", "Large"], ["PFE", "Pfizer", 28, "Pharma", "Large"],
  ["MRK", "Merck", 122, "Pharma", "Large"], ["LLY", "Eli Lilly", 785, "Pharma", "Large"],
  ["TMO", "Thermo Fisher", 585, "Healthcare", "Large"], ["DHR", "Danaher", 252, "Healthcare", "Large"],
  ["BAC", "Bank of America", 42, "Banking", "Large"], ["WFC", "Wells Fargo", 62, "Banking", "Large"],
  ["GS", "Goldman Sachs", 492, "Banking", "Large"], ["MS", "Morgan Stanley", 102, "Banking", "Large"],
  ["C", "Citigroup", 68, "Banking", "Large"], ["AXP", "American Express", 248, "Fintech", "Large"],
  ["BLK", "BlackRock", 892, "Asset Mgmt", "Large"], ["SCHW", "Charles Schwab", 72, "Fintech", "Large"],
  ["BA", "Boeing", 178, "Aerospace", "Large"], ["CAT", "Caterpillar", 362, "Industrials", "Large"],
  ["GE", "GE Aerospace", 172, "Aerospace", "Large"], ["HON", "Honeywell", 205, "Industrials", "Large"],
  ["UPS", "UPS", 132, "Logistics", "Large"], ["RTX", "RTX Corp", 118, "Aerospace", "Large"],
  ["LMT", "Lockheed Martin", 462, "Defence", "Large"], ["DE", "Deere & Co", 382, "Industrials", "Large"],
  ["UBER", "Uber", 72, "Tech", "Large"], ["ABNB", "Airbnb", 128, "Travel", "Large"],
  ["SHOP", "Shopify", 78, "E-commerce", "Large"], ["SQ", "Block", 68, "Fintech", "Mid"],
  ["PYPL", "PayPal", 68, "Fintech", "Large"], ["SNOW", "Snowflake", 158, "Software", "Mid"],
  ["NET", "Cloudflare", 88, "Software", "Mid"], ["CRWD", "CrowdStrike", 342, "Cybersecurity", "Large"],
  ["ZS", "Zscaler", 192, "Cybersecurity", "Mid"], ["DDOG", "Datadog", 122, "Software", "Mid"],
  ["MDB", "MongoDB", 268, "Software", "Mid"], ["PANW", "Palo Alto Networks", 342, "Cybersecurity", "Large"],
  ["MRVL", "Marvell", 78, "Semiconductors", "Large"], ["SMCI", "Super Micro", 42, "Hardware", "Mid"],
  ["ARM", "ARM Holdings", 138, "Semiconductors", "Large"], ["TSM", "TSMC (ADR)", 178, "Semiconductors", "Large"],
  ["ASML", "ASML (ADR)", 745, "Semiconductors", "Large"], ["SBUX", "Starbucks", 92, "Consumer", "Large"],
  ["CMCSA", "Comcast", 42, "Media", "Large"], ["T", "AT&T", 22, "Telecom", "Large"],
  ["VZ", "Verizon", 42, "Telecom", "Large"], ["TMUS", "T-Mobile", 218, "Telecom", "Large"],
  ["F", "Ford", 12, "Auto", "Large"], ["GM", "General Motors", 48, "Auto", "Large"],
  ["RIVN", "Rivian", 14, "Auto", "Mid"], ["LCID", "Lucid", 3, "Auto", "Mid"],
  ["MMM", "3M", 128, "Industrials", "Large"], ["GILD", "Gilead Sciences", 78, "Pharma", "Large"],
  ["AMGN", "Amgen", 285, "Pharma", "Large"], ["BMY", "Bristol Myers", 52, "Pharma", "Large"],
  ["CVS", "CVS Health", 62, "Healthcare", "Large"], ["LOW", "Lowe's", 245, "Retail", "Large"],
  ["TGT", "Target", 142, "Retail", "Large"], ["BKNG", "Booking Holdings", 3980, "Travel", "Large"],
  ["NOW", "ServiceNow", 872, "Software", "Large"], ["INTU", "Intuit", 645, "Software", "Large"],
  ["AMAT", "Applied Materials", 198, "Semiconductors", "Large"], ["LRCX", "Lam Research", 82, "Semiconductors", "Large"],
  ["KLAC", "KLA Corp", 742, "Semiconductors", "Large"], ["ADI", "Analog Devices", 218, "Semiconductors", "Large"],
  ["MARA", "MARA Holdings", 18, "Crypto Miners", "Mid", { vol: 40 }], ["RIOT", "Riot Platforms", 11, "Crypto Miners", "Mid", { vol: 38 }],
  ["PLUG", "Plug Power", 2.4, "Clean Energy", "Mid", { vol: 45 }], ["BE", "Bloom Energy", 22, "Clean Energy", "Mid", { vol: 20 }],
  ["CVNA", "Carvana", 245, "E-commerce", "Mid", { vol: 22 }], ["HOOD", "Robinhood", 62, "Fintech", "Large", { vol: 48 }],
  ["SNAP", "Snap", 11, "Media", "Mid", { vol: 42 }], ["APLD", "Applied Digital", 9.5, "Data Centers", "Small", { vol: 25 }],
];
const seenIN = new Set(IN_STOCKS.map((s) => s.sym));
const seenUS = new Set(US_STOCKS.map((s) => s.sym));
IN_STOCKS.push(...MORE_IN.filter((a) => !seenIN.has(a[0])).map((a) => build(a[0], a[1], a[2], dchg(a[0]), a[3], a[4] || "Large", a[5] || {})));
US_STOCKS.push(...MORE_US.filter((a) => !seenUS.has(a[0])).map((a) => build(a[0], a[1], a[2], dchg(a[0]), a[3], a[4] || "Large", a[5] || {})));

/* -------- Trim each universe to the requested set -------- */
const trimVol = (arr, n, keepSyms) => {
  const keep = new Set(keepSyms);
  const kept = arr.filter((s) => keep.has(s.sym));
  const rest = arr.filter((s) => !keep.has(s.sym) && s.price > 0.1).sort((a, b) => b.vol - a.vol).slice(0, n);
  const merged = [...kept, ...rest.filter((s) => s.price > 0.1)];
  arr.length = 0; arr.push(...merged);
};
const IN_KEEP = ["NIFTY50", "BANKNIFTY", "SENSEX", "FINNIFTY", "INDIAVIX", "RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "TCS", "INFY", "TATAMOTORS", "TATAPOWER", "LT", "BAJFINANCE", "ADANIENT", "HAL", "BEL", "DIXON", "ITC"];
const US_KEEP = ["SPX", "NDX", "DJI", "VIX", "TSM", "PLTR", "MARA", "COIN", "RIOT", "PLUG", "BE", "INTC", "CVNA", "HOOD", "SHOP", "META", "GOOGL", "AAPL", "AMZN", "SNAP", "APLD", "SMCI", "NVDA"];
trimVol(IN_STOCKS, 50, IN_KEEP);         // top 50 Indian by volume (+ indexes & F&O names)
trimVol(US_STOCKS, 25, US_KEEP);         // top 25 US by volume (+ required names)
trimVol(CRYPTO, 10, ["SPX"]);            // top 10 crypto by volume, price > 0.1
// commodities: only the five requested
const COMMO_KEEP = new Set(["GOLD", "SILVER", "ALUMINIUM", "COPPER", "CRUDE"]);
{ const merged = COMMODITY.filter((s) => COMMO_KEEP.has(s.sym)); COMMODITY.length = 0; COMMODITY.push(...merged); }

const bySym = (arr, syms) => syms.map((s) => arr.find((a) => a.sym === s)).filter(Boolean);
const FNO = bySym(IN_STOCKS, ["NIFTY50", "BANKNIFTY", "FINNIFTY", "RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "TCS", "INFY", "TATAMOTORS", "TATAPOWER", "LT", "BAJFINANCE", "ADANIENT", "HAL", "BEL", "DIXON", "ITC"]);
const UNIVERSE = { IN: IN_STOCKS, US: US_STOCKS, Crypto: CRYPTO, Commodity: COMMODITY, FNO };
const ALL = [...IN_STOCKS, ...US_STOCKS, ...CRYPTO, ...COMMODITY];
function marketOf(sym) {
  if (US_STOCKS.find((s) => s.sym === sym)) return "US";
  if (CRYPTO.find((s) => s.sym === sym)) return "Crypto";
  if (COMMODITY.find((s) => s.sym === sym)) return "Commodity";
  return "IN";
}
// Market hours in IST (regardless of the device's own timezone).
function istParts() {
  const d = new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 5.5 * 3600000);
  return { day: d.getDay(), mins: d.getHours() * 60 + d.getMinutes() };
}
function marketOpen(market) {
  const { day, mins } = istParts();
  const weekday = day >= 1 && day <= 5;
  if (market === "Crypto") return true;                                   // 24×7
  if (market === "US") return weekday && (mins >= 19 * 60 + 30 || mins <= 90);   // 7:30pm–1:30am IST
  if (market === "Commodity") return weekday && mins >= 9 * 60 && mins <= 20 * 60 + 30; // 9:00am–8:30pm
  return weekday && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;          // IN / F&O 9:15am–3:30pm
}
function marketHoursLabel(market) {
  return market === "Crypto" ? "24×7" : market === "US" ? "7:30pm–1:30am IST" : market === "Commodity" ? "9:00am–8:30pm IST" : "9:15am–3:30pm IST";
}
// "World-class technical analyst" scoring on the simulated series: momentum,
// breakouts, reversals off S/R, RSI/MACD confirmation, multi-timeframe bias.
// Detects a varied set of chart patterns and explains WHY each was identified.
/* ============ REAL technical signal — no synthetic series anywhere ============
   Everything below is derived from indicators the backend computed from actual
   daily candles (RSI, MACD, ADX, ATR, EMA/SMA, real support/resistance, real
   volume). If a stock has no real data it simply isn't scored.                 */
function techSignal(s) {
  if (!s || !s.hasData || s.rsi == null || s.sma50 == null) return null;
  const px = s.price;
  const cur = (v) => fmt(v, marketOf(s.sym));
  const sup = s.support, res = s.resistance;
  const atr = s.atr || (px * 0.02);
  const volRatio = s.avgVol ? (s.vol || 0) / s.avgVol : null;   // real relative volume
  const range52 = (s.high52 != null && s.low52 != null && s.high52 > s.low52)
    ? (px - s.low52) / (s.high52 - s.low52) : null;             // where in the 52w range
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  const trendUp = s.sma200 != null ? s.sma50 > s.sma200 : s.price > s.sma50;

  let score = 0, signal = "", why = "", pattern = "flag";

  // ---- price action first (this is what the user actually trades) ----
  if (res != null && px >= res * 0.995) {
    pattern = "breakout"; signal = "Resistance breakout";
    why = `Price is pressing through the ${cur(res)} ceiling that capped it over the last 60 sessions.`;
    score += 3.2;
  } else if (sup != null && (px - sup) / px * 100 < 2.5 && macdBull) {
    pattern = "doubleBottom"; signal = "Bounce off support";
    why = `Price is holding the ${cur(sup)} floor with MACD turning up — buyers defending the level.`;
    score += 2.7;
  } else if (trendUp && macdBull && s.rsi > 50 && s.rsi < 70) {
    pattern = "triangle"; signal = "Trend continuation";
    why = `50-DMA above 200-DMA with MACD above its signal and RSI ${s.rsi} — an intact uptrend, not yet overbought.`;
    score += 2.5;
  } else if (s.rsi < 35) {
    pattern = "cup"; signal = "Oversold";
    why = `RSI at ${s.rsi} is in oversold territory; watch for a reclaim of ${cur(s.sma50)} before acting.`;
    score += 1.6;
  } else if (s.rsi > 72) {
    pattern = "flag"; signal = "Overbought";
    why = `RSI ${s.rsi} is stretched; momentum is strong but entries here carry elevated pullback risk.`;
    score -= 0.4;
  } else {
    signal = trendUp ? "Uptrend" : "Range-bound";
    why = trendUp
      ? `Price is above its 50-DMA (${cur(s.sma50)}) with no extreme reading — a steady uptrend.`
      : `Price is chopping between ${sup != null ? cur(sup) : "support"} and ${res != null ? cur(res) : "resistance"} with no clear edge.`;
    score += trendUp ? 1.2 : 0.2;
  }

  // ---- confirmations from REAL indicators ----
  if (macdBull) score += 0.8;
  if (s.adx != null && s.adx > 25) score += 0.7;                 // genuine trend strength
  if (volRatio != null && volRatio > 1.3) { score += 0.8; why += ` Volume is ${volRatio.toFixed(1)}× its 20-day average, confirming participation.`; }
  if (range52 != null && range52 > 0.85) score += 0.5;           // near 52w highs
  if (s.rsi > 50 && s.rsi < 68) score += 0.5;
  if (s.chg != null) score += Math.max(-1, Math.min(1, s.chg * 0.15));

  // ---- REAL stop / target from support-resistance and ATR ----
  const stop = sup != null && sup < px ? Math.max(sup - 0.25 * atr, px - 3 * atr) : px - 2 * atr;
  const target = res != null && res > px ? res : px + 2.5 * atr;
  const slPct = +(((px - stop) / px) * 100).toFixed(1);
  const tpPct = +(((target - px) / px) * 100).toFixed(1);
  const rr = slPct > 0 ? +(tpPct / slPct).toFixed(1) : null;

  return {
    score: +score.toFixed(2), signal, pattern, why,
    stop: +stop.toFixed(2), target: +target.toFixed(2), slPct, tpPct, rr,
    volRatio: volRatio != null ? +volRatio.toFixed(2) : null,
  };
}

// Ranked picks — only from instruments with REAL data. Refreshed hourly.
function dailyPicks(list) {
  return (list || [])
    .filter((s) => s.hasData && s.rsi != null && s.sma50 != null && s.sector !== "Volatility")
    .map((s) => ({ s, t: techSignal(s) }))
    .filter((x) => x.t && x.t.score > 0)
    .sort((a, b) => b.t.score - a.t.score)
    .map(({ s, t }) => Object.assign(s, {
      pickSignal: t.signal, pickReason: t.why, pickPattern: t.pattern,
      pickStop: t.stop, pickTarget: t.target, pickSlPct: t.slPct, pickTpPct: t.tpPct, pickRR: t.rr,
      pickScore: t.score,
    }));
}

/* ============================== SMALL UI ============================== */
function Change({ v, big }) {
  const up = v >= 0;
  return (
    <span className="mono" style={{ color: up ? "var(--up)" : "var(--down)", fontWeight: 700, fontSize: big ? 15 : 12.5, display: "inline-flex", alignItems: "center", gap: 2 }}>
      {up ? <ArrowUpRight size={big ? 16 : 13} /> : <ArrowDownRight size={big ? 16 : 13} />}
      {up ? "+" : ""}{v.toFixed(2)}%
    </span>
  );
}
function Spark({ data, up }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data.slice(-24)} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
        <defs>
          <linearGradient id={up ? "gu" : "gd"} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? "#0FB97D" : "#FF4D67"} stopOpacity={0.35} />
            <stop offset="100%" stopColor={up ? "#0FB97D" : "#FF4D67"} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Area type="monotone" dataKey="p" stroke={up ? "#0FB97D" : "#FF4D67"} strokeWidth={2} fill={`url(#${up ? "gu" : "gd"})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
// Compact candlestick chart (OHLC) with switchable timeframe, for cards & drawers.
const TF_LIST = ["3m", "5m", "30m", "1h", "4h", "1d"];
const TF_N = { "3m": 40, "5m": 36, "30m": 30, "1h": 28, "4h": 24, "1d": 22 };
function MiniCandles({ sym, price, chg, defaultTf = "1d", height = 130, showTf = true, pattern, staticChart = false }) {
  const [tf, setTf] = useState(defaultTf);
  const [ctype, setCtype] = useState("line");     // default: line chart
  const [liveData, setLiveData] = useState(null);
  useEffect(() => {
    let stop = false; setLiveData(null);
    if (BACKEND_URL) fetchHistory(sym, tf).then((d) => { if (!stop && d && d.length > 4) setLiveData(d.slice(-(TF_N[tf] || 26)).map((c, i) => ({ ...c, i }))); }).catch(() => {});
    return () => { stop = true; };
  }, [sym, tf]);
  const synthetic = useMemo(() => candles(sym + "|" + tf, price, chg, TF_N[tf] || 26), [sym, price, chg, tf]);
  const data = liveData && liveData.length ? liveData : synthetic;
  const W = 340, H = height, padT = 8, padB = 8;
  const min = Math.min(...data.map((d) => d.l)), max = Math.max(...data.map((d) => d.h));
  const span = max - min || 1;
  const yOf = (p) => padT + (max - p) / span * (H - padT - padB);
  const cw = W / data.length;
  const patLabel = pattern && PATTERNS[pattern] ? PATTERNS[pattern].label : pattern;
  const up = data[data.length - 1].c >= data[0].o;
  const lineCol = up ? "var(--up)" : "var(--down)";
  const linePts = data.map((d, k) => `${(k + 0.5) * cw},${yOf(d.c)}`).join(" ");
  const areaPts = `0,${H} ${linePts} ${W},${H}`;
  return (
    <div>
      <div style={{ position: "relative" }}>
        {patLabel && <span className="pill" style={{ position: "absolute", top: 6, left: 6, zIndex: 2, fontSize: 9.5, fontWeight: 800, background: "var(--primary-soft)", color: "var(--primary)", padding: "3px 8px" }}>◫ {patLabel}</span>}
        {liveData && liveData.length ? <span className="pill" style={{ position: "absolute", top: 6, right: 6, zIndex: 2, fontSize: 8, fontWeight: 800, background: "var(--up-soft)", color: "var(--up)", padding: "2px 6px" }}>● LIVE</span> : null}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
          {ctype === "line" ? (
            <>
              <defs><linearGradient id={"mcg" + sym.replace(/\W/g, "") + tf} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={lineCol} stopOpacity="0.22" /><stop offset="100%" stopColor={lineCol} stopOpacity="0" /></linearGradient></defs>
              <polygon points={areaPts} fill={`url(#mcg${sym.replace(/\W/g, "")}${tf})`} />
              <polyline points={linePts} fill="none" stroke={lineCol} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </>
          ) : data.map((d, k) => {
            const x = (k + 0.5) * cw, isUp = d.c >= d.o;
            const col = isUp ? "var(--up)" : "var(--down)";
            const yO = yOf(d.o), yC = yOf(d.c), bw = Math.max(2.5, cw * 0.62);
            return (
              <g key={k}>
                <line x1={x} x2={x} y1={yOf(d.h)} y2={yOf(d.l)} stroke={col} strokeWidth="1" />
                <rect x={x - bw / 2} y={Math.min(yO, yC)} width={bw} height={Math.max(1.5, Math.abs(yC - yO))} fill={col} rx="0.5" />
              </g>
            );
          })}
        </svg>
      </div>
      {!staticChart && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 7 }}>
          {showTf ? (
            <div className="hide-scroll" style={{ display: "flex", gap: 5, overflowX: "auto" }}>
              {TF_LIST.map((x) => (
                <button key={x} onClick={(e) => { e.stopPropagation(); setTf(x); }} className="pill tap" style={{ flex: "0 0 auto", padding: "5px 10px", fontSize: 10.5, fontWeight: 700, border: "1px solid " + (tf === x ? "var(--primary)" : "var(--line)"), background: tf === x ? "var(--primary)" : "var(--surface)", color: tf === x ? "var(--on-primary)" : "var(--ink)" }}>{x}</button>
              ))}
            </div>
          ) : <span />}
          <div className="pill" style={{ display: "inline-flex", flexShrink: 0, background: "var(--elev)", border: "1px solid var(--line)", padding: 2 }}>
            {[["line", "Line"], ["candle", "Candle"]].map(([k, l]) => (
              <button key={k} onClick={(e) => { e.stopPropagation(); setCtype(k); }} className="pill tap" style={{ padding: "4px 9px", fontSize: 9.5, fontWeight: 800, border: "none", background: ctype === k ? "var(--primary)" : "transparent", color: ctype === k ? "var(--on-primary)" : "var(--muted)" }}>{l}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function Gauge({ value, label }) {
  // semicircle 0..100; <40 bear, >64 bull
  const a = Math.PI * (1 - value / 100);
  const cx = 80, cy = 78, R = 64;
  const x = cx + R * Math.cos(a), y = cy - R * Math.sin(a);
  const color = value >= 64 ? "var(--up)" : value <= 40 ? "var(--down)" : "#E8A33D";
  const word = value >= 64 ? "Bullish" : value <= 40 ? "Bearish" : "Neutral";
  return (
    <div style={{ textAlign: "center" }}>
      <svg width="160" height="96" viewBox="0 0 160 96">
        <path d="M16 78 A64 64 0 0 1 144 78" fill="none" stroke="var(--line)" strokeWidth="12" strokeLinecap="round" />
        <path d="M16 78 A64 64 0 0 1 144 78" fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={Math.PI * R} strokeDashoffset={Math.PI * R * (1 - value / 100)} style={{ transition: "stroke-dashoffset .6s ease" }} />
        <line x1={cx} y1={cy} x2={x} y2={y} stroke={color} strokeWidth="3" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="5" fill={color} />
      </svg>
      <div className="disp" style={{ fontWeight: 700, color, marginTop: -8 }}>{word}</div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>{label} · {value}/100</div>
    </div>
  );
}
function VerdictTag({ v, size = 13 }) {
  const map = { Buy: ["var(--up-soft)", "var(--up)"], Sell: ["var(--down-soft)", "var(--down)"], Hold: ["rgba(245,158,66,.16)", "#F59E42"] };
  const [bg, fg] = map[v] || map.Hold;
  return <span className="pill disp" style={{ background: bg, color: fg, fontWeight: 700, fontSize: size, padding: "4px 12px" }}>{v}</span>;
}
function CapTag({ c }) {
  return <span className="pill" style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--muted)", fontSize: 10.5, fontWeight: 600, padding: "2px 8px" }}>{c} Cap</span>;
}
function Pop({ children, style, className, amount = 0.03 }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let raf = 0;
    const update = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      const center = r.top + r.height / 2;
      const dist = Math.min(1, Math.abs(center - vh / 2) / (vh / 2));
      const t = 1 - dist;
      el.style.transform = `scale(${(1 - amount + amount * t * 2).toFixed(3)})`;
      el.style.opacity = (0.62 + 0.38 * t).toFixed(3);
    };
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); cancelAnimationFrame(raf); };
  }, [amount]);
  return <div ref={ref} className={className} style={{ transition: "transform .18s ease, opacity .18s ease", willChange: "transform, opacity", ...style }}>{children}</div>;
}
function Section({ title, icon, right, children }) {
  return (
    <Pop className="fade" style={{ marginTop: 48 }}>
      <div className="mx" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, padding: "0 2px" }}>
        <div className="disp" style={{ fontWeight: 700, fontSize: 18, display: "flex", alignItems: "center", gap: 9 }}>{icon}{title}</div>
        {right}
      </div>
      <div className="gold-line" style={{ width: 44, margin: "0 0 16px 2px", borderRadius: 2 }} />
      {children}
    </Pop>
  );
}

/* ============================== STOCK ROW / CARD ============================== */
function AddBtn({ on, onClick, size = 28 }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} className="tap" title={on ? "In watchlist" : "Add to watchlist"}
      style={{ width: size, height: size, borderRadius: 9, border: "1px solid " + (on ? "var(--primary)" : "var(--line)"), background: on ? "var(--primary)" : "var(--elev)", color: on ? "#fff" : "var(--primary)", display: "grid", placeItems: "center", flex: "0 0 auto" }}>
      {on ? <Check size={Math.round(size * 0.55)} /> : <Plus size={Math.round(size * 0.6)} />}
    </button>
  );
}
// "+" with a watchlist picker — adds to the latest list by default, any list on choice.
function WatchAddButton({ sym, watchlists = [], onAdd, onCreate, size = 30 }) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const inAny = watchlists.some((w) => w.syms.includes(sym));
  return (
    <div style={{ position: "relative", flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((o) => !o)} className="tap" title="Add to watchlist" style={{ width: size, height: size, borderRadius: 9, border: "1px solid " + (inAny ? "var(--primary)" : "var(--line)"), background: inAny ? "var(--primary-soft)" : "var(--surface)", color: inAny ? "var(--primary)" : "var(--muted)", display: "grid", placeItems: "center" }}>{inAny ? <Check size={16} /> : <Plus size={17} />}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 39 }} />
          <div className="card" style={{ position: "absolute", top: size + 5, right: 0, zIndex: 40, minWidth: 190, padding: 8, boxShadow: "0 12px 30px rgba(0,0,0,.2)" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, padding: "2px 6px 6px" }}>Add to watchlist</div>
            {watchlists.map((w, i) => { const has = w.syms.includes(sym); return (
              <button key={w.id} onClick={() => { onAdd(sym, w.id); setOpen(false); }} className="tap disp" style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: 8, border: "none", background: "transparent", color: "var(--ink)", fontSize: 12.5, fontWeight: 600, textAlign: "left" }}>
                <span style={{ width: 16, height: 16, borderRadius: 5, border: "1.5px solid " + (has ? "var(--primary)" : "var(--line)"), background: has ? "var(--primary)" : "transparent", display: "grid", placeItems: "center", flexShrink: 0 }}>{has && <Check size={11} color="var(--on-primary)" />}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</span>
                {i === watchlists.length - 1 && <span style={{ fontSize: 8.5, color: "var(--muted)", fontWeight: 700 }}>latest</span>}
              </button>
            ); })}
            <div style={{ display: "flex", gap: 6, marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New list…" className="no-ring" style={{ flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: "var(--elev)", color: "var(--ink)" }} />
              <button onClick={() => { const id = onCreate ? onCreate(newName) : null; if (id) onAdd(sym, id); setNewName(""); setOpen(false); }} className="tap disp" style={{ border: "none", background: "var(--primary)", color: "var(--on-primary)", borderRadius: 8, padding: "0 12px", fontWeight: 800, fontSize: 12 }}>Add</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
function MiniRow({ s, market, onOpen, extra, watched, toggleWatch }) {
  return (
    <div className="card tap" onClick={() => onOpen(s)} style={{ padding: 14, minWidth: 158, flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 14 }}>{s.sym}</div>
          <div style={{ fontSize: 10.5, color: "var(--muted)", maxWidth: 96, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
        </div>
        {toggleWatch && <AddBtn on={watched} onClick={() => toggleWatch(s.sym)} size={26} />}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 2 }}>
        <span className="mono" style={{ fontWeight: 800, fontSize: 15 }}>{fmt(s.price, market)}</span>
        <Change v={s.chg} />
      </div>
      {extra && <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{extra}</div>}
    </div>
  );
}
function ListRow({ s, market, onOpen, right, watched, toggleWatch }) {
  return (
    <div className="tap" onClick={() => onOpen(s)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px", borderBottom: "1px solid var(--line)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="disp" style={{ fontWeight: 700, fontSize: 13.5 }}>{s.sym}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{fmt(s.price, market)}</div>
        {right || <Change v={s.chg} />}
      </div>
      {toggleWatch && <AddBtn on={watched} onClick={() => toggleWatch(s.sym)} size={26} />}
    </div>
  );
}
/* carousel card: header (sym+price+change+add) plus a body slot */
function CarouselCard({ s, market, onOpen, children, width = 250, watched, toggleWatch }) {
  return (
    <div className="card tap" onClick={() => onOpen(s)} style={{ flex: "0 0 auto", width, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.sym}</div>
          <div style={{ fontSize: 10.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
        </div>
        <div style={{ textAlign: "right", flex: "0 0 auto" }}>
          <div className="mono" style={{ fontWeight: 800, fontSize: 14, whiteSpace: "nowrap" }}>{fmt(s.price, market)}</div>
          <Change v={s.chg} />
        </div>
        {toggleWatch && <AddBtn on={watched} onClick={() => toggleWatch(s.sym)} size={26} />}
      </div>
      {children}
    </div>
  );
}

/* ============================== ASK MATRIX (real Claude API) ============================== */
/* ============================== ASK MATRIX (backend proxy or in-app) ============================== */
// 🔴 REQUIRED: paste YOUR Render backend URL here (from your Render dashboard),
// e.g. "https://matrix-backend-ab12.onrender.com" — NO trailing slash.
// While this is "", the app runs in offline SIM mode (no live prices, no login,
// no Ask Matrix, no cross-device trade history).
const BACKEND_URL = "";   // 👈 REPLACE with your real Render URL, e.g. "https://matrix-backend-xxxx.onrender.com"
const MATRIX_PERSONA = "You are Matrix — the world's sharpest stock-market research assistant, fluent in fundamental analysis, technical analysis and macro/news-driven investing. Answer with crisp, structured, practical insight a confident GenZ investor can act on. Use short paragraphs or tight bullets. When giving a view, lay out the bull case, bear case and key levels rather than a bare command. Always end with a one-line reminder that this is educational research, not financial advice.";

/* ------- LIVE PRICES (Yahoo Finance via the backend proxy) -------
 * Yahoo can't be called straight from the browser (CORS + crumb auth), so live
 * quotes come through the proxy: app → /api/quote → Yahoo. When BACKEND_URL is
 * empty (this preview), the app stays on realistic simulated data. Map app
 * tickers → Yahoo tickers below. */
const Y_SPECIAL = {
  NIFTY50: "^NSEI", BANKNIFTY: "^NSEBANK", SENSEX: "^BSESN", FINNIFTY: "^NSEFIN", INDIAVIX: "^INDIAVIX",
  SPX: "^GSPC", NDX: "^NDX", DJI: "^DJI", VIX: "^VIX",
  GOLD: "GC=F", SILVER: "SI=F", CRUDE: "CL=F", NATGAS: "NG=F", COPPER: "HG=F", ALUMINIUM: "ALI=F",
};
function yahooSymbol(sym) {
  if (Y_SPECIAL[sym]) return Y_SPECIAL[sym];
  const m = marketOf(sym);
  if (m === "Crypto") return sym + "-USD";
  if (m === "US") return sym;
  return sym + ".NS"; // NSE
}
async function fetchLiveQuotes(appSyms) {
  if (!BACKEND_URL) return null;
  const map = {};
  appSyms.forEach((s) => { map[yahooSymbol(s)] = s; });
  const tickers = Object.keys(map);
  const r = await fetch(`${BACKEND_URL}/api/quote?symbols=${encodeURIComponent(tickers.join(","))}`);
  if (!r.ok) throw new Error("quote " + r.status);
  const d = await r.json();
  return (d.quotes || []).map((q) => ({ sym: map[q.sym] || q.sym, price: q.price, chg: q.chg })).filter((x) => x.sym && x.price != null);
}
// Real headlines via the proxy (Yahoo / Moneycontrol / NewsAPI). Null in preview.
// Relative time from an ISO timestamp (real news carries real publish times).
function timeAgo(iso) {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
async function fetchNews(sym) {
  if (!BACKEND_URL) return null;
  const r = await fetch(`${BACKEND_URL}/api/news?symbol=${encodeURIComponent(yahooSymbol(sym))}`);
  if (!r.ok) throw new Error("news " + r.status);
  const d = await r.json();
  return (d.news || []).map((n) => ({ d: n.d ? new Date(n.d).toLocaleDateString() : "", t: n.t, url: n.url, src: n.src }));
}
// Map app timeframes → Yahoo range/interval (Yahoo lacks 3m/4h, so use nearest supported).
const TF_YF = { "3m": { i: "2m", r: "1d" }, "5m": { i: "5m", r: "5d" }, "30m": { i: "30m", r: "1mo" }, "1h": { i: "60m", r: "3mo" }, "4h": { i: "90m", r: "6mo" }, "1d": { i: "1d", r: "1y" } };
async function fetchHistory(sym, tf) {
  if (!BACKEND_URL) return null;
  const m = TF_YF[tf] || TF_YF["1d"];
  const r = await fetch(`${BACKEND_URL}/api/history?symbol=${encodeURIComponent(yahooSymbol(sym))}&range=${m.r}&interval=${m.i}`);
  if (!r.ok) throw new Error("history " + r.status);
  const d = await r.json();
  return (d.candles || [])
    .filter((c) => c.o != null && c.c != null && c.h != null && c.l != null)
    .map((c, i) => ({ i, t: c.t, o: +(+c.o).toFixed(2), h: +(+c.h).toFixed(2), l: +(+c.l).toFixed(2), c: +(+c.c).toFixed(2), v: c.v }));
}

// REAL fundamentals + REAL institutional holders (Yahoo quoteSummary via backend).
async function fetchFundamentals(syms) {
  if (!BACKEND_URL || !syms || !syms.length) return null;
  const ySyms = syms.map((s) => yahooSymbol(s)).join(",");
  try {
    const r = await fetch(`${BACKEND_URL}/api/fundamentals?symbols=${encodeURIComponent(ySyms)}`);
    if (!r.ok) return null;
    return (await r.json()).fundamentals || null;
  } catch { return null; }
}

// REAL indicators + volume, computed server-side from actual daily candles.
async function fetchIndicators(syms) {
  if (!BACKEND_URL || !syms || !syms.length) return null;
  const ySyms = syms.map((s) => yahooSymbol(s)).join(",");
  try {
    const r = await fetch(`${BACKEND_URL}/api/indicators?symbols=${encodeURIComponent(ySyms)}`);
    if (!r.ok) return null;
    return (await r.json()).indicators || null;
  } catch { return null; }
}

/* ================== REAL EXIT ENGINE (paper-trading) ==================
   Walks REAL intraday candles forward from the entry time and closes a position
   at whichever level is actually touched first — take-profit, stop-loss, or a
   trailing stop that ratchets up behind the highest price seen since entry.
   No random outcomes: exit price, exit time and P&L all come from market data.
   `risk` is read live from the holding, so edits in Portfolio take effect at once.
   Returns null when the position is still open (nothing touched yet).            */
async function resolveExitFromCandles(trade, risk = {}) {
  if (!BACKEND_URL) return null;                       // needs real candles
  const tp = risk.tp ?? trade.tp;
  const sl = risk.sl ?? trade.sl;
  const tsl = risk.tsl ?? trade.tsl;
  if (!tp && !sl && !tsl) return null;                  // no exit rules -> stays open
  const entry = trade.entry;
  const target = tp ? entry * (1 + tp / 100) : null;
  const hardStop = sl ? entry * (1 - sl / 100) : null;
  let candles = null;
  try { candles = await fetchHistory(trade.sym, "5m"); } catch { return null; }
  if (!candles || !candles.length) return null;

  // Only look at candles AFTER the entry timestamp.
  const after = candles.filter((c) => c.t && c.t > (trade.entryAt || 0));
  let peak = entry;                                     // highest price seen since entry
  for (const c of after) {
    // Trailing stop ratchets up with the peak, but only using peaks from PRIOR
    // candles — a candle can't be stopped out by its own new high.
    const trailStop = tsl ? peak * (1 - tsl / 100) : null;
    const stop = Math.max(hardStop ?? -Infinity, trailStop ?? -Infinity);
    const hasStop = stop > -Infinity;
    const hitStop = hasStop && c.l <= stop;
    const hitTarget = target != null && c.h >= target;
    if (hitStop && hitTarget) {
      // Both touched inside one candle — 5m data can't tell which came first, so
      // assume the worst case (stop first). Honest and conservative.
      return { exit: +stop.toFixed(2), exitAt: c.t, exitType: trailStop != null && stop === trailStop ? "Trailing stop" : "Stop loss" };
    }
    if (hitStop) return { exit: +stop.toFixed(2), exitAt: c.t, exitType: trailStop != null && stop === trailStop ? "Trailing stop" : "Stop loss" };
    if (hitTarget) return { exit: +target.toFixed(2), exitAt: c.t, exitType: "Exit trigger" };
    if (c.h > peak) peak = c.h;                         // update peak after checks
  }
  return null;   // still open
}
// Trade history flat-file sync (no-ops gracefully without a backend).
async function postTrade(userId, trade) {
  if (!BACKEND_URL) return null;
  try { const r = await fetch(`${BACKEND_URL}/api/trades`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, trade }) }); return r.ok ? (await r.json()).trade : null; } catch { return null; }
}
async function fetchTrades(userId, from, to) {
  if (!BACKEND_URL) return null;
  try { const r = await fetch(`${BACKEND_URL}/api/trades?userId=${encodeURIComponent(userId)}&from=${from}&to=${to}`); return r.ok ? (await r.json()).trades : null; } catch { return null; }
}
async function apiRegister(phone, pin, name) {
  if (!BACKEND_URL) return { error: "Login needs the backend deployed (set BACKEND_URL)." };
  try { const r = await fetch(`${BACKEND_URL}/api/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, pin, name }) }); return await r.json(); } catch { return { error: "Network error — try again." }; }
}
async function apiLogin(phone, pin) {
  if (!BACKEND_URL) return { error: "Login needs the backend deployed (set BACKEND_URL)." };
  try { const r = await fetch(`${BACKEND_URL}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, pin }) }); return await r.json(); } catch { return { error: "Network error — try again." }; }
}

async function askMatrix(messages, system, maxTokens = 1000) {
  if (BACKEND_URL) {
    // Proxy mode — key never touches the client. Backend tries Groq → OpenRouter → Gemini → Anthropic.
    const r = await fetch(`${BACKEND_URL}/api/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, system, max_tokens: maxTokens }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("proxy " + r.status));
    return (d.text || "").trim();
  }
  // In-app fallback (host runtime injects the key).
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system, messages }),
  });
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Local, offline analysis from a stock's own signals — used when the LLM proxy
// isn't reachable, so Deep Analysis / Ask Matrix always return something useful.
function localDeepAnalysis(s) {
  if (!s) return "Analysis isn't available right now.";
  const m = marketOf(s.sym);
  const trend = s.price > s.sma50 && s.sma50 > s.sma200 ? "a clean up-trend (price > 50-DMA > 200-DMA)" : s.price < s.sma50 && s.sma50 < s.sma200 ? "a down-trend (price < 50-DMA < 200-DMA)" : "a mixed / range-bound trend";
  const rsiState = s.rsi > 70 ? "overbought" : s.rsi < 30 ? "oversold" : "neutral";
  const adxState = s.adx >= 25 ? `trending (ADX ${s.adx})` : `weak/rangey (ADX ${s.adx})`;
  return [
    `Technical setup — ${s.sym} is in ${trend}. RSI ${s.rsi} (${rsiState}), MACD ${s.macd >= 0 ? "positive" : "negative"}, ${adxState}. Support ${fmt(s.support, m)}, resistance ${fmt(s.resistance, m)}; VWAP ${fmt(s.vwap, m)}.`,
    `Fundamentals — P/E ${s.pe ?? "—"}, ROE ${s.roe != null ? s.roe + "%" : "—"}, revenue growth ${s.revGrowth != null ? s.revGrowth + "%" : "—"}, earnings growth ${s.ebitdaGrowth != null ? s.ebitdaGrowth + "%" : "—"}.`,
    `Bull case — ${s.chg >= 0 ? "momentum is with buyers today" : "a bounce from support could set up a mean-reversion trade"}; a decisive close above ${fmt(s.resistance, m)} opens more upside.`,
    `Bear case — a break below ${fmt(s.support, m)} would invalidate the setup; ${s.rsi > 70 ? "stretched RSI raises pullback risk" : "weak follow-through would keep it range-bound"}.`,
    `Bottom line — Matrix reads this as a ${s.verdict} near ${fmt(s.price, m)}. Key levels: buy-zone near ${fmt(s.support, m)}, target near ${fmt(s.resistance, m)}.`,
    `Educational research, not financial advice.`,
  ].join("\n\n");
}
// Fallback interpreter: turns plain English into structured screener conditions
// using the LLM proxy (Groq first). Returns null if it can't (or no backend).
async function aiInterpretScreen(text) {
  const metrics = METRICS.map((m) => m[0]).join(", ");
  const system = `You convert a plain-English stock screen into JSON. Available metric fields: ${metrics}. Operators: ">","<",">=","<=". Output ONLY a JSON array (no prose, no markdown). Each item: {"m":<field>,"o":<op>,"rhsType":"value" or "indicator","v":<number when value>,"rhs":<field when indicator>,"tf":"3m"|"5m"|"15m"|"30m"|"1h"|"1d"}. For "EMA21 > EMA50" use ema20 vs ema50 with rhsType "indicator". Default tf "1d".`;
  try {
    const out = await askMatrix([{ role: "user", content: text }], system, 500);
    const arr = JSON.parse((out || "").replace(/```json|```/g, "").trim());
    if (Array.isArray(arr)) return arr.filter((c) => c && c.m && c.o).map((c) => ({ m: c.m, o: c.o, rhsType: c.rhsType === "indicator" ? "indicator" : "value", v: c.v != null ? String(c.v) : "", rhs: c.rhs || "sma50", tf: c.tf || "1d" }));
  } catch { /* fall through */ }
  return null;
}
// Fallback interpreter for automation plain-English → readable entry/exit summary.
async function aiInterpretStrategy(text) {
  const system = `You are a trading-strategy interpreter. Given a plain-English rule, respond with a short structured summary in this exact shape (no markdown):\nENTRY: <one line>\nEXIT: <one line>\nSTOP: <n>%\nTARGET: <n>%\nKeep it crisp and only use indicators the user mentioned.`;
  try { const out = await askMatrix([{ role: "user", content: text }], system, 400); return (out || "").trim() || null; } catch { return null; }
}
function useMatrixChat(context, stock) {
  const [msgs, setMsgs] = useState([]);
  const [busy, setBusy] = useState(false);
  async function send(text) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: "user", content: text }];
    setMsgs(next); setBusy(true);
    const system = `${MATRIX_PERSONA}${context ? "\n\nCURRENT CONTEXT:\n" + context : ""}`;
    try {
      const out = await askMatrix(next, system, 1000);
      setMsgs([...next, { role: "assistant", content: out || (stock ? localDeepAnalysis(stock) : "I couldn't reach the live engine just now. Try again in a moment.") }]);
    } catch (e) {
      const detail = e && e.message ? ` (${e.message})` : "";
      setMsgs([...next, { role: "assistant", content: stock ? localDeepAnalysis(stock) : `I couldn't reach the Matrix engine${detail}. Check that BACKEND_URL points at your Render service and that GROQ_API_KEY is set there — open <backend-url>/api/health to see which engines it can find.` }]);
    } finally { setBusy(false); }
  }
  return { msgs, busy, send, reset: () => setMsgs([]) };
}
function ChatPanel({ context, suggestions, compactMode, stock }) {
  const { msgs, busy, send } = useMatrixChat(context, stock);
  const [text, setText] = useState("");
  const scroller = useRef(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs, busy]);
  const fire = (t) => { send(t); setText(""); };
  return (
    <div className="mx" style={{ display: "flex", flexDirection: "column", height: compactMode ? 360 : "100%" }}>
      <div ref={scroller} className="hide-scroll" style={{ flex: 1, overflowY: "auto", padding: "4px 2px", display: "flex", flexDirection: "column", gap: 10 }}>
        {msgs.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--muted)", marginTop: 18, fontSize: 13 }}>
            <Bot size={26} color="var(--primary)" /><div style={{ marginTop: 6 }}>Ask Matrix anything — stocks, levels, strategy.</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "86%" }}>
            <div className="pill" style={{
              background: m.role === "user" ? "var(--primary)" : "var(--surface)",
              color: m.role === "user" ? "var(--on-primary)" : "var(--ink)",
              border: m.role === "user" ? "none" : "1px solid var(--line)",
              borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              padding: "10px 13px", fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
            }}>{m.content}</div>
          </div>
        ))}
        {busy && <div style={{ color: "var(--muted)", fontSize: 12.5, paddingLeft: 4 }}>Matrix is thinking…</div>}
      </div>
      {suggestions && msgs.length === 0 && (
        <div className="hide-scroll" style={{ display: "flex", gap: 7, overflowX: "auto", padding: "8px 2px" }}>
          {suggestions.map((q) => (
            <button key={q} onClick={() => fire(q)} className="pill tap" style={{ flex: "0 0 auto", border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 12, fontWeight: 600, padding: "7px 12px" }}>{q}</button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fire(text)}
          placeholder="Ask Matrix…" className="no-ring"
          style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 14, padding: "11px 14px", fontSize: 13.5, background: "var(--surface)" }} />
        <button onClick={() => fire(text)} className="tap" style={{ background: "var(--primary)", color: "#fff", border: "none", borderRadius: 14, width: 46, display: "grid", placeItems: "center" }}><Send size={17} /></button>
      </div>
    </div>
  );
}

/* ============================== STOCK DRAWER ============================== */
function Drawer({ s, onClose, onDetails, onBuy }) {
  const startY = useRef(null);
  const [dy, setDy] = useState(0);
  if (!s) return null;
  const market = marketOf(s.sym);
  const onTS = (e) => { startY.current = e.touches[0].clientY; };
  const onTM = (e) => { if (startY.current == null) return; setDy(e.touches[0].clientY - startY.current); };
  const onTE = () => { const d = dy; setDy(0); startY.current = null; if (d < -55) onDetails && onDetails(); else if (d > 90) onClose && onClose(); };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,10,20,.32)", zIndex: 60, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="sheet card" style={{ width: "100%", maxWidth: 460, borderRadius: "24px 24px 0 0", maxHeight: "88vh", overflowY: "auto", padding: 18, transform: dy > 0 ? `translateY(${dy}px)` : "none", transition: dy === 0 ? "transform .2s ease" : "none" }}>
        <div onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE} style={{ padding: "2px 0 10px", margin: "-2px 0 0", cursor: "grab", touchAction: "none" }}>
          <div style={{ width: 40, height: 4, background: "var(--line)", borderRadius: 9, margin: "0 auto" }} />
          <div style={{ textAlign: "center", fontSize: 9.5, color: "var(--muted)", marginTop: 6, fontWeight: 600 }}>↑ drag up for full details</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="disp" style={{ fontWeight: 700, fontSize: 19 }}>{s.sym}</div>
            <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{s.name}</div>
          </div>
          <X size={22} className="tap" onClick={onClose} color="var(--muted)" />
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10 }}>
          <span className="mono" style={{ fontWeight: 700, fontSize: 26 }}>{fmt(s.price, market)}</span>
          <Change v={s.chg} big />
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, marginBottom: 4 }}>Price action · candles</div>
          <MiniCandles sym={s.sym} price={s.price} chg={s.chg} defaultTf={market === "Crypto" ? "1h" : "1d"} showTf pattern={s.pickPattern} />
        </div>

        <Block title="Key news / event" icon={<Newspaper size={14} />}>{s.news[0].t}</Block>
        <Block title="Technical summary" icon={<Activity size={14} />}>
          RSI {s.rsi} ({s.rsi > 70 ? "overbought" : s.rsi < 30 ? "oversold" : "neutral"}), price {s.price > s.sma50 ? "above" : "below"} 50-DMA. Support {fmt(s.support, market)} · Resistance {fmt(s.resistance, market)}.
        </Block>
        <Block title="Fundamental summary" icon={<Building2 size={14} />}>
          P/E {s.pe ?? "—"}, ROE {s.roe != null ? s.roe + "%" : "—"}, revenue growth {s.revGrowth != null ? s.revGrowth + "%" : "—"}, earnings growth {s.ebitdaGrowth != null ? s.ebitdaGrowth + "%" : "—"}.
        </Block>

        <div className="card" style={{ marginTop: 12, padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg)" }}>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Matrix's verdict</div>
            <div className="disp" style={{ fontWeight: 700, fontSize: 15, marginTop: 2 }}>{s.verdict} near {fmt(s.price, market)}</div>
          </div>
          <VerdictTag v={s.verdict} size={15} />
        </div>

        <div style={{ fontSize: 11.5, color: "var(--muted)", margin: "14px 2px 6px", fontWeight: 600 }}>Ask Matrix</div>
        <div className="hide-scroll" style={{ display: "flex", gap: 7, overflowX: "auto" }}>
          {["Should I buy right now?", "Support & resistance?", "Good time to enter?"].map((q) => (
            <button key={q} onClick={() => onDetails(s)} className="pill tap" style={{ flex: "0 0 auto", border: "1px solid var(--line)", background: "var(--surface)", fontSize: 12, fontWeight: 600, padding: "7px 12px", color: "var(--ink)" }}>{q}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button onClick={() => { if (onBuy) onBuy(s, 1); onClose(); }} className="tap disp glow" style={{ flex: 1, background: "linear-gradient(120deg,var(--up),#12B98A)", color: "#fff", border: "none", borderRadius: 16, padding: "14px", fontWeight: 800, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Plus size={17} /> Buy
          </button>
          <button onClick={() => onDetails(s)} className="tap disp" style={{ flex: 1, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 16, padding: "14px", fontWeight: 700, fontSize: 14.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            Details <ChevronRight size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
function Block({ title, icon, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>{icon}{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

/* ============================== STOCK DETAIL PAGE ============================== */
function CandleChart({ data, market, sup0, res0 }) {
  const [sup, setSup] = useState(sup0);
  const [res, setRes] = useState(res0);
  const drag = useRef(null);
  const box = useRef(null);
  const W = data.length * 11, H = 260, padT = 8, padB = 8;
  const lows = data.map((d) => d.l), highs = data.map((d) => d.h);
  const min = Math.min(...lows, sup, res) * 0.996;
  const max = Math.max(...highs, sup, res) * 1.004;
  const yOf = (p) => padT + (max - p) / (max - min) * (H - padT - padB);
  const priceAt = (clientY) => {
    const r = box.current.getBoundingClientRect();
    const frac = clamp((clientY - r.top) / r.height, 0, 1);
    return max - (frac * H - padT) / (H - padT - padB) * (max - min);
  };
  const down = (e) => {
    const p = priceAt(e.clientY);
    drag.current = Math.abs(p - sup) < Math.abs(p - res) ? "sup" : "res";
    box.current.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!drag.current) return;
    const p = +priceAt(e.clientY).toFixed(2);
    drag.current === "sup" ? setSup(p) : setRes(p);
  };
  const up = () => { drag.current = null; };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>Drag the gold & silver lines to set your levels</span>
        <span style={{ fontSize: 11, display: "flex", gap: 10 }}>
          <span className="gold-text" style={{ fontWeight: 800 }}>R {fmt(res, market)}</span>
          <span style={{ color: "#B7B7C2", fontWeight: 800 }}>S {fmt(sup, market)}</span>
        </span>
      </div>
      <div ref={box} style={{ width: "100%", touchAction: "none", cursor: "ns-resize" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
          {data.map((d, k) => {
            const x = (k + 0.5) * 11, isUp = d.c >= d.o;
            const col = isUp ? "var(--up)" : "var(--down)";
            const yO = yOf(d.o), yC = yOf(d.c);
            return (
              <g key={d.i}>
                <line x1={x} x2={x} y1={yOf(d.h)} y2={yOf(d.l)} stroke={col} strokeWidth="1.2" />
                <rect x={x - 3} y={Math.min(yO, yC)} width="6" height={Math.max(2, Math.abs(yC - yO))} fill={col} rx="1" />
              </g>
            );
          })}
          {/* resistance */}
          <line x1="0" x2={W} y1={yOf(res)} y2={yOf(res)} stroke="var(--amber)" strokeWidth="1.4" strokeDasharray="6 4" />
          <rect x={W - 26} y={yOf(res) - 7} width="26" height="14" rx="3" fill="var(--amber)" />
          {/* support */}
          <line x1="0" x2={W} y1={yOf(sup)} y2={yOf(sup)} stroke="var(--primary-2)" strokeWidth="1.4" strokeDasharray="6 4" />
          <rect x={W - 26} y={yOf(sup) - 7} width="26" height="14" rx="3" fill="var(--primary-2)" />
        </svg>
      </div>
    </div>
  );
}
function DetailPage({ s, onBack, watched, toggleWatch, onTrade, onBuy }) {
  const market = marketOf(s.sym);
  const hStart = useRef(null);
  const [dDrag, setDDrag] = useState(0);
  const onHTS = (e) => { if ((window.scrollY || document.documentElement.scrollTop || 0) <= 2) hStart.current = e.touches[0].clientY; };
  const onHTM = (e) => { if (hStart.current == null) return; const d = e.touches[0].clientY - hStart.current; if (d > 0) setDDrag(d); };
  const onHTE = () => { const d = dDrag; setDDrag(0); hStart.current = null; if (d > 90) onBack && onBack(); };
  const [tf, setTf] = useState(60);
  const [active, setActive] = useState("overview");
  const [chartType, setChartType] = useState("candles");
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepText, setDeepText] = useState("");
  const [liveNews, setLiveNews] = useState(null);
  const [liveCandles, setLiveCandles] = useState(null);
  const refs = useRef({});
  useEffect(() => {
    let stop = false; setLiveNews(null); setLiveCandles(null);
    if (BACKEND_URL) {
      fetchNews(s.sym).then((n) => { if (!stop && n && n.length) setLiveNews(n); }).catch(() => {});
      fetchHistory(s.sym, "1d").then((d) => { if (!stop && d && d.length > 4) setLiveCandles(d); }).catch(() => {});
    }
    return () => { stop = true; };
  }, [s]);
  // REAL quarterly revenue & earnings, as reported (Yahoo). null -> section hides.
  const rev = useMemo(() => (s.quarters || []).map((q) => ({ q: q.q, v: q.rev })), [s]);
  const ebd = useMemo(() => (s.quarters || []).map((q) => ({ q: q.q, v: q.earn })).filter((x) => x.v != null), [s]);
  const cdata = useMemo(() => {
    const n = Math.round(tf / 1.8);
    if (liveCandles && liveCandles.length) return liveCandles.slice(-n).map((c, i) => ({ ...c, i: i + 1 }));
    return candles(s.sym, s.price, s.chg, n);
  }, [s, tf, liveCandles]);
  const data = s.series.slice(-tf);
  const tabs = [["overview", "Overview"], ["fund", "Fundamentals"], ["tech", "Technicals"], ["news", "News"], ["ask", "Ask Matrix"]];
  const n = (v, suf = "") => (v == null ? "n/a" : v + suf);
  const ctx = `Stock: ${s.name} (${s.sym}), market ${market}. Price ${fmt(s.price, market)} (${s.chg >= 0 ? "+" : ""}${s.chg}% today). REAL indicators — RSI ${n(s.rsi)}, MACD ${n(s.macd)} (signal ${n(s.macdSignal)}), ADX ${n(s.adx)}, ATR ${n(s.atr)}, 50-DMA ${n(s.sma50)}, 200-DMA ${n(s.sma200)}, support ${n(s.support)}, resistance ${n(s.resistance)}, 52w ${n(s.low52)}-${n(s.high52)}, volume ${n(s.vol)} vs 20d avg ${n(s.avgVol)}. Fundamentals — P/E ${n(s.pe)}, ROE ${n(s.roe, "%")}, revenue growth ${n(s.revGrowth, "%")}, earnings growth ${n(s.ebitdaGrowth, "%")}. Only use the figures given; if something is n/a, say so rather than guessing.`;

  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setActive(e.target.dataset.sec); });
    }, { rootMargin: "-45% 0px -50% 0px" });
    Object.values(refs.current).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [s]);

  const jump = (k) => { const el = refs.current[k]; if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
  async function askDeep() {
    if (deepBusy) return;
    setDeepBusy(true); setDeepText("");
    const system = `You are Matrix — the world's sharpest equity-research assistant. Produce a structured deep-dive with these headed parts: Technical setup; Latest quarterly results; Recent news & catalysts; Bottom-line verdict with key levels. Be crisp and use short paragraphs. End with: "Educational research, not financial advice."\n\nCONTEXT:\n${ctx}`;
    try {
      const t = await askMatrix([{ role: "user", content: `Give me a comprehensive deep analysis of ${s.name} (${s.sym}) right now.` }], system, 1100);
      setDeepText(t || localDeepAnalysis(s));
    } catch { setDeepText(localDeepAnalysis(s)); }
    finally { setDeepBusy(false); }
  }

  const secStyle = { scrollMarginTop: 118, marginTop: 34 };
  const Heading = ({ icon, children }) => (
    <div style={{ marginBottom: 10 }}>
      <div className="disp" style={{ fontWeight: 700, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>{icon}{children}</div>
      <div className="gold-line" style={{ width: 44, marginTop: 7, borderRadius: 2 }} />
    </div>
  );

  return (
    <div className="mx fade" style={{ paddingBottom: 40, transform: dDrag > 0 ? `translateY(${dDrag}px)` : "none", transition: dDrag === 0 ? "transform .2s ease" : "none" }}>
      <div className="glass" onTouchStart={onHTS} onTouchMove={onHTM} onTouchEnd={onHTE} style={{ position: "sticky", top: 0, background: "var(--header-bg)", zIndex: 20, paddingTop: 6, paddingBottom: 8, touchAction: "pan-x" }}>
        <div style={{ width: 40, height: 4, background: "var(--line)", borderRadius: 9, margin: "0 auto 8px" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={onBack} className="tap" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, width: 38, height: 38, display: "grid", placeItems: "center" }}><ChevronLeft size={20} /></button>
          <div style={{ textAlign: "center" }}>
            <div className="disp" style={{ fontWeight: 700, fontSize: 15 }}>{s.sym}</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{s.name}</div>
          </div>
          <button onClick={() => toggleWatch(s.sym)} className="tap" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, width: 38, height: 38, display: "grid", placeItems: "center" }}>
            <Star size={18} fill={watched ? "var(--primary)" : "none"} color={watched ? "var(--primary)" : "var(--muted)"} />
          </button>
        </div>
        <div className="hide-scroll" style={{ display: "flex", gap: 7, overflowX: "auto", marginTop: 10 }}>
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => jump(k)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "7px 14px", fontSize: 12.5, fontWeight: 700, border: "1px solid " + (active === k ? "var(--primary)" : "var(--line)"), background: active === k ? "var(--primary)" : "var(--surface)", color: active === k ? "var(--on-primary)" : "var(--ink)" }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 12 }}>
        <span className="mono" style={{ fontWeight: 800, fontSize: 30 }}>{fmt(s.price, market)}</span>
        <Change v={s.chg} big />
      </div>

      {/* OVERVIEW */}
      <div data-sec="overview" ref={(el) => (refs.current.overview = el)} style={{ scrollMarginTop: 118, marginTop: 14 }}>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[["candles", "Candles"], ["area", "Area"]].map(([k, l]) => (
              <button key={k} onClick={() => setChartType(k)} className="pill tap disp" style={{ fontSize: 11.5, fontWeight: 700, padding: "5px 13px", border: "1px solid " + (chartType === k ? "var(--primary)" : "var(--line)"), background: chartType === k ? "var(--primary)" : "transparent", color: chartType === k ? "var(--on-primary)" : "var(--muted)" }}>{l}</button>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {[[24, "1M"], [40, "3M"], [60, "6M"]].map(([n, l]) => (
                <button key={l} onClick={() => setTf(n)} className="pill tap" style={{ fontSize: 11, fontWeight: 700, padding: "5px 11px", border: "none", background: tf === n ? "var(--primary-soft)" : "transparent", color: tf === n ? "var(--primary)" : "var(--muted)" }}>{l}</button>
              ))}
            </div>
          </div>
          {chartType === "candles" ? (
            <CandleChart key={s.sym + tf} data={cdata} market={market} sup0={s.support} res0={s.resistance} />
          ) : (
            <div style={{ height: 244 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
                  <defs><linearGradient id="big" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.chg >= 0 ? "#0FB97D" : "#FF4D67"} stopOpacity={0.3} /><stop offset="100%" stopColor={s.chg >= 0 ? "#0FB97D" : "#FF4D67"} stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <YAxis domain={["dataMin", "dataMax"]} hide />
                  <Tooltip formatter={(v) => fmt(v, market)} labelFormatter={() => ""} contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 12, boxShadow: "var(--shadow)" }} itemStyle={{ color: "var(--ink)" }} />
                  <ReferenceLine y={s.support} stroke="#C9C9D4" strokeDasharray="4 4" />
                  <ReferenceLine y={s.resistance} stroke="#A99BFF" strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="p" stroke={s.chg >= 0 ? "#0FB97D" : "#FF4D67"} strokeWidth={2.4} fill="url(#big)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        <div className="card" style={{ marginTop: 12, padding: 16, background: "linear-gradient(160deg,var(--primary-soft),var(--surface))" }}>
          <div className="disp" style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><Sparkles size={16} color="var(--primary)" /> Matrix's analysis</div>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
            {s.rsi == null ? "Live technicals are still loading for this symbol." : <>Technically, RSI is <b>{s.rsi}</b> with price {s.sma50 != null ? (s.price > s.sma50 ? "above" : "below") : "—"} the 50-DMA{s.sma50 != null && s.sma200 != null ? (s.sma50 > s.sma200 ? " and a bullish 50/200 structure" : " and a bearish 50/200 structure") : ""}. {s.revGrowth != null ? <>Revenue is {s.revGrowth >= 0 ? "growing" : "contracting"} <b>{Math.abs(s.revGrowth)}%</b>{s.ebitdaGrowth != null ? <> with earnings {s.ebitdaGrowth >= 0 ? "expanding" : "compressing"} <b>{Math.abs(s.ebitdaGrowth)}%</b></> : null}.</> : "Fundamentals are unavailable for this symbol."}</>}
          </p>
          <button onClick={askDeep} disabled={deepBusy} className="tap disp glow" style={{ width: "100%", marginTop: 14, background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "#fff", border: "none", borderRadius: 14, padding: 12, fontWeight: 700, fontSize: 13.5, display: "flex", gap: 7, alignItems: "center", justifyContent: "center", opacity: deepBusy ? 0.7 : 1 }}>
            <Sparkles size={16} /> {deepBusy ? "Generating deep analysis…" : "Deep Analysis"}
          </button>
        </div>
        {(deepText || deepBusy) && (
          <div className="card" style={{ marginTop: 12, padding: 16 }}>
            <div className="disp" style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}><Sparkles size={15} color="var(--primary)" /> Matrix Deep Analysis</div>
            {deepBusy && !deepText ? <div style={{ color: "var(--muted)", fontSize: 13 }}>Pulling technicals, latest quarter and news together…</div>
              : <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{deepText}</div>}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button onClick={() => onBuy && onBuy(s, 1)} className="tap disp glow" style={{ flex: 1, background: "linear-gradient(120deg,var(--up),#12B98A)", color: "#fff", border: "none", borderRadius: 16, padding: 14, fontWeight: 800, fontSize: 14.5, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}><Plus size={17} /> Buy</button>
          <button onClick={() => onTrade(s)} className="tap disp" style={{ flex: 1, background: "var(--elev)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 16, padding: 14, fontWeight: 700, fontSize: 14.5 }}>Trade…</button>
        </div>
      </div>

      {/* FUNDAMENTALS — all REAL (Yahoo). Anything unavailable shows "—" or hides. */}
      <div data-sec="fund" ref={(el) => (refs.current.fund = el)} style={secStyle}>
        <Pop>
          <Heading icon={<Building2 size={18} color="var(--primary)" />}>Fundamentals</Heading>
          {rev.length > 0 ? (
            <ChartCard title="Revenue (quarterly, as reported)" sub={s.revGrowth != null ? `${s.revGrowth >= 0 ? "+" : ""}${s.revGrowth}% YoY` : ""}>
              <BarBlock data={rev} color="var(--primary)" />
            </ChartCard>
          ) : null}
          {ebd.length > 0 ? (
            <ChartCard title="Earnings (quarterly, as reported)" sub={s.ebitdaGrowth != null ? `${s.ebitdaGrowth >= 0 ? "+" : ""}${s.ebitdaGrowth}% YoY` : ""}>
              <BarBlock data={ebd} color="#0FB97D" />
            </ChartCard>
          ) : null}
          <StatGrid rows={[
            ["P/E", s.pe ?? "—"],
            ["ROE", s.roe != null ? s.roe + "%" : "—"],
            ["Profit margin", s.profitMargin != null ? s.profitMargin + "%" : "—"],
            ["Market cap", s.marketCap != null ? compact(s.marketCap) : "—"],
            ["Revenue growth", s.revGrowth != null ? s.revGrowth + "%" : "—"],
            ["Earnings growth", s.ebitdaGrowth != null ? s.ebitdaGrowth + "%" : "—"],
            ["Debt / equity", s.debtToEquity ?? "—"],
            ["Sector", s.sector],
          ]} />
          {s.pe == null && rev.length === 0 && (
            <div className="card" style={{ padding: 16, textAlign: "center", color: "var(--muted)", fontSize: 12.5, marginTop: 10 }}>
              {BACKEND_URL ? "No published fundamentals for this instrument (common for indices, futures and crypto)." : "Connect the backend to load real fundamentals."}
            </div>
          )}
        </Pop>
      </div>

      {/* TECHNICALS */}
      <div data-sec="tech" ref={(el) => (refs.current.tech = el)} style={secStyle}>
        <Pop>
          <Heading icon={<Activity size={18} color="var(--primary)" />}>Technicals</Heading>
          {s.rsi != null ? (
            <Gauge value={clamp(
              50 + (s.rsi - 50) * 0.6
                 + (s.sma50 != null && s.price > s.sma50 ? 10 : -10)
                 + (s.sma50 != null && s.sma200 != null && s.sma50 > s.sma200 ? 8 : -8)
                 + (s.macd != null && s.macdSignal != null && s.macd > s.macdSignal ? 8 : -8)
                 + (s.adx != null && s.adx > 25 ? 6 : 0), 5, 96) | 0} label="Technical strength (live)" />
          ) : null}
          <StatGrid rows={[
            ["RSI (14)", s.rsi + (s.rsi > 70 ? " · overbought" : s.rsi < 30 ? " · oversold" : " · neutral")],
            ["MACD", (s.macd >= 0 ? "+" : "") + s.macd + (s.macd >= 0 ? " · bullish" : " · bearish")],
            ["50-DMA", fmt(s.sma50, market)], ["200-DMA", fmt(s.sma200, market)],
            ["Support", fmt(s.support, market)], ["Resistance", fmt(s.resistance, market)],
            ["Trend", s.sma50 > s.sma200 ? "Golden-cross zone" : "Below 200-DMA"],
          ]} />
          <TextCard title="Technical summary">
            Price is trading {s.price > s.sma50 ? "above" : "below"} its 50-DMA and {s.price > s.sma200 ? "above" : "below"} its 200-DMA. RSI at {s.rsi} signals {s.rsi > 70 ? "stretched, overbought conditions" : s.rsi < 30 ? "oversold, possible bounce" : "balanced momentum"}; MACD is {s.macd >= 0 ? "positive" : "negative"}. Watch {fmt(s.support, market)} as support and {fmt(s.resistance, market)} as resistance.
          </TextCard>
          <TextCard title="Matrix's summary" accent>{s.rsi > 70 ? "Momentum is hot but extended — avoid chasing; buy dips toward support." : s.rsi < 30 ? "Oversold setup — high-risk traders can scalp a bounce with tight stops." : "Constructive, non-extended setup — trend continuation favoured while support holds."}</TextCard>
        </Pop>
      </div>

      {/* NEWS — real headlines only (Yahoo / NewsAPI via the backend). */}
      <div data-sec="news" ref={(el) => (refs.current.news = el)} style={secStyle}>
        <Pop>
          <Heading icon={<Newspaper size={18} color="var(--primary)" />}>News</Heading>
          {liveNews && liveNews.length ? liveNews.map((n, i) => (
            <a key={i} href={n.url || undefined} target="_blank" rel="noreferrer" className="card" style={{ display: "block", padding: 14, marginBottom: 10, textDecoration: "none", color: "inherit" }}>
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>{timeAgo(n.d)}{n.src ? " · " + n.src : ""}</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>{n.t}</div>
            </a>
          )) : (
            <div className="card" style={{ padding: 18, textAlign: "center", color: "var(--muted)", fontSize: 12.5 }}>
              {BACKEND_URL ? "No recent headlines for this symbol." : "Connect the backend to load live headlines."}
            </div>
          )}
        </Pop>
      </div>

      {/* ASK */}
      <div data-sec="ask" ref={(el) => (refs.current.ask = el)} style={secStyle}>
        <Pop>
          <Heading icon={<Bot size={18} color="var(--primary)" />}>Ask Matrix</Heading>
          <div className="card" style={{ padding: 14, height: 460 }}>
            <ChatPanel context={ctx} stock={s} suggestions={["Should I buy right now?", "Support & resistance levels?", "Is this a good time to enter?", "Bull vs bear case?"]} />
          </div>
        </Pop>
      </div>
    </div>
  );
}
function ChartCard({ title, sub, children }) {
  return <div className="card" style={{ marginTop: 12, padding: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <div className="disp" style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{sub}</div>
    </div>
    <div style={{ height: 150, marginTop: 8 }}>{children}</div>
  </div>;
}
function BarBlock({ data, color }) {
  return <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
      <CartesianGrid vertical={false} stroke="var(--grid)" />
      <XAxis dataKey="q" tick={{ fontSize: 10, fill: "#8A8A99" }} axisLine={false} tickLine={false} />
      <YAxis hide />
      <Tooltip formatter={(v) => compact(v)} contentStyle={{ borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 12, boxShadow: "var(--shadow)" }} itemStyle={{ color: "var(--ink)" }} />
      <Bar dataKey="v" fill={color} radius={[6, 6, 0, 0]} />
    </BarChart>
  </ResponsiveContainer>;
}
function StatGrid({ rows }) {
  return <div className="card" style={{ marginTop: 12, padding: 6, display: "grid", gridTemplateColumns: "1fr 1fr" }}>
    {rows.map(([k, v], i) => (
      <div key={i} style={{ padding: 12, borderBottom: i < rows.length - 2 ? "1px solid var(--line)" : "none" }}>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>{k}</div>
        <div className="disp" style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{v}</div>
      </div>
    ))}
  </div>;
}
function TextCard({ title, children, accent }) {
  return <div className="card" style={{ marginTop: 12, padding: 14, background: accent ? "linear-gradient(160deg,var(--primary-soft),var(--surface))" : "var(--surface)" }}>
    <div className="disp" style={{ fontWeight: 700, fontSize: 13.5, display: "flex", gap: 6, alignItems: "center" }}>{accent && <Sparkles size={14} color="var(--primary)" />}{title}</div>
    <p style={{ fontSize: 13, lineHeight: 1.6, margin: "7px 0 0" }}>{children}</p>
  </div>;
}

/* ============================== HOME ============================== */
const GLOBAL_MKTS = [
  { n: "NIFTY 50", c: 0.62 }, { n: "SENSEX", c: 0.58 }, { n: "BANK NIFTY", c: 0.84 },
  { n: "S&P 500", c: 0.41 }, { n: "NASDAQ", c: 0.73 }, { n: "DOW", c: 0.22 },
  { n: "FTSE 100", c: -0.18 }, { n: "NIKKEI", c: 1.12 }, { n: "HANG SENG", c: -0.44 },
  { n: "BTC", c: 1.92 }, { n: "ETH", c: 2.64 }, { n: "GOLD", c: 0.54 }, { n: "CRUDE", c: -0.88 },
];
function GlobalStrip() {
  return (
    <div className="hide-scroll" style={{ display: "flex", gap: 0, overflowX: "auto", marginTop: 10, borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)" }}>
      {GLOBAL_MKTS.map((m, i) => (
        <div key={m.n} style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 7, padding: "8px 13px", borderRight: i < GLOBAL_MKTS.length - 1 ? "1px solid var(--line)" : "none" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-soft)" }}>{m.n}</span>
          <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: m.c >= 0 ? "var(--up)" : "var(--down)" }}>{m.c >= 0 ? "▲" : "▼"}{Math.abs(m.c).toFixed(2)}%</span>
        </div>
      ))}
    </div>
  );
}
function MarketPulseStrip({ market, list, onOpen }) {
  const vixSym = market === "US" ? "VIX" : "INDIAVIX";
  const idxSym = market === "US" ? "SPX" : market === "Crypto" ? "BTC" : market === "Commodity" ? "GOLD" : "NIFTY50";
  const vix = ALL.find((a) => a.sym === vixSym) || ALL.find((a) => a.sym === "INDIAVIX");
  const idx = ALL.find((a) => a.sym === idxSym) || ALL[0];
  const idxLabel = market === "US" ? "S&P 500" : market === "Crypto" ? "BTC" : market === "Commodity" ? "GOLD" : "NIFTY 50";
  const hot = useMemo(() => [...list].sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 8), [list]);
  const [pi, setPi] = useState(0);
  useEffect(() => {
    if (hot.length < 2) return;
    const t = setInterval(() => setPi((p) => (p + 2) % hot.length), 2000);
    return () => clearInterval(t);
  }, [hot]);
  const pair = hot.length ? [hot[pi % hot.length], hot[(pi + 1) % hot.length]] : [];
  const open = (s) => s && onOpen(s);
  return (
    <div className="card" style={{ marginTop: 22, padding: 12, display: "flex", alignItems: "stretch", gap: 10 }}>
      <div onClick={() => open(vix)} className="tap" style={{ flex: "0 0 auto" }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700 }}>VIX</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span className="mono" style={{ fontWeight: 800, fontSize: 15 }}>{vix.price}</span>
          <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: vix.chg >= 0 ? "var(--down)" : "var(--up)" }}>{vix.chg >= 0 ? "+" : ""}{vix.chg}%</span>
        </div>
      </div>
      <div style={{ width: 1, background: "var(--line)" }} />
      <div onClick={() => open(idx)} className="tap" style={{ flex: "0 0 auto" }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700 }}>{idxLabel}</div>
        <div className="mono" style={{ fontWeight: 800, fontSize: 15, color: idx.chg >= 0 ? "var(--up)" : "var(--down)" }}>{idx.chg >= 0 ? "▲ +" : "▼ "}{idx.chg}%</div>
      </div>
      <div style={{ width: 1, background: "var(--line)" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>🔥 Hot Stocks</div>
        <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
          {pair.map((h, k) => (
            <div key={h.sym + k} onClick={() => open(h)} className="tap fade" style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span className="disp" style={{ fontWeight: 700, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.sym}</span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: h.chg >= 0 ? "var(--up)" : "var(--down)", flex: "0 0 auto" }}>{h.chg >= 0 ? "+" : ""}{h.chg.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function StockIdeasStrip({ onOpen, onBuy, market }) {
  const mkt = market === "FNO" ? "IN" : market;
  const all = SEED_IDEAS.filter((i) => marketOf(i.sym) === mkt);
  const top = (all.length ? all : SEED_IDEAS).slice(0, 6);
  return (
    <Section title="Ideas" icon={<Lightbulb size={17} color="var(--primary)" />}>
      <div className="hide-scroll" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
        {top.map((idea, i) => {
          const s = ALL.find((a) => a.sym === idea.sym); const m = marketOf(idea.sym);
          const cur = s ? s.price : idea.entry;
          const potLeft = ((idea.exit - cur) / cur) * 100;
          return (
            <div key={i} onClick={() => s && onOpen(s)} className="card tap" style={{ flex: "0 0 auto", width: 236, padding: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="disp" style={{ fontWeight: 700, fontSize: 14 }}>{idea.sym}</span>
                <span className="pill" style={{ fontSize: 10, background: idea.by === "Matrix" ? "var(--primary-soft)" : "var(--bg)", color: idea.by === "Matrix" ? "var(--primary)" : "var(--ink-soft)", fontWeight: 700, padding: "2px 8px" }}>{idea.by === "Matrix" ? "✦ Matrix" : idea.by}</span>
              </div>
              <div style={{ marginTop: 8 }}><MiniCandles sym={idea.sym} price={cur} chg={s ? s.chg : 0} height={92} showTf={false} staticChart defaultTf={m === "Crypto" ? "1h" : "1d"} pattern={idea.pattern} /></div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 10.5, gap: 4 }}>
                <div><div style={{ color: "var(--muted)", fontSize: 9 }}>Entry</div><span className="mono" style={{ fontWeight: 700 }}>{fmt(idea.entry, m)}</span></div>
                <div><div style={{ color: "var(--muted)", fontSize: 9 }}>Current</div><span className="mono" style={{ fontWeight: 800 }}>{fmt(cur, m)}</span></div>
                <div><div style={{ color: "var(--muted)", fontSize: 9 }}>Target</div><span className="mono" style={{ fontWeight: 700 }}>{fmt(idea.exit, m)}</span></div>
                <div style={{ textAlign: "right" }}><div style={{ color: "var(--muted)", fontSize: 9 }}>Left</div><span className="mono" style={{ fontWeight: 800, color: potLeft >= 0 ? "var(--up)" : "var(--muted)" }}>{potLeft >= 0 ? "+" + potLeft.toFixed(1) + "%" : "hit"}</span></div>
              </div>
              {s && onBuy && <button onClick={(e) => { e.stopPropagation(); onBuy(s, 1); }} className="tap disp" style={{ width: "100%", marginTop: 10, background: "linear-gradient(120deg,var(--up),#0EA968)", color: "#fff", border: "none", borderRadius: 11, padding: 9, fontWeight: 800, fontSize: 12, display: "flex", gap: 5, alignItems: "center", justifyContent: "center" }}><Plus size={14} /> Buy Now</button>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
function DashStat({ k, v, pos }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, opacity: .8 }}>{k}</div>
      <div className="mono" style={{ fontWeight: 800, fontSize: 14, color: pos ? "#9CFFD6" : "#FFB3BE" }}>{v}</div>
    </div>
  );
}

/* Real, current headlines — one card per symbol, fetched from the backend
   (Yahoo Finance news, or NewsAPI when NEWS_API_KEY is set). Nothing hardcoded. */
function LiveNewsStrip({ symbols = [], onOpen, list = [] }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const key = symbols.join(",");
  useEffect(() => {
    let stop = false;
    setLoading(true); setItems([]);
    if (!BACKEND_URL || !symbols.length) { setLoading(false); return; }
    Promise.all(symbols.slice(0, 6).map((sym) =>
      fetchNews(sym).then((n) => (n && n.length ? { sym, n: n[0] } : null)).catch(() => null)
    )).then((rows) => {
      if (stop) return;
      setItems(rows.filter(Boolean));
      setLoading(false);
    });
    return () => { stop = true; };
  }, [key]);

  return (
    <Section title="In the news" icon={<Newspaper size={17} color="#E8A33D" />}>
      {loading ? (
        <div className="card" style={{ padding: 18, color: "var(--muted)", fontSize: 12.5 }}>Loading latest headlines…</div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 18, color: "var(--muted)", fontSize: 12.5 }}>{BACKEND_URL ? "No recent headlines right now." : "Connect the backend to load live news."}</div>
      ) : (
        <div className="hide-scroll" style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
          {items.map(({ sym, n }) => {
            const s = list.find((a) => a.sym === sym);
            return (
              <div key={sym} className="card" style={{ flex: "0 0 auto", width: 250, padding: 14 }}>
                <div onClick={() => s && onOpen(s)} className="tap disp" style={{ fontWeight: 800, fontSize: 13.5 }}>{sym}</div>
                <a href={n.url || undefined} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "inherit" }}>
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{n.t}</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 7 }}>{timeAgo(n.d)}{n.src ? " · " + n.src : ""}</div>
                </a>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* Market update — generated by the LLM from REAL live numbers (breadth, top
   movers, index change). No hardcoded editorial. Falls back to a plain factual
   summary of the same real numbers if the LLM is unreachable. */
function MarketBrief({ market, list = [] }) {
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(true);
  const withData = list.filter((s) => s.hasData && s.chg != null);
  const key = market + "|" + Math.floor(Date.now() / 3600000) + "|" + withData.length;
  useEffect(() => {
    let stop = false;
    setBusy(true);
    if (!withData.length) { setText(null); setBusy(false); return; }
    const up = withData.filter((s) => s.chg > 0).length;
    const down = withData.filter((s) => s.chg < 0).length;
    const top = [...withData].sort((a, b) => b.chg - a.chg).slice(0, 3);
    const bot = [...withData].sort((a, b) => a.chg - b.chg).slice(0, 3);
    const avg = (withData.reduce((a, s) => a + s.chg, 0) / withData.length).toFixed(2);
    const facts = `Market: ${market}. Advancing ${up}, declining ${down}, average change ${avg}%. Top gainers: ${top.map((s) => `${s.sym} ${s.chg > 0 ? "+" : ""}${s.chg}%`).join(", ")}. Top losers: ${bot.map((s) => `${s.sym} ${s.chg}%`).join(", ")}.`;
    const fallback = `Breadth is ${up > down ? "positive" : up < down ? "negative" : "mixed"} — ${up} advancing vs ${down} declining, average move ${avg}%. Leading: ${top.map((s) => s.sym).join(", ")}. Lagging: ${bot.map((s) => s.sym).join(", ")}.`;
    askMatrix(
      [{ role: "user", content: facts }],
      "You are a market analyst. Using ONLY the real numbers given, write a 2-3 sentence market update: what breadth and the movers imply, and what to watch. Do not invent any figure, company or event not in the data. No preamble, no disclaimer.",
      220
    ).then((out) => { if (!stop) { setText((out || "").trim() || fallback); setBusy(false); } })
     .catch(() => { if (!stop) { setText(fallback); setBusy(false); } });
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (busy) return <p style={{ fontSize: 12.8, lineHeight: 1.6, margin: 0, color: "var(--muted)" }}>Reading the tape…</p>;
  if (!text) return <p style={{ fontSize: 12.8, lineHeight: 1.6, margin: 0, color: "var(--muted)" }}>Live market data is still loading.</p>;
  return <p style={{ fontSize: 12.8, lineHeight: 1.6, margin: 0, color: "var(--ink-soft)" }}>{text}</p>;
}
function HomeView({ market, setMarket, segment, setSegment, list, onOpen, onBuy, watch, toggleWatch, profile, portfolio = [], wallet = 0, onGoPortfolio, autoBuy, setAutoBuy, autoStats, onRecord, watchlists, addToWatch, createWatchlist, trades = [] }) {
  const [glMode, setGlMode] = useState("Gainers");
  // Picks refresh ONCE AN HOUR (not on every tick) so they don't churn.
  const [pickHour, setPickHour] = useState(() => Math.floor(Date.now() / 3600000));
  useEffect(() => {
    const id = setInterval(() => setPickHour(Math.floor(Date.now() / 3600000)), 60000);
    return () => clearInterval(id);
  }, []);
  const picks = useMemo(() => {
    const base = dailyPicks(list).slice(0, 8);
    return market === "FNO" ? base.map((s) => ({ ...makeFuture(s), pickSignal: s.pickSignal, pickReason: s.pickReason, pickPattern: s.pickPattern, pickStop: s.pickStop, pickTarget: s.pickTarget, pickSlPct: s.pickSlPct, pickTpPct: s.pickTpPct, pickRR: s.pickRR })) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, market, pickHour]);
  // Trending = REAL relative volume + REAL short-term gain (not just raw volume).
  const trending = useMemo(() => [...list]
    .filter((s) => s.hasData && s.vol != null)
    .map((s) => ({ s, rv: s.avgVol ? (s.vol || 0) / s.avgVol : 0 }))
    .sort((a, b) => (b.rv * 2 + (b.s.chg || 0)) - (a.rv * 2 + (a.s.chg || 0)))
    .slice(0, 6).map((x) => x.s), [list, pickHour]);
  // Exclude volatility indices (India VIX etc.) from gainers/losers — they're not tradeable stocks.
  const glList = list.filter((s) => s.sector !== "Volatility" && !/VIX/i.test(s.sym));
  const gainers = [...glList].sort((a, b) => b.chg - a.chg).slice(0, 5);
  const losers = [...glList].sort((a, b) => a.chg - b.chg).slice(0, 5);
  const traded = [...list].filter((s) => s.vol != null).sort((a, b) => (b.vol || 0) - (a.vol || 0)).slice(0, 6);
  const inNews = [...list].sort((a, b) => (b.vol || 0) - (a.vol || 0)).slice(0, 6);
  const smart = list.filter((s) => s.inst);
  const optOf = (s) => makeFuture(s);
  const trendingView = market === "FNO" ? trending.map(optOf) : trending;
  const tradedView = market === "FNO" ? traded.map(optOf) : traded;

  // portfolio dashboard math
  const dash = portfolio.reduce((a, h) => {
    const cur = (ALL.find((x) => x.sym === h.sym) || { price: h.buy }).price;
    const days = Math.max(1, Math.round((Date.now() - h.date) / 86400000));
    a.val += cur * h.qty; a.inv += h.buy * h.qty;
    a.annNum += (Math.pow(cur / h.buy, 365 / days) - 1) * (h.buy * h.qty);
    return a;
  }, { val: 0, inv: 0, annNum: 0 });
  const net = dash.val - dash.inv;
  const retPct = dash.inv ? (net / dash.inv) * 100 : 0;
  const annPct = dash.inv ? (dash.annNum / dash.inv) * 100 : 0;

  // Auto-Buy Matrix's picks — for the market selected at the top; each market keeps its own on/off
  const [dashView, setDashView] = useState("auto");
  const [autoOnMap, setAutoOnMap] = useState({ IN: false, US: false, Crypto: false, Commodity: false, FNO: false });
  const [deployCapital, setDeployCapital] = useState("100000");
  const [plPeriod, setPlPeriod] = useState("today");
  const [autoOverrides, setAutoOverrides] = useState({});   // sym -> {tp, sl}
  const [editSym, setEditSym] = useState(null);
  const [showTrades, setShowTrades] = useState(false);
  const MKT_LABEL = { IN: "🇮🇳 Indian", US: "🇺🇸 US", Crypto: "₿ Crypto", Commodity: "🪙 Commodity", FNO: "⚡ F&O" };
  const autoOn = !!autoOnMap[market];                       // on/off for the currently selected market
  const capNum = Math.max(1000, parseInt(deployCapital) || 100000);
  const aggCur = market === "FNO" ? "IN" : market;          // currency of the selected market
  const isFNO = market === "FNO";
  const LOTS = { NIFTY50: 50, BANKNIFTY: 15, FINNIFTY: 40, RELIANCE: 250, HDFCBANK: 550, ICICIBANK: 700, SBIN: 750, TCS: 150, INFY: 400, TATAMOTORS: 800, TATAPOWER: 1500, LT: 150, BAJFINANCE: 125, ADANIENT: 300, HAL: 150, BEL: 2850, DIXON: 50, ITC: 1600 };
  const lotSize = (sym) => LOTS[sym] || 500;
  const dayStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const mkTime = (addMin) => { const base = 9 * 60 + 15 + addMin; const h = Math.floor(base / 60), mm = base % 60; return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
  const autoTargets = (s) => {
    const t = techSignal(s);
    let tp = clamp(((s.resistance - s.price) / s.price) * 100, 0.8, 6);
    let sl = clamp(((s.price - s.support) / s.price) * 100, 0.3, 3);
    if (t.pattern === "breakout") tp = clamp(tp * 1.3 + 1, 1.5, 8);
    else if (t.pattern === "flag") tp = clamp(tp + 0.6, 1.2, 6.5);
    else if (t.pattern === "doubleBottom" || t.pattern === "cup") tp = clamp(tp + 0.4, 1.5, 7);
    if (marketOf(s.sym) === "Crypto") { tp = clamp(tp * 2, 2, 16); sl = clamp(sl * 1.6, 1, 9); }
    return { tp: +tp.toFixed(1), sl: +sl.toFixed(1) };
  };
  const autoPicks = useMemo(() => dailyPicks(UNIVERSE[market]).slice(0, 6), [market]);
  const perCap = capNum / Math.max(1, autoPicks.length);
  const autoTrades = autoPicks.map((s) => {
    const m = marketOf(s.sym);
    if (isFNO) {
      // F&O auto-buy trades the CURRENT-MONTH FUTURES of the underlying, 1 lot.
      const f = makeFuture(s);
      const auto = autoTargets(s);
      const ov = autoOverrides[f.sym];
      return { sym: f.sym, under: s.sym, m: "FNO", isFut: true, expiry: f.expiry, qty: f.lot,
               entry: s.price, tpPct: ov ? ov.tp : auto.tp, slPct: ov ? ov.sl : auto.sl, auto };
    }
    const auto = autoTargets(s);
    const ov = autoOverrides[s.sym];
    const tpPct = ov ? ov.tp : auto.tp;
    const slPct = ov ? ov.sl : auto.sl;
    const entry = s.price;
    const qty = Math.max(1, Math.floor(perCap / entry));
    const dp = entry < 1 ? 6 : entry < 10 ? 4 : 2;
    return { sym: s.sym, m, qty, entry, tpPct, slPct, auto };   // planned entry; the exit engine closes it at real prices
  });
  // When Auto-Buy is ON, actually place today's picks as REAL positions (once per
  // day per market) with their target/stop attached. The exit engine then closes
  // them at real market prices — no simulated win/loss.
  useEffect(() => {
    if (!autoOn || !onBuy || !BACKEND_URL) return;
    const key = `mx_autobuy_${market}_${DAY}`;
    if (lsGet(key, false)) return;
    autoTrades.forEach((t) => {
      const u = ALL.find((a) => a.sym === (t.under || t.sym));
      if (!u) return;
      // F&O: buy the futures contract (priced off the underlying, qty = 1 lot).
      const inst = t.isFut ? { ...u, sym: t.sym, name: `${u.name} — ${t.expiry} Futures` } : u;
      onBuy(inst, t.qty, { tp: t.tpPct, sl: t.slPct, tradeType: "Auto Buy" });
    });
    lsSet(key, true);
  }, [autoOn, market]);
  const setOv = (t, field, val) => setAutoOverrides((o) => { const cur = o[t.sym] || { tp: t.tpPct, sl: t.slPct }; return { ...o, [t.sym]: { ...cur, [field]: val === "" ? cur[field] : +val } }; });
  // period stats (shown regardless of on/off)
  const bizDaysThisMonth = () => { const now = new Date(); let c = 0; for (let d = 1; d <= now.getDate(); d++) { const wd = new Date(now.getFullYear(), now.getMonth(), d).getDay(); if (wd >= 1 && wd <= 5) c++; } return c; };
  // REAL stats: every number below comes from actual recorded Auto-Buy trades.
  // Closed trades contribute realised P&L; open ones contribute live unrealised P&L.
  const periodFrom = useMemo(() => {
    const d = new Date();
    if (plPeriod === "today") { d.setHours(0, 0, 0, 0); return d.getTime(); }
    if (plPeriod === "month") { d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }
    return 0;                                       // lifetime
  }, [plPeriod]);
  const autoRows = useMemo(() => (trades || [])
    .filter((t) => (t.tradeType === "Auto Buy") && (t.market || "IN") === market && (t.entryAt || 0) >= periodFrom)
    .map((t) => {
      const open = t.exitAt == null;
      const cur = open ? ((ALL.find((a) => a.sym === t.sym) || {}).price ?? t.entry) : t.exit;
      return { ...t, open, cur, realPnl: +(((cur - t.entry) * (t.qty || 1))).toFixed(2) };
    }), [trades, market, periodFrom]);
  const closedRows = autoRows.filter((t) => !t.open);
  const periodStats = { pnl: autoRows.reduce((a, t) => a + t.realPnl, 0), trades: autoRows.length, wins: closedRows.filter((t) => t.realPnl > 0).length };
  const autoPnl = periodStats.pnl;
  const autoWinRate = closedRows.length ? closedRows.filter((t) => t.realPnl > 0).length / closedRows.length * 100 : 0;
  const periodLabel = plPeriod === "today" ? "today" : plPeriod === "month" ? "this month" : "last 12 months";

  return (
    <div>
      {/* Global markets live strip */}
      <GlobalStrip />

      {/* Portfolio / Auto-Buy dashboard card */}
      <div className="card glow metal" style={{ marginTop: 14, padding: 16, border: "none", background: "var(--feature-grad)", color: "#fff", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "relative" }}>
          {/* slider */}
          <div className="pill" style={{ display: "inline-flex", background: "rgba(0,0,0,.28)", padding: 3, marginBottom: 14 }}>
            {[["total", "Total"], ["auto", "Auto Buy"]].map(([k, l]) => (
              <button key={k} onClick={() => setDashView(k)} className="pill tap disp" style={{ padding: "6px 16px", fontSize: 12, fontWeight: 800, border: "none", background: dashView === k ? "#fff" : "transparent", color: dashView === k ? "#141416" : "rgba(255,255,255,.8)" }}>{l}</button>
            ))}
          </div>

          {dashView === "total" ? (
            <div onClick={onGoPortfolio} className="tap">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, opacity: .85 }}>Current value</span>
                <span className="pill" style={{ fontSize: 11, fontWeight: 700, background: "rgba(255,255,255,.16)", padding: "4px 10px", display: "flex", alignItems: "center", gap: 4 }}>My Portfolio <ChevronRight size={13} /></span>
              </div>
              <div className="mono" style={{ fontWeight: 800, fontSize: 27, marginTop: 2 }}>{fmt(dash.val, "IN")}</div>
              <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                <DashStat k="Returns %" v={(retPct >= 0 ? "+" : "") + retPct.toFixed(2) + "%"} pos={retPct >= 0} />
                <DashStat k="Net returns" v={(net >= 0 ? "+" : "") + fmt(net, "IN")} pos={net >= 0} />
              </div>
              {portfolio.length === 0 && <div style={{ fontSize: 11.5, opacity: .8, marginTop: 10 }}>No holdings yet — buy your first stock in Virtual Trade.</div>}
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, opacity: .85 }}>Auto-Buy · {MKT_LABEL[market]}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div className="pill" style={{ display: "inline-flex", background: "rgba(0,0,0,.28)", padding: 2 }}>
                    {[["today", "Today"], ["month", "Month"], ["lifetime", "Lifetime"]].map(([k, l]) => (
                      <button key={k} onClick={() => setPlPeriod(k)} className="pill tap disp" style={{ padding: "5px 10px", fontSize: 10, fontWeight: 800, border: "none", background: plPeriod === k ? "#fff" : "transparent", color: plPeriod === k ? "#141416" : "rgba(255,255,255,.8)" }}>{l}</button>
                    ))}
                  </div>
                  <label className="tap" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700 }}>
                    {autoOn ? "On" : "Off"}
                    <span onClick={() => setAutoOnMap((m) => ({ ...m, [market]: !m[market] }))} style={{ width: 38, height: 22, borderRadius: 999, background: autoOn ? "#22C55E" : "rgba(255,255,255,.3)", position: "relative", transition: "background .2s", flexShrink: 0 }}>
                      <span style={{ position: "absolute", top: 2, left: autoOn ? 18 : 2, width: 18, height: 18, borderRadius: 999, background: "#fff", transition: "left .2s" }} />
                    </span>
                  </label>
                </div>
              </div>
              <div style={{ fontSize: 10, opacity: .7, marginTop: 2 }}>P&amp;L · {periodLabel} {autoOn ? "· live positions (real exits)" : "· simulated preview"}</div>
              <div className="mono" style={{ fontWeight: 800, fontSize: 27, marginTop: 3, color: autoPnl >= 0 ? "#9CFFD6" : "#FFB3BE" }}>{(autoPnl >= 0 ? "+" : "") + fmt(autoPnl, aggCur)}</div>
              <div style={{ fontSize: 11, opacity: .85 }}>{`${periodStats.trades} trades · ${autoWinRate.toFixed(0)}% win rate · ${CUR[aggCur]}${(capNum / 1000).toFixed(0)}k capital`}</div>

              <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
                <DashStat k="Trades" v={periodStats.trades} pos={true} />
                <DashStat k="Win rate" v={autoWinRate.toFixed(0) + "%"} pos={autoWinRate >= 50} />
                <DashStat k="Capital" v={fmt(capNum, aggCur)} pos={true} />
              </div>

              {/* capital */}
              <div style={{ marginTop: 12, background: "rgba(0,0,0,.25)", borderRadius: 12, padding: "8px 12px" }}>
                <div style={{ fontSize: 9.5, opacity: .8, fontWeight: 700 }}>CAPITAL TO DEPLOY ({CUR[aggCur]})</div>
                <input value={deployCapital} onChange={(e) => setDeployCapital(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="100000" className="no-ring mono" style={{ width: "100%", background: "transparent", border: "none", color: "#fff", fontSize: 17, fontWeight: 800, marginTop: 2 }} />
              </div>

              {/* Positions — REAL. Planned entries when Auto-Buy is off; live/closed
                  positions (with real P&L) once it is on. Nothing is simulated. */}
              <button onClick={() => setShowTrades((v) => !v)} className="tap disp" style={{ width: "100%", marginTop: 12, background: "rgba(255,255,255,.12)", color: "#fff", border: "1px solid rgba(255,255,255,.22)", borderRadius: 12, padding: 11, fontWeight: 800, fontSize: 12.5, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
                {showTrades ? "Hide positions" : (autoOn ? `Show Positions (${autoRows.length})` : `Show Today's Plan (${autoTrades.length})`)}<ChevronRight size={15} style={{ transform: showTrades ? "rotate(-90deg)" : "rotate(90deg)", transition: "transform .2s" }} />
              </button>

              {showTrades && (autoOn ? (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  {autoRows.length === 0 && <div style={{ fontSize: 11.5, opacity: .82, lineHeight: 1.6 }}>No auto-buy positions in this period yet. Positions are placed at real market prices and closed by the exit engine when a target or stop is actually hit.</div>}
                  {autoRows.map((t) => (
                    <div key={t.id} style={{ background: "rgba(0,0,0,.22)", borderRadius: 12, padding: "10px 12px" }}>
                      <div onClick={() => { const st = ALL.find((a) => a.sym === t.sym); st && onOpen(st); }} className="tap" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <span className="disp" style={{ fontWeight: 800, fontSize: 12.5 }}>{t.sym} <span style={{ fontSize: 10, opacity: .7, fontWeight: 600 }}>×{t.qty}</span></span>
                        <span style={{ fontSize: 9.5, opacity: .85, fontWeight: 800 }}>{t.open ? "● OPEN" : t.exitType}</span>
                        <span className="mono" style={{ fontWeight: 800, fontSize: 13, color: t.realPnl >= 0 ? "#9CFFD6" : "#FFB3BE" }}>{t.realPnl >= 0 ? "+" : ""}{fmt(t.realPnl, t.market || "IN")}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 10, opacity: .82 }}>
                        <div><div style={{ opacity: .7 }}>Entry</div><div className="mono" style={{ fontWeight: 700 }}>{fmt(t.entry, t.market || "IN")}</div><div style={{ opacity: .7 }}>{t.entryAt ? new Date(t.entryAt).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</div></div>
                        <div style={{ textAlign: "right" }}><div style={{ opacity: .7 }}>{t.open ? "Current" : "Exit"}</div><div className="mono" style={{ fontWeight: 700 }}>{fmt(t.cur, t.market || "IN")}</div><div style={{ opacity: .7 }}>{t.open ? "position open" : new Date(t.exitAt).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div></div>
                      </div>
                      {(t.tp || t.sl) && <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.12)", fontSize: 10.5, fontWeight: 700 }}>🎯 Target <span style={{ color: "#9CFFD6" }}>+{t.tp}%</span> · 🛑 Stop <span style={{ color: "#FFB3BE" }}>−{t.sl}%</span></div>}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 11, opacity: .8, lineHeight: 1.5 }}>Today's plan — these are the picks Auto-Buy would enter at the live price, with the target/stop it would arm. Turn Auto-Buy on to place them for real.</div>
                  {autoTrades.map((t) => (
                    <div key={t.sym} style={{ background: "rgba(0,0,0,.22)", borderRadius: 12, padding: "10px 12px" }}>
                      <div onClick={() => { const st = ALL.find((a) => a.sym === t.sym); st && onOpen(st); }} className="tap" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <span className="disp" style={{ fontWeight: 800, fontSize: 12.5 }}>{t.sym} <span style={{ fontSize: 10, opacity: .7, fontWeight: 600 }}>×{t.qty}</span></span>
                        <span className="mono" style={{ fontWeight: 800, fontSize: 13 }}>{fmt(t.entry, t.m)}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.12)" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700 }}>🎯 Target <span style={{ color: "#9CFFD6" }}>+{t.tpPct}%</span> · 🛑 Stop <span style={{ color: "#FFB3BE" }}>−{t.slPct}%</span>{autoOverrides[t.sym] ? " · edited" : ""}</span>
                        <button onClick={() => setEditSym(editSym === t.sym ? null : t.sym)} className="tap" style={{ border: "none", background: "rgba(255,255,255,.14)", borderRadius: 8, padding: 6, display: "grid", placeItems: "center", color: "#fff" }}><Pencil size={12} /></button>
                      </div>
                      {editSym === t.sym && (
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <div style={{ flex: 1, background: "rgba(0,0,0,.3)", borderRadius: 10, padding: "6px 9px" }}>
                            <div style={{ fontSize: 8.5, opacity: .8, fontWeight: 700 }}>TARGET %</div>
                            <input defaultValue={t.tpPct} onChange={(e) => setOv(t, "tp", e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="no-ring mono" style={{ width: "100%", background: "transparent", border: "none", color: "#fff", fontSize: 13, fontWeight: 800 }} />
                          </div>
                          <div style={{ flex: 1, background: "rgba(0,0,0,.3)", borderRadius: 10, padding: "6px 9px" }}>
                            <div style={{ fontSize: 8.5, opacity: .8, fontWeight: 700 }}>STOP %</div>
                            <input defaultValue={t.slPct} onChange={(e) => setOv(t, "sl", e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="no-ring mono" style={{ width: "100%", background: "transparent", border: "none", color: "#fff", fontSize: 13, fontWeight: 800 }} />
                          </div>
                          <button onClick={() => setEditSym(null)} className="tap disp" style={{ alignSelf: "stretch", border: "none", background: "#fff", color: "#141416", borderRadius: 10, padding: "0 14px", fontWeight: 800, fontSize: 12 }}>Done</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {profile && (
        <div className="card metal" style={{ marginTop: 14, padding: 14, background: "var(--feature-grad)", border: "none", color: "#fff" }}>
          <div style={{ fontSize: 12, opacity: .9 }}>Tuned for you</div>
          <div className="disp" style={{ fontWeight: 700, fontSize: 15, marginTop: 2 }}>{profile.style} investor · {profile.risk} risk</div>
          <div style={{ fontSize: 12, opacity: .92, marginTop: 4 }}>Picks below are weighted toward {profile.caps.join(", ") || "all caps"}{profile.sectors.length ? ` and ${profile.sectors.join(", ")}` : ""}.</div>
        </div>
      )}

      {/* Matrix picks */}
      <Section title="Matrix's Picks" icon={<Sparkles size={17} color="var(--primary-2)" />}>
        <div className="hide-scroll" style={{ display: "flex", gap: 13, overflowX: "auto", paddingBottom: 8, paddingTop: 2 }}>
          {picks.map((s) => (
            <div key={s.sym} onClick={() => onOpen(s)} className="card tap glow metal" style={{ flex: "0 0 auto", width: 272, padding: 0, position: "relative", overflow: "hidden", border: "none", background: "var(--feature-grad)" }}>
              <div style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 80% at 0% 0%, rgba(255,255,255,.18), transparent 45%)", pointerEvents: "none" }} />
              {/* + BUYS the stock (1 unit / 1 lot for futures), arming the pick's real SL & target */}
              <button onClick={(e) => { e.stopPropagation(); onBuy && onBuy(s, s.isFut ? (s.lot || 1) : 1, { tp: s.pickTpPct, sl: s.pickSlPct, tradeType: "Manual" }); }} className="tap" title="Buy" style={{ position: "absolute", top: 12, right: 12, width: 30, height: 30, borderRadius: 10, border: "1px solid rgba(255,255,255,.3)", background: "rgba(255,255,255,.14)", color: "#fff", display: "grid", placeItems: "center", zIndex: 2 }}>
                <Plus size={17} />
              </button>
              <div style={{ padding: 17, position: "relative", color: "#fff" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>💎</span>
                  <div style={{ minWidth: 0 }}><div className="disp" style={{ fontWeight: 700, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.sym}</div><div style={{ fontSize: 11, color: "rgba(255,255,255,.7)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div></div>
                  {s.isFut && <span className="pill disp" style={{ marginLeft: "auto", fontSize: 9.5, fontWeight: 800, padding: "3px 9px", background: "rgba(255,255,255,.18)", color: "#fff", whiteSpace: "nowrap" }}>FUT · {s.expiry}</span>}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
                  <span className="mono" style={{ fontWeight: 800, fontSize: 19 }}>{fmt(s.price, market)}</span>
                  <span style={{ fontSize: 10.5, color: "rgba(255,255,255,.75)", fontWeight: 700 }}>{(s.chg >= 0 ? "▲ +" : "▼ ") + s.chg.toFixed(2) + "%"}{s.isFut ? ` · lot ${s.lot}` : ""}</span>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="pill" style={{ fontSize: 10, fontWeight: 800, background: "rgba(255,255,255,.18)", color: "#fff", padding: "3px 9px" }}>⚡ {s.pickSignal}</span>
                  {s.volRatio > 1.3 && <span className="pill" style={{ fontSize: 9.5, fontWeight: 800, background: "rgba(255,255,255,.14)", color: "#fff", padding: "3px 8px" }}>vol {s.volRatio}×</span>}
                </div>
                {/* REAL stop / target from support-resistance + ATR */}
                {s.pickTarget != null && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <div style={{ flex: 1, background: "rgba(0,0,0,.24)", borderRadius: 10, padding: "7px 9px" }}>
                      <div style={{ fontSize: 8.5, opacity: .8, fontWeight: 700 }}>TARGET</div>
                      <div className="mono" style={{ fontWeight: 800, fontSize: 12.5, color: "#9CFFD6" }}>{fmt(s.pickTarget, market)} <span style={{ fontSize: 9, opacity: .85 }}>+{s.pickTpPct}%</span></div>
                    </div>
                    <div style={{ flex: 1, background: "rgba(0,0,0,.24)", borderRadius: 10, padding: "7px 9px" }}>
                      <div style={{ fontSize: 8.5, opacity: .8, fontWeight: 700 }}>STOP</div>
                      <div className="mono" style={{ fontWeight: 800, fontSize: 12.5, color: "#FFB3BE" }}>{fmt(s.pickStop, market)} <span style={{ fontSize: 9, opacity: .85 }}>−{s.pickSlPct}%</span></div>
                    </div>
                    {s.pickRR != null && <div style={{ flex: "0 0 auto", background: "rgba(0,0,0,.24)", borderRadius: 10, padding: "7px 9px", display: "grid", placeItems: "center" }}>
                      <div style={{ fontSize: 8.5, opacity: .8, fontWeight: 700 }}>R:R</div>
                      <div className="mono" style={{ fontWeight: 800, fontSize: 12.5 }}>{s.pickRR}</div>
                    </div>}
                  </div>
                )}
                <div style={{ marginTop: 10, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.18)", fontSize: 12, color: "rgba(255,255,255,.92)", lineHeight: 1.55, display: "flex", gap: 6 }}>
                  <Sparkles size={14} color="#fff" style={{ flex: "0 0 auto", marginTop: 2 }} /><span>{s.pickReason || ""}</span>
                </div>
                <div style={{ marginTop: 12 }}><VerdictTag v={s.verdict} /></div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Market updates summary */}
      <Pop style={{ marginTop: 22 }}>
        <div className="card" style={{ padding: 15 }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 13.5, display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}><Newspaper size={15} color="var(--primary)" /> Market updates</div>
          <MarketBrief market={market} list={list} />
        </div>
      </Pop>

      {/* Ideas carousel (not for F&O or Commodity) */}
      {market !== "FNO" && market !== "Commodity" && <StockIdeasStrip onOpen={onOpen} onBuy={onBuy} market={market} />}

      {/* F&O Picks (Indian derivatives) */}

      {/* Market pulse strip — not for Commodity */}
      {market !== "Commodity" && <MarketPulseStrip market={market} list={list} onOpen={onOpen} />}

      {/* Trending — not for Commodity; F&O shows ATM options */}
      {market !== "Commodity" && (
        <Section title="Trending now" icon={<TrendingUp size={17} color="#0FB97D" />}>
          <div className="hide-scroll" style={{ display: "flex", gap: 10, overflowX: "auto" }}>
            {trendingView.map((s) => <MiniRow key={s.sym} s={s} market={market} onOpen={onOpen} watched={watch.includes(s.sym)} toggleWatch={toggleWatch} />)}
          </div>
        </Section>
      )}

      {/* Screener — not for F&O or Commodity */}
      {market !== "FNO" && market !== "Commodity" && (
        <Pop style={{ marginTop: 40 }}>
          <Screener onOpen={onOpen} market={market} list={list} watchlists={watchlists} addToWatch={addToWatch} createWatchlist={createWatchlist} />
        </Pop>
      )}

      {/* Gainers / Losers — not for F&O or Commodity */}
      {market !== "FNO" && market !== "Commodity" && (
        <Section title="Top gainers & losers" icon={<Zap size={17} color="#E8A33D" />}
          right={
            <div className="pill" style={{ display: "flex", background: "var(--elev)", border: "1px solid var(--line)", padding: 3 }}>
              {["Gainers", "Losers"].map((m) => (
                <button key={m} onClick={() => setGlMode(m)} className="pill tap disp" style={{ padding: "5px 13px", fontSize: 11.5, fontWeight: 700, border: "none", background: glMode === m ? (m === "Gainers" ? "var(--up)" : "var(--down)") : "transparent", color: glMode === m ? "var(--on-primary)" : "var(--muted)" }}>{m}</button>
              ))}
            </div>
          }>
          <div className="card" style={{ padding: "4px 14px" }}>
            {(glMode === "Gainers" ? gainers : losers).map((s) => <ListRow key={s.sym} s={s} market={market} onOpen={onOpen} watched={watch.includes(s.sym)} toggleWatch={toggleWatch} />)}
          </div>
        </Section>
      )}

      {/* Most traded — carousel; F&O shows ATM options */}
      <Section title="Most traded" icon={<Activity size={17} color="var(--primary)" />}>
        <div className="hide-scroll" style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
          {tradedView.map((s) => (
            <CarouselCard key={s.sym} s={s} market={market} onOpen={onOpen} width={210} watched={watch.includes(s.sym)} toggleWatch={toggleWatch}>
              <div style={{ marginTop: 10, background: "var(--bg)", borderRadius: 12, padding: "8px 11px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 600 }}>{market === "FNO" ? "OI" : "Volume"}</span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{compact(market === "FNO" ? (s.oi || s.vol) : s.vol)}</span>
              </div>
            </CarouselCard>
          ))}
        </div>
      </Section>

      {/* In the news — REAL headlines fetched live (not for F&O) */}
      {market !== "FNO" && <LiveNewsStrip symbols={inNews.map((s) => s.sym)} onOpen={onOpen} list={list} />}

      {/* Smart money — REAL institutional holders from Yahoo (quoteSummary).
          Hidden entirely when no holder data is available: no invented names. */}
      {market !== "FNO" && market !== "Commodity" && smart.length > 0 && (
        <Section title="Smart Money picks" icon={<Building2 size={17} color="var(--primary)" />}>
          <div className="hide-scroll" style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
            {smart.map((s) => (
              <CarouselCard key={s.sym} s={s} market={market} onOpen={onOpen} width={260} watched={watch.includes(s.sym)} toggleWatch={toggleWatch}>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                  {s.inst.slice(0, 3).map((it, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg)", borderRadius: 12, padding: "9px 11px", gap: 8 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.n}</span>
                      <span style={{ flex: "0 0 auto", textAlign: "right" }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 800, display: "block" }}>{it.pct != null ? it.pct + "%" : "—"}</span>
                        {it.c != null && <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, color: it.c >= 0 ? "var(--up)" : "var(--down)" }}>{it.c >= 0 ? "+" : ""}{it.c}%</span>}
                      </span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 9.5, color: "var(--muted)", marginTop: 8 }}>% of shares held by institution · latest filing</div>
              </CarouselCard>
            ))}
          </div>
        </Section>
      )}
      <div style={{ textAlign: "center", fontSize: 10.5, color: "var(--muted)", margin: "26px 0 6px" }}>Live market data · Virtual money · Educational research, not financial advice</div>
    </div>
  );
}

/* ============================== SCREENER ============================== */
const METRICS = [["chg", "Day change %"], ["price", "Price"], ["rsi", "RSI"], ["macd", "MACD"], ["adx", "ADX"], ["cci", "CCI"], ["stoch", "Stochastic %K"], ["mfi", "MFI"], ["atr", "ATR"], ["vwap", "VWAP"], ["ema20", "EMA 20"], ["ema50", "EMA 50"], ["sma50", "SMA 50 (50-DMA)"], ["sma200", "SMA 200 (200-DMA)"], ["bbPctB", "Bollinger %B"], ["vol", "Volume"], ["pe", "P/E"], ["revGrowth", "Revenue growth %"], ["ebitdaGrowth", "EBITDA growth %"], ["roe", "ROE %"]];
const OPS = [[">", ">"], ["<", "<"], [">=", "≥"], ["<=", "≤"]];
// Parse a plain-English screen into sector/cap filters + numeric conditions.
function parseScreen(text) {
  const t = " " + text.toLowerCase() + " ";
  const res = { sectors: [], caps: [], conds: [], dma: false, note: [] };
  if (/\b(it|information technology|software|tech|semiconductor)\b/.test(t)) { res.sectors.push("it", "software", "semiconductor", "tech", "it services"); res.note.push("IT/Tech sector"); }
  if (/\bpharma|healthcare|drug\b/.test(t)) { res.sectors.push("pharma", "healthcare"); res.note.push("Pharma"); }
  if (/\bbank|banking\b/.test(t)) { res.sectors.push("bank"); res.note.push("Banking"); }
  if (/\bfmcg|consumer\b/.test(t)) { res.sectors.push("fmcg", "consumer"); res.note.push("FMCG/Consumer"); }
  if (/\bauto|automobile\b/.test(t)) { res.sectors.push("auto"); res.note.push("Auto"); }
  if (/\benergy|oil|power\b/.test(t)) { res.sectors.push("energy", "utilities"); res.note.push("Energy"); }
  if (/\bmetal|steel|mining\b/.test(t)) { res.sectors.push("metal"); res.note.push("Metals"); }
  if (/large[\s-]?cap|\blarge\b/.test(t)) { res.caps.push("Large"); res.note.push("Large cap"); }
  if (/mid[\s-]?cap|\bmid\b/.test(t)) { res.caps.push("Mid"); res.note.push("Mid cap"); }
  if (/small[\s-]?cap|\bsmall\b/.test(t)) { res.caps.push("Small"); res.note.push("Small cap"); }
  let m;
  if ((m = t.match(/rsi\s*(?:>|greater than|more than|above|over)\s*(\d+)/))) { res.conds.push({ m: "rsi", o: ">", v: +m[1] }); res.note.push(`RSI > ${m[1]}`); }
  if ((m = t.match(/rsi\s*(?:<|less than|under|below)\s*(\d+)/))) { res.conds.push({ m: "rsi", o: "<", v: +m[1] }); res.note.push(`RSI < ${m[1]}`); }
  if ((m = t.match(/p\/?e\s*(?:<|less than|under|below)\s*(\d+)/))) { res.conds.push({ m: "pe", o: "<", v: +m[1] }); res.note.push(`P/E < ${m[1]}`); }
  if ((m = t.match(/p\/?e\s*(?:>|more than|above|over)\s*(\d+)/))) { res.conds.push({ m: "pe", o: ">", v: +m[1] }); res.note.push(`P/E > ${m[1]}`); }
  if ((m = t.match(/roe\s*(?:>|more than|above|over)\s*(\d+)/))) { res.conds.push({ m: "roe", o: ">", v: +m[1] }); res.note.push(`ROE > ${m[1]}`); }
  // technical indicators (same set as the automate module)
  const indKV = [["adx", "adx"], ["cci", "cci"], ["mfi", "mfi"], ["atr", "atr"], ["vwap", "vwap"], ["macd", "macd"], ["stochastic", "stoch"], ["stoch", "stoch"], ["ema20", "ema20"], ["ema 20", "ema20"], ["ema50", "ema50"], ["ema 50", "ema50"], ["50 dma", "sma50"], ["50-dma", "sma50"], ["sma50", "sma50"], ["200 dma", "sma200"], ["200-dma", "sma200"], ["sma200", "sma200"], ["bollinger", "bbPctB"], ["volume", "vol"]];
  indKV.forEach(([kw, field]) => {
    let mm;
    if ((mm = t.match(new RegExp(kw + "\\s*(?:>|greater than|more than|above|over)\\s*(\\d+\\.?\\d*)")))) { res.conds.push({ m: field, o: ">", v: +mm[1] }); res.note.push(`${kw.toUpperCase()} > ${mm[1]}`); }
    if ((mm = t.match(new RegExp(kw + "\\s*(?:<|less than|under|below)\\s*(\\d+\\.?\\d*)")))) { res.conds.push({ m: field, o: "<", v: +mm[1] }); res.note.push(`${kw.toUpperCase()} < ${mm[1]}`); }
  });
  if ((m = t.match(/price\s*(?:>|above|over|more than)\s*(\d+\.?\d*)/))) { res.conds.push({ m: "price", o: ">", v: +m[1] }); res.note.push(`Price > ${m[1]}`); }
  if ((m = t.match(/price\s*(?:<|below|under|less than)\s*(\d+\.?\d*)/))) { res.conds.push({ m: "price", o: "<", v: +m[1] }); res.note.push(`Price < ${m[1]}`); }
  if ((m = t.match(/(?:change|gain|up|return)\s*(?:>|above|over|more than)\s*(\d+\.?\d*)\s*%?/))) { res.conds.push({ m: "chg", o: ">", v: +m[1] }); res.note.push(`Change > ${m[1]}%`); }
  if (/ebi?tda\s*(?:positive|>\s*0|is positive)|positive\s*ebi?tda/.test(t)) { res.conds.push({ m: "ebitdaGrowth", o: ">", v: 0 }); res.note.push("EBITDA positive"); }
  if (/rising revenue|revenue growth|growing revenue|revenue rising|sales growth|revenue growing/.test(t)) { res.conds.push({ m: "revGrowth", o: ">", v: 0 }); res.note.push("Revenue rising"); }
  if ((/\bdma\b|\bsma\b|moving average/.test(t) && /50/.test(t) && /(100|200)/.test(t)) || /golden cross/.test(t)) { res.dma = true; res.note.push("50-DMA > 200-DMA"); }
  return res;
}
const SCREEN_TFS = [["3m", "3 min"], ["5m", "5 min"], ["15m", "15 min"], ["30m", "30 min"], ["1h", "1 hour"], ["1d", "1 day"]];
const TF_ADJ = { "3m": 0.99, "5m": 0.995, "15m": 1.0, "30m": 1.005, "1h": 1.01, "1d": 1.0 };
// Deterministic per-timeframe value for an indicator field (sim: same base, tf-seeded wobble).
function indAt(s, field, tf) {
  const base = s[field];
  if (base == null || isNaN(base)) return base;
  if (!tf || tf === "1d") return base;
  const r = lcg(hash(s.sym + "|" + field + "|" + tf))();
  return +(base * ((TF_ADJ[tf] || 1) + (r - 0.5) * 0.04)).toFixed(4);
}
function matchScreen(list, res) {
  return list.filter((s) => {
    if (res.sectors.length && !res.sectors.some((sec) => (s.sector || "").toLowerCase().includes(sec))) return false;
    if (res.caps.length && !res.caps.includes(s.cap)) return false;
    if (res.dma && !(s.sma50 > s.sma200)) return false;
    return res.conds.every((c) => { const x = s[c.m]; if (x == null || isNaN(x)) return false; return c.o === ">" ? x > c.v : c.o === "<" ? x < c.v : c.o === ">=" ? x >= c.v : x <= c.v; });
  });
}
function Screener({ onOpen, market, list, watchlists, addToWatch, createWatchlist }) {
  const [filters, setFilters] = useState([{ m: "rsi", o: ">", rhsType: "value", v: "50", rhs: "sma50", tf: "1d" }]);
  const [text, setText] = useState("");
  const [results, setResults] = useState(null);
  const [parsedNote, setParsedNote] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const recommended = [
    { label: "Momentum movers", f: [{ m: "rsi", o: ">", v: "60" }, { m: "chg", o: ">", v: "1" }] },
    { label: "Value with growth", f: [{ m: "pe", o: "<", v: "30" }, { m: "revGrowth", o: ">", v: "8" }] },
    { label: "Oversold bounce", f: [{ m: "rsi", o: "<", v: "35" }] },
    { label: "EMA 21 > EMA 50", f: [{ m: "ema20", o: ">", rhsType: "indicator", rhs: "ema50", tf: "1d" }] },
  ];
  const [selRec, setSelRec] = useState(null);
  const cmp = (o, x, y) => o === ">" ? x > y : o === "<" ? x < y : o === ">=" ? x >= y : o === "<=" ? x <= y : Math.abs(x - y) < 1e-6;
  const apply = (fs) => {
    const ok = list.filter((s) => fs.every((f) => {
      const x = indAt(s, f.m, f.tf);
      const y = f.rhsType === "indicator" ? indAt(s, f.rhs, f.tf) : parseFloat(f.v);
      if (x == null || isNaN(x) || y == null || isNaN(y)) return true;
      return cmp(f.o, x, y);
    }));
    setResults(ok);
  };
  const runScreener = async () => {
    if (text.trim()) {
      setSelRec(null);
      const res = parseScreen(text);
      if (res.sectors.length || res.caps.length || res.conds.length || res.dma) {
        setParsedNote("Applied: " + res.note.join(" · "));
        setResults(matchScreen(list, res));
        return;
      }
      // Fallback: ask the LLM (Groq) to interpret the plain text into conditions.
      setAiBusy(true); setParsedNote("Asking Matrix to interpret…");
      const conds = await aiInterpretScreen(text);
      setAiBusy(false);
      if (conds && conds.length) {
        setFilters(conds);
        setParsedNote("AI interpreted: " + conds.map((c) => `${c.m} ${c.o} ${c.rhsType === "indicator" ? c.rhs : c.v}${c.tf && c.tf !== "1d" ? " · " + c.tf : ""}`).join(" · "));
        apply(conds);
      } else {
        setParsedNote("Couldn't understand — try the builder above, or e.g. 'EMA21 > EMA50 with RSI > 60 on 15m'. (AI interpretation needs the backend + a Groq key.)");
        setResults([]);
      }
    } else { setParsedNote(null); apply(filters); }
  };
  const upd = (i, k, val) => setFilters((p) => p.map((f, j) => j === i ? { ...f, [k]: val } : f));
  return (
    <div className="mx fade">
      <div className="disp" style={{ fontWeight: 700, fontSize: 20, marginTop: 6 }}>Screener</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>Build rules from technicals, fundamentals or events.</div>

      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", margin: "16px 2px 8px" }}>Recommended</div>
      <div className="hide-scroll" style={{ display: "flex", gap: 8, overflowX: "auto" }}>
        {recommended.map((r) => (
          <button key={r.label} onClick={() => { setFilters(r.f); setText(""); setParsedNote(null); setSelRec(r.label); apply(r.f); }} className="pill tap" style={{ flex: "0 0 auto", border: "1px solid " + (selRec === r.label ? "var(--primary)" : "var(--line)"), background: selRec === r.label ? "var(--primary)" : "var(--surface)", color: selRec === r.label ? "var(--on-primary)" : "var(--ink)", fontSize: 12.5, fontWeight: selRec === r.label ? 800 : 600, padding: "9px 14px" }}>{r.label}</button>
        ))}
      </div>

      <div className="card" style={{ marginTop: 16, padding: 14 }}>
        <div className="disp" style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Build your own</div>
        {filters.map((f, i) => (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 9, marginBottom: 8, background: "var(--elev)" }}>
            <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
              <select value={f.m} onChange={(e) => upd(i, "m", e.target.value)} style={{ ...selStyle, flex: 1, minWidth: 0 }}>{METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select value={f.o} onChange={(e) => upd(i, "o", e.target.value)} style={{ ...selStyle, flex: "0 0 54px" }}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              {(f.rhsType || "value") === "value"
                ? <input value={f.v} onChange={(e) => upd(i, "v", e.target.value)} style={{ ...selStyle, flex: "0 0 70px" }} className="no-ring" placeholder="value" />
                : <select value={f.rhs || "sma50"} onChange={(e) => upd(i, "rhs", e.target.value)} style={{ ...selStyle, flex: 1, minWidth: 0 }}>{METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
              <button onClick={() => setFilters((p) => p.filter((_, j) => j !== i))} className="tap" style={{ border: "none", background: "transparent", flex: "0 0 auto" }}><Trash2 size={16} color="var(--down)" /></button>
            </div>
            <div style={{ display: "flex", gap: 7, alignItems: "center", marginTop: 7 }}>
              <div className="pill" style={{ display: "inline-flex", background: "var(--surface)", border: "1px solid var(--line)", padding: 2 }}>
                {[["value", "vs value"], ["indicator", "vs indicator"]].map(([k, l]) => (
                  <button key={k} onClick={() => upd(i, "rhsType", k)} className="pill tap" style={{ padding: "5px 9px", fontSize: 10, fontWeight: 800, border: "none", background: (f.rhsType || "value") === k ? "var(--primary)" : "transparent", color: (f.rhsType || "value") === k ? "var(--on-primary)" : "var(--muted)" }}>{l}</button>
                ))}
              </div>
              <span style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 700, marginLeft: "auto" }}>TF</span>
              <select value={f.tf || "1d"} onChange={(e) => upd(i, "tf", e.target.value)} style={{ ...selStyle, flex: "0 0 88px" }}>{SCREEN_TFS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </div>
          </div>
        ))}
        <button onClick={() => setFilters((p) => [...p, { m: "ema20", o: ">", rhsType: "indicator", rhs: "ema50", tf: "1d", v: "" }])} className="tap" style={{ border: "1px dashed var(--line)", background: "transparent", borderRadius: 12, padding: "8px 12px", fontSize: 12.5, fontWeight: 600, color: "var(--primary)", display: "flex", gap: 5, alignItems: "center" }}><Plus size={15} /> Add condition</button>

        <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>Or describe it in plain text</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. large-cap IT stocks with RSI under 40 and rising revenue" className="no-ring"
          style={{ width: "100%", marginTop: 6, border: "1px solid var(--line)", borderRadius: 12, padding: 11, fontSize: 13, minHeight: 60, resize: "vertical" }} />

        <button onClick={runScreener} disabled={aiBusy} className="tap disp" style={{ width: "100%", marginTop: 12, background: "var(--primary)", color: "var(--on-primary)", border: "none", borderRadius: 14, padding: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, opacity: aiBusy ? 0.6 : 1 }}><Filter size={16} /> {aiBusy ? "Interpreting…" : "Run screener"}</button>
        {parsedNote && <div style={{ fontSize: 11, color: parsedNote.startsWith("Applied") ? "var(--up)" : "var(--amber)", marginTop: 8, fontWeight: 600, lineHeight: 1.5 }}>{parsedNote.startsWith("Applied") ? "✓ " : "⚠ "}{parsedNote}</div>}
      </div>

      {results && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{results.length} match{results.length !== 1 ? "es" : ""}</div>
          <div className="card" style={{ padding: "4px 12px" }}>
            {results.length === 0 ? <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No stocks match these rules. Try loosening a filter.</div>
              : results.map((s) => (
                <div key={s.sym} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}><ListRow s={s} market={market} onOpen={onOpen} /></div>
                  {addToWatch && <WatchAddButton sym={s.sym} watchlists={watchlists} onAdd={addToWatch} onCreate={createWatchlist} />}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
const selStyle = { flex: 1, border: "1px solid var(--line)", borderRadius: 10, padding: "9px 8px", fontSize: 12.5, background: "var(--surface)", color: "var(--ink)" };

/* ============================== VIRTUAL TRADE ============================== */
function TradeView({ walletMap, adjustWallet, portfolio, setPortfolio, preset, market, recordTrade }) {
  const [sel, setSel] = useState(preset || ALL[0]);
  const [qty, setQty] = useState(1);
  const [side, setSide] = useState("Buy");
  const [ordType, setOrdType] = useState("Market");
  const [limitPx, setLimitPx] = useState("");
  const [sl, setSl] = useState(""); const [tsl, setTsl] = useState(""); const [tp, setTp] = useState("");
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (preset) setSel(preset); }, [preset]);
  const m = marketOf(sel.sym);
  const wallet = walletMap[m] ?? 1000000;
  const holding = portfolio.find((p) => p.sym === sel.sym);
  useEffect(() => { if (side === "Sell" && !holding) setSide("Buy"); }, [sel, holding, side]);
  const needsPx = ordType === "Limit" || ordType === "Stop-limit";
  const execPx = needsPx && limitPx !== "" && !isNaN(+limitPx) ? +limitPx : sel.price;
  const cost = execPx * qty;
  const risk = { ...(sl !== "" ? { sl: +sl } : {}), ...(tsl !== "" ? { tsl: +tsl } : {}), ...(tp !== "" ? { tp: +tp } : {}), ordType };
  const exec = () => {
    if (side === "Buy") {
      if (cost > wallet) { setMsg({ t: `Not enough funds in your ${MKT_LABEL[m] || m} wallet.`, e: true }); return; }
      adjustWallet(m, -cost);
      setPortfolio((p) => {
        const ex = p.find((h) => h.sym === sel.sym);
        if (ex) { const tq = ex.qty + qty; return p.map((h) => h.sym === sel.sym ? { ...h, qty: tq, buy: (h.buy * h.qty + cost) / tq, ...risk } : h); }
        return [...p, { sym: sel.sym, name: sel.name, qty, buy: execPx, date: Date.now(), ...risk }];
      });
      setMsg({ t: `${ordType} buy: ${qty} ${sel.sym} @ ${fmt(execPx, m)}${sl || tsl || tp ? " · risk orders set" : ""}.`, e: false });
      recordTrade && recordTrade({ sym: sel.sym, name: sel.name, entry: execPx, entryAt: Date.now(), exit: null, exitAt: null, pnl: null, qty, market: m, tradeType: "Manual", exitType: "Open" });
    } else {
      if (!holding || holding.qty < qty) { setMsg({ t: "You don't hold enough units to sell.", e: true }); return; }
      adjustWallet(m, +cost);
      recordTrade && recordTrade({ sym: sel.sym, name: sel.name, entry: holding.buy, entryAt: holding.date, exit: execPx, exitAt: Date.now(), pnl: +((execPx - holding.buy) * qty).toFixed(2), qty, market: m, tradeType: "Manual", exitType: "Manual" });
      setPortfolio((p) => p.map((h) => h.sym === sel.sym ? { ...h, qty: h.qty - qty } : h).filter((h) => h.qty > 0));
      setMsg({ t: `Sold ${qty} ${sel.sym} at ${fmt(execPx, m)} — credited to wallet.`, e: false });
    }
    setQty(1);
  };
  return (
    <div className="mx fade">
      <div className="disp" style={{ fontWeight: 700, fontSize: 20, marginTop: 6 }}>Virtual Trade</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Practice with {fmt(wallet, "IN")} virtual cash. Zero real risk.</div>

      <div className="card" style={{ marginTop: 16, padding: 16 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>Instrument</div>
        <select value={sel.sym} onChange={(e) => setSel(ALL.find((a) => a.sym === e.target.value))} style={{ ...selStyle, width: "100%", marginTop: 6, fontSize: 14, padding: 12 }}>
          {ALL.map((a) => <option key={a.sym} value={a.sym}>{a.sym} — {a.name}</option>)}
        </select>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 12 }}>
          <span className="mono" style={{ fontWeight: 700, fontSize: 22 }}>{fmt(sel.price, m)}</span><Change v={sel.chg} big />
        </div>

        <div className="pill" style={{ display: "flex", background: "var(--bg)", padding: 4, marginTop: 14 }}>
          {["Buy", "Sell"].map((x) => {
            const disabled = x === "Sell" && !holding;
            return (
              <button key={x} disabled={disabled} onClick={() => !disabled && setSide(x)} className="pill tap disp" title={disabled ? "You can only sell stocks you hold" : ""} style={{ flex: 1, padding: 10, border: "none", fontWeight: 700, fontSize: 13.5, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, background: side === x ? (x === "Buy" ? "var(--up)" : "var(--down)") : "transparent", color: side === x ? "var(--on-primary)" : "var(--muted)" }}>{x}</button>
            );
          })}
        </div>
        {!holding && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>Sell is available only for instruments you already hold.</div>}

        {/* order type */}
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginTop: 14 }}>Order type</div>
        <div className="hide-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", marginTop: 6 }}>
          {["Market", "Limit", "Stop-limit", "Trailing-stop"].map((x) => (
            <button key={x} onClick={() => setOrdType(x)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "8px 13px", fontSize: 12, fontWeight: 700, border: "1px solid " + (ordType === x ? "var(--primary)" : "var(--line)"), background: ordType === x ? "var(--primary)" : "var(--surface)", color: ordType === x ? "var(--on-primary)" : "var(--ink)" }}>{x}</button>
          ))}
        </div>
        {needsPx && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>{ordType === "Stop-limit" ? "Trigger / limit price" : "Limit price"} ({CUR[m] || "₹"})</div>
            <input value={limitPx} onChange={(e) => setLimitPx(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder={String(sel.price)} className="no-ring mono" style={{ width: "100%", marginTop: 4, border: "1px solid var(--line)", borderRadius: 10, padding: 10, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" }} />
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Quantity</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="tap" style={qBtn}>–</button>
            <input value={qty} onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))} className="no-ring mono" style={{ width: 56, textAlign: "center", border: "1px solid var(--line)", borderRadius: 10, padding: 8, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" }} />
            <button onClick={() => setQty((q) => q + 1)} className="tap" style={qBtn}>+</button>
          </div>
        </div>
        {holding && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>You hold {holding.qty} units @ avg {fmt(holding.buy, m)}</div>}

        {/* risk orders */}
        <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginTop: 14 }}>Risk orders (optional, %)</div>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          {[["Stop loss", sl, setSl], ["Trailing SL", tsl, setTsl], ["Take profit", tp, setTp]].map(([lbl, val, setter]) => (
            <div key={lbl} style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 10, padding: "7px 9px", background: "var(--elev)" }}>
              <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700 }}>{lbl} %</div>
              <input value={val} onChange={(e) => setter(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="—" className="no-ring mono" style={{ width: "100%", background: "transparent", border: "none", color: "var(--ink)", fontWeight: 800, fontSize: 14, marginTop: 2 }} />
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 14 }}>
          <span style={{ color: "var(--muted)" }}>Order value</span><span className="mono" style={{ fontWeight: 700 }}>{fmt(cost, m)}</span>
        </div>
        <button onClick={exec} className="tap disp glow" style={{ width: "100%", marginTop: 14, background: side === "Buy" ? "linear-gradient(120deg,var(--up),#0EA968)" : "linear-gradient(120deg,var(--down),#D93A4E)", color: "#fff", border: "none", borderRadius: 14, padding: 14, fontWeight: 800, fontSize: 15 }}>{side} {sel.sym} · {ordType}</button>
        {msg && <div style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: msg.e ? "var(--down)" : "var(--up)", textAlign: "center" }}>{msg.t}</div>}
      </div>
    </div>
  );
}
const qBtn = { width: 34, height: 34, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface)", fontSize: 18, fontWeight: 700, color: "var(--ink)" };

/* ============================== PORTFOLIO ============================== */
function Portfolio({ portfolio, wallet, market = "IN", onGoHome, onBuy, onSell, onUpdate, priceSnap = {} }) {
  const [expand, setExpand] = useState(null);   // sym with open trade panel
  const mkt = market === "FNO" ? "IN" : market;
  const mLabel = { IN: "🇮🇳 Indian", US: "🇺🇸 US", Crypto: "₿ Crypto", FNO: "⚡ F&O", Commodity: "🪙 Commodity" }[market];
  // F&O portfolio shows only F&O (futures/options) positions — never plain stock holdings
  const rows = portfolio.filter((h) => market === "FNO" ? h.fno : (marketOf(h.sym) === mkt && !h.fno)).map((h) => {
    const m = marketOf(h.sym);
    const cur = priceSnap[h.sym] != null ? priceSnap[h.sym] : h.buy;   // frozen until next buy/sell
    const inv = h.buy * h.qty, val = cur * h.qty;
    const pl = val - inv, plp = (cur / h.buy - 1) * 100;
    const days = Math.max(1, Math.round((Date.now() - h.date) / 86400000)) || 1;
    return { ...h, m, cur, inv, val, pl, plp, days };
  });
  const totalVal = rows.reduce((a, r) => a + r.val, 0);
  const totalInv = rows.reduce((a, r) => a + r.inv, 0);
  const totalPL = totalVal - totalInv;
  return (
    <div className="mx fade">
      <div className="disp" style={{ fontWeight: 700, fontSize: 20, marginTop: 6 }}>Virtual Portfolio</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 1 }}>{mLabel} holdings</div>
      <div className="card metal" style={{ marginTop: 12, padding: 16, background: "var(--feature-grad)", border: "none", color: "#fff" }}>
        <div style={{ fontSize: 12, opacity: .8 }}>Holdings value</div>
        <div className="mono" style={{ fontWeight: 700, fontSize: 28, marginTop: 2 }}>{fmt(totalVal, mkt)}</div>
        <div style={{ display: "flex", gap: 18, marginTop: 10, fontSize: 12.5 }}>
          <div><div style={{ opacity: .7 }}>Cash</div><div className="mono" style={{ fontWeight: 700 }}>{fmt(wallet, "IN")}</div></div>
          <div><div style={{ opacity: .7 }}>Invested</div><div className="mono" style={{ fontWeight: 700 }}>{fmt(totalInv, mkt)}</div></div>
          <div><div style={{ opacity: .7 }}>Total P/L</div><div className="mono" style={{ fontWeight: 700, color: totalPL >= 0 ? "#5CF0B5" : "#FF8FA0" }}>{totalPL >= 0 ? "+" : ""}{fmt(totalPL, mkt)}</div></div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: 30, textAlign: "center", color: "var(--muted)" }}>
          <Briefcase size={28} color="var(--muted)" /><div style={{ marginTop: 8, fontSize: 13.5 }}>{market === "FNO" ? "No F&O positions. Futures & options you trade will show here — stock holdings stay under their own market." : `No ${mLabel} holdings yet. Buy from this market, or switch markets from the tabs above.`}</div>
          <button onClick={() => onGoHome && onGoHome()} className="tap disp glow" style={{ marginTop: 16, background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "var(--on-primary)", border: "none", borderRadius: 14, padding: "12px 22px", fontWeight: 800, fontSize: 13.5, display: "inline-flex", gap: 7, alignItems: "center" }}><Home size={16} /> Go to Home</button>
        </div>
      ) : rows.map((r) => {
        const st = ALL.find((a) => a.sym === r.sym) || { sym: r.sym, name: r.name, price: r.cur };
        return (
          <div key={r.sym} className="card" style={{ marginTop: 12, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div><div className="disp" style={{ fontWeight: 700, fontSize: 14 }}>{r.sym}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{r.qty} units · held {r.days}d</div></div>
              <div style={{ textAlign: "right" }}>
                <div className="mono" style={{ fontWeight: 700, fontSize: 14, color: r.pl >= 0 ? "var(--up)" : "var(--down)" }}>{r.pl >= 0 ? "+" : ""}{fmt(r.pl, r.m)}</div>
                <div className="mono" style={{ fontSize: 12, color: r.pl >= 0 ? "var(--up)" : "var(--down)" }}>{r.plp >= 0 ? "+" : ""}{r.plp.toFixed(2)}%</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 11.5 }}>
              <Stat k="Buy" v={fmt(r.buy, r.m)} /><Stat k="Current" v={fmt(r.cur, r.m)} /><Stat k="Invested" v={fmt(r.inv, r.m)} />
            </div>
            {(r.sl || r.tsl || r.tp) && <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8, fontWeight: 600, display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
              <span className="pill" style={{ fontSize: 9, fontWeight: 800, padding: "2px 7px", background: "var(--up-soft)", color: "var(--up)" }}>● ARMED</span>
              {r.tp ? `🎯 TP +${r.tp}% ` : ""}{r.sl ? `· 🛑 SL −${r.sl}% ` : ""}{r.tsl ? `· 🔻 TSL ${r.tsl}%` : ""}
              <span style={{ opacity: .8 }}>· auto-sells when hit</span>
            </div>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={() => setExpand(expand === r.sym ? null : r.sym)} className="tap disp" style={{ flex: 1, background: expand === r.sym ? "var(--primary)" : "var(--surface)", color: expand === r.sym ? "var(--on-primary)" : "var(--ink)", border: "1px solid var(--line)", borderRadius: 11, padding: 11, fontWeight: 800, fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", justifyContent: "center" }}><SlidersHorizontal size={13} /> {expand === r.sym ? "Close" : "Manage · Buy / Sell"}</button>
            </div>
            {expand === r.sym && <ManageHolding r={r} st={st} onBuy={onBuy} onSell={onSell} onUpdate={onUpdate} onClose={() => setExpand(null)} />}
          </div>
        );
      })}
    </div>
  );
}
function ManageHolding({ r, st, onBuy, onSell, onUpdate, onClose }) {
  const [buyQty, setBuyQty] = useState(1);
  const [sellQty, setSellQty] = useState(1);
  const [sl, setSl] = useState(r.sl ? String(r.sl) : "");
  const [tsl, setTsl] = useState(r.tsl ? String(r.tsl) : "");
  const [tp, setTp] = useState(r.tp ? String(r.tp) : "");
  const saveRisk = () => { onUpdate && onUpdate(r.sym, { sl: sl === "" ? undefined : +sl, tsl: tsl === "" ? undefined : +tsl, tp: tp === "" ? undefined : +tp }); onClose && onClose(); };
  const stepper = (val, setter, max) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
      <button onClick={() => setter((q) => Math.max(1, q - 1))} className="tap" style={{ ...qBtn, width: 30, height: 30, fontSize: 16 }}>–</button>
      <input value={val} onChange={(e) => setter(Math.max(1, Math.min(max || 9999, parseInt(e.target.value) || 1)))} className="no-ring mono" style={{ width: 44, textAlign: "center", border: "1px solid var(--line)", borderRadius: 9, padding: 6, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" }} />
      <button onClick={() => setter((q) => Math.min(max || 9999, q + 1))} className="tap" style={{ ...qBtn, width: 30, height: 30, fontSize: 16 }}>+</button>
    </div>
  );
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      {/* Buy more */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {stepper(buyQty, setBuyQty)}
        <button onClick={() => { onBuy && onBuy(st, buyQty); }} className="tap disp" style={{ flex: 1, background: "linear-gradient(120deg,var(--up),#0EA968)", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontWeight: 800, fontSize: 13 }}>Buy more · {buyQty}</button>
      </div>
      {/* Sell */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
        {stepper(sellQty, setSellQty, r.qty)}
        <button onClick={() => { onSell && onSell(st, sellQty); onClose && onClose(); }} className="tap disp" style={{ flex: 1, background: "linear-gradient(120deg,var(--down),#D93A4E)", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontWeight: 800, fontSize: 13 }}>Sell · {sellQty}</button>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 7 }}>You hold {r.qty} units · sell up to {r.qty}.</div>
      <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, margin: "12px 0 6px" }}>Risk orders (%)</div>
      <div style={{ display: "flex", gap: 8 }}>
        {[["Stop loss", sl, setSl], ["Trailing SL", tsl, setTsl], ["Take profit", tp, setTp]].map(([lbl, val, setter]) => (
          <div key={lbl} style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 10, padding: "7px 9px", background: "var(--elev)" }}>
            <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700 }}>{lbl} %</div>
            <input value={val} onChange={(e) => setter(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="—" className="no-ring mono" style={{ width: "100%", background: "transparent", border: "none", color: "var(--ink)", fontWeight: 800, fontSize: 14, marginTop: 2 }} />
          </div>
        ))}
      </div>
      <button onClick={saveRisk} className="tap disp" style={{ width: "100%", marginTop: 12, background: "var(--primary)", color: "var(--on-primary)", border: "none", borderRadius: 11, padding: 10, fontWeight: 800, fontSize: 12.5 }}>Save risk orders</button>
    </div>
  );
}
function Stat({ k, v, c }) { return <div><div style={{ color: "var(--muted)" }}>{k}</div><div className="mono" style={{ fontWeight: 700, color: c || "var(--ink)" }}>{v}</div></div>; }

/* ============================== WATCHLIST ============================== */
function WatchlistView({ watchlists, activeWl, setActiveWl, createWatchlist, deleteWatchlist, toggleWatch, onOpen }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const active = watchlists.find((w) => w.id === activeWl) || watchlists[0];
  const items = (active?.syms || []).map((sym) => ALL.find((a) => a.sym === sym)).filter(Boolean);
  const submit = () => { createWatchlist(name); setName(""); setAdding(false); };
  return (
    <div className="mx fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <div className="disp" style={{ fontWeight: 700, fontSize: 20 }}>Watchlists</div>
        <button onClick={() => setAdding(!adding)} className="tap pill disp glow" style={{ background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "#fff", border: "none", padding: "8px 14px", fontWeight: 700, fontSize: 12.5, display: "flex", gap: 5, alignItems: "center" }}><Plus size={15} /> New list</button>
      </div>

      {adding && (
        <div className="card" style={{ marginTop: 12, padding: 12, display: "flex", gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Watchlist name (e.g. High Beta)" className="no-ring" style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 12, padding: "10px 12px", fontSize: 13.5, background: "var(--surface)" }} />
          <button onClick={submit} className="tap disp" style={{ background: "var(--primary)", color: "#fff", border: "none", borderRadius: 12, padding: "0 16px", fontWeight: 700 }}>Create</button>
        </div>
      )}

      {/* list chips */}
      <div className="hide-scroll" style={{ display: "flex", gap: 8, overflowX: "auto", marginTop: 14, paddingBottom: 2 }}>
        {watchlists.map((w) => (
          <button key={w.id} onClick={() => setActiveWl(w.id)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "8px 14px", fontWeight: 700, fontSize: 12.5, border: "1px solid " + (w.id === activeWl ? "var(--primary)" : "var(--line)"), background: w.id === activeWl ? "var(--primary)" : "var(--surface)", color: w.id === activeWl ? "var(--on-primary)" : "var(--ink)", display: "flex", alignItems: "center", gap: 7 }}>
            {w.name} <span style={{ opacity: .8, fontSize: 11 }}>{w.syms.length}</span>
          </button>
        ))}
      </div>

      {active && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 2px 4px" }}>
          <span className="disp" style={{ fontWeight: 700, fontSize: 15 }}>{active.name}</span>
          {watchlists.length > 1 && (
            <button onClick={() => deleteWatchlist(active.id)} className="tap" style={{ border: "1px solid var(--line)", background: "var(--surface)", borderRadius: 10, padding: "5px 10px", fontSize: 11.5, fontWeight: 700, color: "var(--down)", display: "flex", gap: 4, alignItems: "center" }}><Trash2 size={13} /> Delete list</button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="card" style={{ marginTop: 10, padding: 30, textAlign: "center", color: "var(--muted)" }}>
          <Star size={28} color="var(--muted)" /><div style={{ marginTop: 8, fontSize: 13.5 }}>This list is empty. Tap the + on any stock to add it here.</div>
        </div>
      ) : items.map((s) => {
        const m = marketOf(s.sym);
        return (
          <div key={s.sym} onClick={() => onOpen(s)} className="card tap" style={{ marginTop: 12, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><div className="disp" style={{ fontWeight: 700, fontSize: 14 }}>{s.sym}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{s.name}</div></div>
              <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 10 }}>
                <div><div className="mono" style={{ fontWeight: 700, fontSize: 14 }}>{fmt(s.price, m)}</div><Change v={s.chg} /></div>
                <button onClick={(e) => { e.stopPropagation(); toggleWatch(s.sym); }} className="tap" title="Remove" style={{ width: 28, height: 28, borderRadius: 9, border: "1px solid var(--line)", background: "var(--elev)", color: "var(--down)", display: "grid", placeItems: "center" }}><X size={15} /></button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--primary)", marginTop: 8, display: "flex", gap: 5 }}><Sparkles size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />{s.pickReason || ""}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================== IDEAS ============================== */
// Ideas are regenerated daily from the strongest technical setups across markets.
function buildDailyIdeas() {
  const r = lcg(DAY * 257 + 3);
  const handles = ["@arjun_trades", "@nisha.fno", "@swingpro", "@chartwiz", "@priya.charts"];
  const pool = ALL.filter((s) => s.sector !== "Volatility" && s.sector !== "Index");
  const scored = pool.map((s) => ({ s, t: techSignal(s) }))
    .sort((a, b) => b.t.score - a.t.score)
    .slice(0, 16)
    .filter(() => r() > 0.25)
    .slice(0, 9);
  return scored.map(({ s, t }, i) => {
    const entry = +s.price.toFixed(2);
    const target = +(entry * (1 + 0.05 + r() * 0.14)).toFixed(2);
    const stop = +(entry * (1 - 0.03 - r() * 0.04)).toFixed(2);
    const gain = +((target / entry - 1) * 100).toFixed(1);
    const by = i % 3 === 0 ? "Matrix" : handles[i % handles.length];
    const tradeType = marketOf(s.sym) === "IN" && r() > 0.6 ? "F&O" : "Stock";
    return {
      by, sym: s.sym, entry, exit: target, stop, gain, pattern: t.pattern, tradeType,
      logic: `${t.why} ${s.price > s.sma50 ? "Trading above the 50-DMA" : "Reclaiming key moving averages"}; RSI ${s.rsi}, MACD ${s.macd >= 0 ? "positive" : "negative"} — confirmed on 5m / 15m / 1D.`,
    };
  });
}
const SEED_IDEAS = buildDailyIdeas();
const PATTERNS = {
  cup: { label: "Cup & Handle", pts: [[0, 28], [9, 32], [18, 50], [30, 62], [44, 64], [58, 62], [68, 50], [76, 34], [82, 28], [88, 40], [93, 34], [100, 14]] },
  triangle: { label: "Ascending Triangle", pts: [[0, 56], [12, 28], [24, 50], [40, 30], [56, 48], [72, 32], [86, 44], [100, 14]] },
  flag: { label: "Bull Flag", pts: [[0, 64], [16, 18], [28, 30], [40, 40], [52, 30], [64, 42], [76, 32], [88, 42], [100, 10]] },
  breakout: { label: "Breakout", pts: [[0, 50], [12, 44], [24, 54], [36, 42], [48, 52], [60, 44], [72, 38], [82, 28], [100, 8]] },
  doubleBottom: { label: "Double Bottom", pts: [[0, 30], [14, 56], [26, 38], [38, 58], [52, 42], [62, 56], [74, 36], [88, 22], [100, 10]] },
};
function PatternChart({ type }) {
  const P = PATTERNS[type] || PATTERNS.breakout;
  const H = 84, W = 100, pad = 6;
  const yOf = (v) => H - pad - (v / 70) * (H - 2 * pad);
  const line = P.pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${yOf(p[1]).toFixed(1)}`).join(" ");
  const area = `${line} L100 ${H} L0 ${H} Z`;
  const entryV = P.pts[Math.floor(P.pts.length * 0.7)][1];
  const targetV = P.pts[P.pts.length - 1][1];
  const id = "pg" + type;
  return (
    <div style={{ position: "relative", marginTop: 12, borderRadius: 14, overflow: "hidden", border: "1px solid var(--line)", background: "var(--bg)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="96" preserveAspectRatio="none" style={{ display: "block" }}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7C6CFF" stopOpacity="0.45" /><stop offset="100%" stopColor="#7C6CFF" stopOpacity="0" /></linearGradient></defs>
        <line x1="0" x2={W} y1={yOf(targetV)} y2={yOf(targetV)} stroke="#1FE08C" strokeWidth="0.7" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        <line x1="0" x2={W} y1={yOf(entryV)} y2={yOf(entryV)} stroke="#A99BFF" strokeWidth="0.7" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="#A99BFF" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <span className="pill" style={{ position: "absolute", top: 8, left: 8, fontSize: 10, fontWeight: 800, background: "rgba(124,108,255,.9)", color: "#fff", padding: "3px 9px" }}>📈 {P.label}</span>
      <span style={{ position: "absolute", top: 8, right: 8, fontSize: 9.5, fontWeight: 800, color: "#1FE08C", background: "var(--surface)", padding: "2px 7px", borderRadius: 8 }}>Target</span>
      <span style={{ position: "absolute", bottom: 8, right: 8, fontSize: 9.5, fontWeight: 800, color: "var(--primary-2)", background: "var(--surface)", padding: "2px 7px", borderRadius: 8 }}>Entry</span>
    </div>
  );
}
// Resolve an idea to a realized outcome by simulating a price path from entry and
// checking whether the TARGET or STOP was touched first. If neither, it's still open.
function ideaResult(idea) {
  const entry = idea.entry, target = idea.exit;
  const stop = idea.stop != null ? idea.stop : +(entry * 0.94).toFixed(2);
  const seed = hash(idea.sym + idea.by + entry);
  const r = lcg(seed + 1);
  const N = 70;
  let p = entry, closed = null;
  for (let i = 1; i <= N; i++) {
    const vol = entry * 0.022;
    const drift = entry * 0.0013; // mild upward bias
    p = p + drift + (r() - 0.5) * vol * 2;
    if (p >= target) { closed = { win: true, ret: (target / entry - 1) * 100, reason: "Target", bars: i }; break; }
    if (p <= stop) { closed = { win: false, ret: (stop / entry - 1) * 100, reason: "Stop", bars: i }; break; }
  }
  const daysAgo = Math.floor(lcg(seed + 9)() * 360);
  const type = idea.tradeType || "Stock", mkt = marketOf(idea.sym);
  if (!closed) return { status: "open", ret: (p / entry - 1) * 100, daysAgo, type, mkt, stop };
  return { status: "closed", win: closed.win, ret: closed.ret, reason: closed.reason, bars: closed.bars, daysAgo, type, mkt, stop };
}
function IdeasDashboard({ ideas }) {
  const [by, setBy] = useState("Matrix");
  const [type, setType] = useState("All");
  const [mkt, setMkt] = useState("All");
  const [range, setRange] = useState(365);
  const [cap, setCap] = useState(100000);
  const [symF, setSymF] = useState("All");
  const all = ideas.map((id) => ({ id, o: ideaResult(id) }))
    .filter(({ id, o }) =>
      (by === "All" || (by === "Matrix" ? id.by === "Matrix" : id.by !== "Matrix")) &&
      (type === "All" || o.type === type) &&
      (mkt === "All" || o.mkt === mkt) &&
      (symF === "All" || id.sym === symF) &&
      o.daysAgo <= range);
  const closed = all.filter((r) => r.o.status === "closed"); // realized only
  const openN = all.length - closed.length;
  const n = closed.length;
  const wins = closed.filter((r) => r.o.win).length;
  const losses = n - wins;
  const avg = n ? closed.reduce((a, r) => a + r.o.ret, 0) / n : 0;
  const total = (closed.reduce((a, r) => a * (1 + r.o.ret / 100), 1) - 1) * 100;
  const netPnl = cap * (total / 100);
  const winRate = n ? (wins / n) * 100 : 0;
  const sel = { ...selStyle, flex: "1 1 0", minWidth: 0, padding: "8px 6px", fontSize: 11.5 };
  const Stat = ({ k, v, c }) => (
    <div style={{ flex: "1 1 30%", minWidth: 88, background: "rgba(255,255,255,.1)", borderRadius: 12, padding: "9px 11px" }}>
      <div style={{ fontSize: 9.5, opacity: .85, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em" }}>{k}</div>
      <div className="mono" style={{ fontWeight: 800, fontSize: 14.5, marginTop: 2, color: c || "#fff" }}>{v}</div>
    </div>
  );
  return (
    <div className="card glow metal" style={{ marginTop: 14, padding: 16, border: "none", background: "var(--feature-grad)", color: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="disp" style={{ fontWeight: 700, fontSize: 15 }}>Ideas Dashboard</div>
        <span style={{ fontSize: 10.5, opacity: .85 }}>realized · last {range >= 365 ? "12 months" : range + "d"}</span>
      </div>
      <div className="mono" style={{ fontWeight: 800, fontSize: 26, marginTop: 6 }}>{netPnl >= 0 ? "+" : ""}{fmt(netPnl, "IN")}</div>
      <div style={{ fontSize: 11, opacity: .85, marginTop: -2 }}>Net realized P&amp;L on {fmt(cap, "IN")} deployed · {openN} still open</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <Stat k="Returns %" v={(avg >= 0 ? "+" : "") + avg.toFixed(2) + "%"} c={avg >= 0 ? "#9CFFD6" : "#FFB3BE"} />
        <Stat k="Win rate" v={n ? winRate.toFixed(0) + "%" : "—"} />
        <Stat k="Win / Loss" v={wins + " : " + losses} />
        <Stat k="Trades" v={n} />
      </div>
      <div style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap" }}>
        <select value={by} onChange={(e) => setBy(e.target.value)} style={sel}><option value="Matrix">Posted by: Matrix</option><option value="All">Posted by: All</option><option value="Community">Posted by: Community</option></select>
        <select value={type} onChange={(e) => setType(e.target.value)} style={sel}><option value="All">Type: All</option><option value="Stock">Stock</option><option value="F&O">F&amp;O</option></select>
        <select value={mkt} onChange={(e) => setMkt(e.target.value)} style={sel}><option value="All">Market: All</option><option value="IN">Indian</option><option value="US">US</option><option value="Crypto">Crypto</option></select>
        <select value={range} onChange={(e) => setRange(+e.target.value)} style={sel}><option value={30}>30d</option><option value={90}>3m</option><option value={180}>6m</option><option value={365}>12m</option></select>
        <select value={cap} onChange={(e) => setCap(+e.target.value)} style={sel}><option value={50000}>Capital: ₹50k</option><option value={100000}>Capital: ₹1L</option><option value={500000}>Capital: ₹5L</option><option value={1000000}>Capital: ₹10L</option></select>
        <select value={symF} onChange={(e) => setSymF(e.target.value)} style={sel}><option value="All">Symbol: All</option>{ALL.map((a) => <option key={a.sym} value={a.sym}>{a.sym}</option>)}</select>
      </div>
    </div>
  );
}
function Ideas({ onOpen, onBuy, market = "IN" }) {
  const [ideas, setIdeas] = useState(SEED_IDEAS);
  const [draft, setDraft] = useState({ sym: "NIFTY50", entry: "", exit: "", logic: "", pattern: "breakout" });
  const [open, setOpen] = useState(false);
  const mkt = market === "FNO" ? "IN" : market;
  const shown = market === "FNO" ? [] : ideas.filter((i) => marketOf(i.sym) === mkt);
  const post = () => {
    if (!draft.entry || !draft.exit || !draft.logic) return;
    const g = ((parseFloat(draft.exit) / parseFloat(draft.entry) - 1) * 100);
    setIdeas((p) => [{ by: "You", sym: draft.sym, entry: +draft.entry, exit: +draft.exit, gain: +g.toFixed(1), pattern: draft.pattern, logic: draft.logic }, ...p]);
    setDraft({ sym: "NIFTY50", entry: "", exit: "", logic: "", pattern: "breakout" }); setOpen(false);
  };
  return (
    <div className="mx fade">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <div><div className="disp" style={{ fontWeight: 700, fontSize: 20 }}>Ideas</div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>{{ IN: "🇮🇳 Indian", US: "🇺🇸 US", Crypto: "₿ Crypto", FNO: "⚡ F&O", Commodity: "🪙 Commodity" }[market]}</div></div>
        <button onClick={() => setOpen(!open)} className="tap pill disp glow" style={{ background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "#fff", border: "none", padding: "8px 14px", fontWeight: 700, fontSize: 12.5, display: "flex", gap: 5, alignItems: "center" }}><Plus size={15} /> Post idea</button>
      </div>

      <IdeasDashboard ideas={shown} />
      {market === "FNO" && <div className="card" style={{ marginTop: 12, padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>Ideas aren't available for F&O. Switch to a stock market (Indian / US) to see trade ideas.</div>}
      {open && (
        <div className="card" style={{ marginTop: 12, padding: 14 }}>
          <select value={draft.sym} onChange={(e) => setDraft({ ...draft, sym: e.target.value })} style={{ ...selStyle, width: "100%" }}>{ALL.map((a) => <option key={a.sym} value={a.sym}>{a.sym} — {a.name}</option>)}</select>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input placeholder="Entry" value={draft.entry} onChange={(e) => setDraft({ ...draft, entry: e.target.value })} className="no-ring" style={{ ...selStyle }} />
            <input placeholder="Exit" value={draft.exit} onChange={(e) => setDraft({ ...draft, exit: e.target.value })} className="no-ring" style={{ ...selStyle }} />
          </div>
          <select value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} style={{ ...selStyle, width: "100%", marginTop: 8 }}>{Object.entries(PATTERNS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          <textarea placeholder="Logic — chart pattern, catalyst, levels…" value={draft.logic} onChange={(e) => setDraft({ ...draft, logic: e.target.value })} className="no-ring" style={{ width: "100%", marginTop: 8, border: "1px solid var(--line)", borderRadius: 12, padding: 11, fontSize: 13, minHeight: 54 }} />
          <button onClick={post} className="tap disp" style={{ width: "100%", marginTop: 10, background: "var(--primary)", color: "#fff", border: "none", borderRadius: 12, padding: 12, fontWeight: 700 }}>Publish idea</button>
        </div>
      )}
      {market !== "FNO" && shown.length === 0 && <div className="card" style={{ marginTop: 12, padding: 16, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No ideas for this market yet. Post one, or switch markets from the tabs above.</div>}
      {shown.map((idea, i) => {
        const s = ALL.find((a) => a.sym === idea.sym); const m = marketOf(idea.sym);
        return (
          <div key={i} className="card" style={{ marginTop: 12, padding: 15 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="pill" style={{ background: idea.by === "Matrix" ? "var(--primary-soft)" : "var(--bg)", color: idea.by === "Matrix" ? "var(--primary)" : "var(--ink-soft)", fontSize: 11, fontWeight: 700, padding: "3px 9px" }}>{idea.by === "Matrix" ? "✦ Matrix" : idea.by}</span>
                <span onClick={() => s && onOpen(s)} className="disp tap" style={{ fontWeight: 700, fontSize: 14 }}>{idea.sym}</span>
              </div>
              <span className="pill disp" style={{ background: "var(--up-soft)", color: "var(--up)", fontWeight: 700, fontSize: 12.5, padding: "4px 11px" }}>+{idea.gain}% potential</span>
            </div>
            <div style={{ marginTop: 10 }}><MiniCandles sym={idea.sym} price={s ? s.price : idea.entry} chg={s ? s.chg : 0} height={120} staticChart defaultTf={m === "Crypto" ? "1h" : "1d"} pattern={idea.pattern} /></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, gap: 8 }}>
              <div><div style={{ fontSize: 10, color: "var(--muted)" }}>Entry</div><div className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{fmt(idea.entry, m)}</div></div>
              <div><div style={{ fontSize: 10, color: "var(--muted)" }}>Current</div><div className="mono" style={{ fontWeight: 800, fontSize: 13 }}>{fmt(s ? s.price : idea.entry, m)}</div></div>
              <div><div style={{ fontSize: 10, color: "var(--muted)" }}>Target</div><div className="mono" style={{ fontWeight: 700, fontSize: 13 }}>{fmt(idea.exit, m)}</div></div>
              <div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "var(--muted)" }}>Potential left</div>{(() => { const cur = s ? s.price : idea.entry; const pl = (idea.exit - cur) / cur * 100; return <div className="mono" style={{ fontWeight: 800, fontSize: 13, color: pl >= 0 ? "var(--up)" : "var(--muted)" }}>{pl >= 0 ? "+" + pl.toFixed(1) + "%" : "target hit"}</div>; })()}</div>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 10, lineHeight: 1.55 }}>{idea.logic}</div>
            {s && onBuy && <button onClick={() => onBuy(s, 1)} className="tap disp" style={{ width: "100%", marginTop: 12, background: "linear-gradient(120deg,var(--up),#0EA968)", color: "#fff", border: "none", borderRadius: 12, padding: 12, fontWeight: 800, fontSize: 13.5, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}><Plus size={16} /> Buy Now</button>}
          </div>
        );
      })}
    </div>
  );
}

/* ============================== BACKTEST ENGINE ============================== */
function SMAarr(a, p) { const o = Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function EMAarr(a, p) { const o = Array(a.length).fill(NaN); const k = 2 / (p + 1); let prev = a[0]; o[0] = a[0]; for (let i = 1; i < a.length; i++) { prev = a[i] * k + prev * (1 - k); o[i] = prev; } return o; }
function RSIarr(a, p) { const o = Array(a.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; o[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l)); } } else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; o[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l)); } } return o; }
function MACDarr(a) { const e12 = EMAarr(a, 12), e26 = EMAarr(a, 26); const line = a.map((_, i) => e12[i] - e26[i]); const signal = EMAarr(line, 9); const hist = line.map((v, i) => v - signal[i]); return { line, signal, hist }; }
function BBarr(a, p) { const mid = SMAarr(a, p); const upper = Array(a.length).fill(NaN), lower = Array(a.length).fill(NaN); for (let i = p - 1; i < a.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += (a[j] - mid[i]) ** 2; const sd = Math.sqrt(s / p); upper[i] = mid[i] + 2 * sd; lower[i] = mid[i] - 2 * sd; } return { upper, middle: mid, lower }; }
function CCIarr(c, p) { const tp = c.map((x) => (x.h + x.l + x.c) / 3); const sma = SMAarr(tp, p); const o = Array(c.length).fill(NaN); for (let i = p - 1; i < c.length; i++) { let md = 0; for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - sma[i]); md /= p; o[i] = md === 0 ? 0 : (tp[i] - sma[i]) / (0.015 * md); } return o; }
function ATRarr(c, p) { const tr = c.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))); return EMAarr(tr, p); }
function VWAParr(c) { let pv = 0, vv = 0; return c.map((x) => { const tp = (x.h + x.l + x.c) / 3, v = x.v || 1; pv += tp * v; vv += v; return pv / vv; }); }
function ADXarr(c, p) {
  const n = c.length, pDM = Array(n).fill(0), mDM = Array(n).fill(0), tr = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    pDM[i] = up > dn && up > 0 ? up : 0; mDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  const atr = EMAarr(tr, p), pdi = EMAarr(pDM, p).map((v, i) => 100 * v / (atr[i] || 1)), mdi = EMAarr(mDM, p).map((v, i) => 100 * v / (atr[i] || 1));
  const dx = pdi.map((v, i) => { const s = v + mdi[i]; return s ? 100 * Math.abs(v - mdi[i]) / s : 0; });
  return EMAarr(dx, p);
}
const CF = { open: "o", high: "h", low: "l", close: "c" };
function rollExt(c, len, field, max) { const o = Array(c.length).fill(NaN); for (let i = 0; i < c.length; i++) { let v = c[i][field]; for (let j = Math.max(0, i - len + 1); j <= i; j++) v = max ? Math.max(v, c[j][field]) : Math.min(v, c[j][field]); o[i] = v; } return o; }
function resolveOperand(op, defs, c, closes, vols, cache) {
  if (op in cache) return cache[op];
  let series;
  if (op !== "" && !isNaN(Number(op))) { const n = Number(op); series = closes.map(() => n); }
  else if (op === "Price") series = closes;
  else if (op === "Volume") series = vols;
  else {
    const [nm, attr] = op.split(".");
    const d = (defs || []).find((x) => x.name === nm);
    if (!d) series = closes.map(() => NaN);
    else {
      const len = Number(d.len) || 14;
      switch (d.type) {
        case "EMA": series = EMAarr(closes, len); break;
        case "SMA": series = SMAarr(closes, len); break;
        case "RSI": series = RSIarr(closes, len); break;
        case "CCI": series = CCIarr(c, len); break;
        case "ATR": series = ATRarr(c, len); break;
        case "VWAP": series = VWAParr(c); break;
        case "MACD": { const m = MACDarr(closes); series = m[attr || "line"]; break; }
        case "BB": { const b = BBarr(closes, len); series = b[attr || "middle"]; break; }
        case "KC": { const mid = EMAarr(closes, len), at = ATRarr(c, len); series = attr === "upper" ? mid.map((v, i) => v + 1.5 * at[i]) : attr === "lower" ? mid.map((v, i) => v - 1.5 * at[i]) : mid; break; }
        case "ADX": series = ADXarr(c, len); break;
        case "DMA": series = SMAarr(closes, len); break;
        case "Volume": series = vols; break;
        case "CurrentCandle": case "CurrentDay": { const f = CF[attr] || "c"; series = c.map((x) => x[f]); break; }
        case "PrevCandle": case "PrevDay": { const f = CF[attr] || "c"; series = c.map((x, i) => i > 0 ? c[i - 1][f] : NaN); break; }
        case "LastNCandles": { const f = CF[attr] || "c"; series = attr === "high" ? rollExt(c, len, "h", true) : attr === "low" ? rollExt(c, len, "l", false) : c.map((x, i) => (i - len + 1 >= 0 ? c[i - len + 1][f] : x[f])); break; }
        case "FirstNCandles": { const f = CF[attr] || "c"; const head = c.slice(0, Math.max(1, len)); const val = attr === "high" ? Math.max(...head.map((x) => x.h)) : attr === "low" ? Math.min(...head.map((x) => x.l)) : (attr === "open" ? head[0].o : head[head.length - 1].c); series = closes.map(() => val); break; }
        default: series = closes.map(() => NaN);
      }
    }
  }
  cache[op] = series; return series;
}
function evalCond(cond, i, get) {
  const L = get(cond.la), R = cond.bType === "num" ? null : get(cond.b);
  const lv = L[i], rv = cond.bType === "num" ? Number(cond.b) : R[i];
  const plv = L[i - 1], prv = cond.bType === "num" ? Number(cond.b) : (R ? R[i - 1] : NaN);
  if (lv == null || rv == null || isNaN(lv) || isNaN(rv)) return false;
  switch (cond.op) {
    case ">": return lv > rv; case "<": return lv < rv; case ">=": return lv >= rv; case "<=": return lv <= rv;
    case "==": return Math.abs(lv - rv) < 1e-9;
    case "crosses_above": return !isNaN(plv) && !isNaN(prv) && plv <= prv && lv > rv;
    case "crosses_below": return !isNaN(plv) && !isNaN(prv) && plv >= prv && lv < rv;
    default: return false;
  }
}
function chainEval(conds, i, get) { if (!conds || !conds.length) return false; let r = evalCond(conds[0], i, get); for (let k = 1; k < conds.length; k++) { const e = evalCond(conds[k], i, get); r = (conds[k].gate || "AND") === "OR" ? (r || e) : (r && e); } return r; }
function backtest(cfg, c) {
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v || 0), cache = {};
  const get = (op) => resolveOperand(op, cfg.defs, c, closes, vols, cache);
  const trades = []; let pos = null, equity = 1, peak = 1, maxDD = 0; const eq = [{ i: 0, eq: 100 }];
  for (let i = 1; i < c.length; i++) {
    if (pos) equity *= closes[i] / closes[i - 1];
    eq.push({ i, eq: +(equity * 100).toFixed(2) });
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak);
    if (pos) {
      const ret = closes[i] / pos.entry - 1;
      const hitSL = cfg.sl && ret <= -Math.abs(Number(cfg.sl)) / 100;
      const hitTP = cfg.tp && ret >= Math.abs(Number(cfg.tp)) / 100;
      const sig = chainEval(cfg.exit, i, get);
      if (hitSL || hitTP || sig) { trades.push({ entryIdx: pos.i, exitIdx: i, entry: pos.entry, exit: closes[i], ret, reason: hitSL ? "SL" : hitTP ? "TP" : "Signal" }); pos = null; }
    } else if (chainEval(cfg.entry, i, get)) pos = { i, entry: closes[i] };
  }
  if (pos) { const i = c.length - 1; trades.push({ entryIdx: pos.i, exitIdx: i, entry: pos.entry, exit: closes[i], ret: closes[i] / pos.entry - 1, reason: "EOD" }); }
  const totalRet = (trades.reduce((a, t) => a * (1 + t.ret), 1) - 1) * 100;
  const wins = trades.filter((t) => t.ret > 0).length;
  const bh = (closes[closes.length - 1] / closes[0] - 1) * 100;
  return { trades, eq, stats: { n: trades.length, wins, winRate: trades.length ? wins / trades.length * 100 : 0, totalRet, maxDD: maxDD * 100, bh, avg: trades.length ? trades.reduce((a, t) => a + t.ret, 0) / trades.length * 100 : 0 } };
}
function BacktestResult({ cfg }) {
  const [sym, setSym] = useState("RELIANCE");
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(Date.now() - 180 * 864e5));
  const [to, setTo] = useState(iso(Date.now()));
  const [preset, setPreset] = useState("6m");
  const [tf, setTf] = useState("1d");
  const BT_TF = [["1m", "1 min"], ["3m", "3 min"], ["5m", "5 min"], ["15m", "15 min"], ["30m", "30 min"], ["1h", "1 hour"], ["4h", "4 hours"], ["1d", "1 day"]];
  const PRESETS = { "1m": 30, "3m": 90, "6m": 180, "1y": 365, "2y": 730 };
  const applyPreset = (k) => { setPreset(k); if (k !== "custom") { setFrom(iso(Date.now() - PRESETS[k] * 864e5)); setTo(iso(Date.now())); } };
  const stock = ALL.find((a) => a.sym === sym) || ALL[0];
  const bars = useMemo(() => { const d = (new Date(to) - new Date(from)) / 864e5; return clamp(Math.round(d > 0 ? d : 120), 20, 400); }, [from, to]);
  const data = useMemo(() => candles(sym + "|" + tf, stock.price, stock.chg, bars), [sym, stock, bars, tf]);
  const res = useMemo(() => (cfg.mode === "plain" ? null : backtest(cfg, data)), [cfg, data]);
  if (cfg.mode === "plain") {
    return <div style={{ fontSize: 12, color: "var(--muted)", padding: "10px 2px" }}>Plain-English rules are parsed on the backend at deploy time — switch to the visual builder to run a quick local backtest.</div>;
  }
  const st = res.stats;
  const tile = (k, v, c) => (
    <div style={{ flex: "1 1 0", minWidth: 64, background: "var(--bg)", borderRadius: 12, padding: "9px 10px" }}>
      <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div>
      <div className="mono" style={{ fontWeight: 800, fontSize: 14, marginTop: 2, color: c || "var(--ink)" }}>{v}</div>
    </div>
  );
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700 }}>Backtest on</span>
        <select value={sym} onChange={(e) => setSym(e.target.value)} style={{ ...selStyle, flex: "0 0 auto", minWidth: 120 }}>{ALL.map((a) => <option key={a.sym} value={a.sym}>{a.sym}</option>)}</select>
        <span style={{ fontSize: 10.5, color: "var(--muted)", marginLeft: "auto" }}>{bars} bars · sim</span>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, marginBottom: 3 }}>Candle timeframe</div>
        <div className="hide-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 10 }}>
          {BT_TF.map(([k, l]) => (
            <button key={k} onClick={() => setTf(k)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "6px 11px", fontSize: 11, fontWeight: 700, border: "1px solid " + (tf === k ? "var(--primary)" : "var(--line)"), background: tf === k ? "var(--primary)" : "var(--surface)", color: tf === k ? "var(--on-primary)" : "var(--ink)" }}>{l}</button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, marginBottom: 3 }}>Range</div>
        <div className="pill hide-scroll" style={{ display: "flex", background: "var(--elev)", border: "1px solid var(--line)", padding: 3, marginBottom: 8, width: "fit-content", maxWidth: "100%", overflowX: "auto" }}>
          {[["1m", "1M"], ["3m", "3M"], ["6m", "6M"], ["1y", "1Y"], ["2y", "2Y"]].map(([k, l]) => (
            <button key={k} onClick={() => applyPreset(k)} className="pill tap disp" style={{ padding: "5px 13px", fontSize: 11.5, fontWeight: 700, border: "none", background: preset === k ? "var(--primary)" : "transparent", color: preset === k ? "var(--on-primary)" : "var(--muted)" }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, marginBottom: 3 }}>From</div>
            <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreset("custom"); }} className="no-ring mono" style={{ ...selStyle, width: "100%", colorScheme: "light dark" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, marginBottom: 3 }}>To</div>
            <input type="date" value={to} min={from} max={iso(Date.now())} onChange={(e) => { setTo(e.target.value); setPreset("custom"); }} className="no-ring mono" style={{ ...selStyle, width: "100%", colorScheme: "light dark" }} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {tile("Return", (st.totalRet >= 0 ? "+" : "") + st.totalRet.toFixed(1) + "%", st.totalRet >= 0 ? "var(--up)" : "var(--down)")}
        {tile("Win rate", st.winRate.toFixed(0) + "%")}
        {tile("Trades", st.n)}
        {tile("Max DD", "-" + st.maxDD.toFixed(1) + "%", "var(--down)")}
      </div>
      <div style={{ height: 130, marginTop: 12, background: "var(--bg)", borderRadius: 12, padding: "8px 6px 2px" }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={res.eq} margin={{ top: 4, right: 6, bottom: 0, left: 6 }}>
            <defs><linearGradient id={"eq" + sym} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={st.totalRet >= 0 ? "#1FE08C" : "#FF5C77"} stopOpacity="0.35" /><stop offset="100%" stopColor={st.totalRet >= 0 ? "#1FE08C" : "#FF5C77"} stopOpacity="0" /></linearGradient></defs>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <YAxis domain={["dataMin", "dataMax"]} hide />
            <Tooltip formatter={(v) => v + " (start 100)"} labelFormatter={() => "Equity"} contentStyle={{ borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)", fontSize: 12 }} />
            <ReferenceLine y={100} stroke="var(--muted)" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="eq" stroke={st.totalRet >= 0 ? "#1FE08C" : "#FF5C77"} strokeWidth={2} fill={`url(#eq${sym})`} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)", marginTop: 10 }}>
        Strategy <b style={{ color: st.totalRet >= st.bh ? "var(--up)" : "var(--down)" }}>{st.totalRet >= st.bh ? "beat" : "lagged"}</b> buy-and-hold ({(st.bh >= 0 ? "+" : "") + st.bh.toFixed(1)}%). Avg trade {(st.avg >= 0 ? "+" : "") + st.avg.toFixed(2)}%.
      </div>
      {res.trades.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {res.trades.slice(-4).reverse().map((t, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 2px", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
              <span style={{ color: "var(--muted)" }}>Bar {t.entryIdx} → {t.exitIdx} <span className="pill" style={{ fontSize: 9, background: "var(--bg)", padding: "1px 7px", marginLeft: 4 }}>{t.reason}</span></span>
              <span className="mono" style={{ fontWeight: 800, color: t.ret >= 0 ? "var(--up)" : "var(--down)" }}>{(t.ret * 100 >= 0 ? "+" : "") + (t.ret * 100).toFixed(2)}%</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8 }}>Simulated bars · indicative only, not financial advice.</div>
    </div>
  );
}

/* ============================== TRADE AUTOMATION ============================== */
const IND_CATALOG = [
  { type: "EMA", label: "EMA", needsLen: true, attrs: [] },
  { type: "SMA", label: "SMA", needsLen: true, attrs: [] },
  { type: "RSI", label: "RSI", needsLen: true, attrs: [] },
  { type: "CCI", label: "CCI", needsLen: true, attrs: [] },
  { type: "MACD", label: "MACD", needsLen: false, attrs: ["line", "signal", "hist"] },
  { type: "BB", label: "Bollinger Band", needsLen: true, attrs: ["upper", "middle", "lower"] },
  { type: "KC", label: "Keltner Channel", needsLen: true, attrs: ["upper", "middle", "lower"] },
  { type: "ATR", label: "ATR", needsLen: true, attrs: [] },
  { type: "VWAP", label: "VWAP", needsLen: false, attrs: [] },
  { type: "ADX", label: "ADX", needsLen: true, attrs: [] },
  { type: "DMA", label: "DMA (displaced MA)", needsLen: true, attrs: [] },
  { type: "Volume", label: "Volume", needsLen: false, attrs: [] },
  { type: "CurrentCandle", label: "Current candle", needsLen: false, attrs: ["open", "high", "low", "close"] },
  { type: "PrevCandle", label: "Previous candle", needsLen: false, attrs: ["open", "high", "low", "close"] },
  { type: "FirstNCandles", label: "First N candles", needsLen: true, attrs: ["open", "high", "low", "close"] },
  { type: "LastNCandles", label: "Last N candles", needsLen: true, attrs: ["open", "high", "low", "close"] },
  { type: "CurrentDay", label: "Current day", needsLen: false, attrs: ["open", "close"] },
  { type: "PrevDay", label: "Previous day", needsLen: false, attrs: ["open", "close"] },
];
const TFS = ["3m", "5m", "15m", "30m", "1h", "4h", "1D"];
const OPSET = [[">", ">"], ["<", "<"], [">=", "≥"], ["<=", "≤"], ["==", "="], ["crosses_above", "⤴ crosses above"], ["crosses_below", "⤵ crosses below"]];
function defOperands(defs) {
  const out = [];
  defs.forEach((d) => {
    const cat = IND_CATALOG.find((c) => c.type === d.type) || { attrs: [] };
    if (cat.attrs.length) cat.attrs.forEach((a) => out.push(`${d.name}.${a}`));
    else out.push(d.name);
  });
  return out;
}

/* -------- Plain-English → executable rules parser --------
 * Turns sentences like "exit when RSI crosses above 85 or MACD histogram
 * becomes negative or MACD line crosses below MACD signal line" into structured,
 * backtestable conditions the engine understands. */
const MACD_DEF = { type: "MACD", len: "", name: "MACD" };
const BB_DEF = { type: "BB", len: "20", name: "BB" };
function mapToken(tok) {
  const t = tok.toLowerCase();
  if (/hist/.test(t)) return { operand: "MACD.hist", def: MACD_DEF };
  if (/signal/.test(t)) return { operand: "MACD.signal", def: MACD_DEF };
  if (/macd/.test(t)) return { operand: "MACD.line", def: MACD_DEF };
  let m;
  if ((m = t.match(/(\d+)\s*[- ]?\s*ema|ema\s*\(?\s*(\d+)?/))) { const len = m[1] || m[2] || "20"; return { operand: "EMA" + len, def: { type: "EMA", len, name: "EMA" + len } }; }
  if ((m = t.match(/(\d+)\s*[- ]?\s*sma|sma\s*\(?\s*(\d+)?/))) { const len = m[1] || m[2] || "50"; return { operand: "SMA" + len, def: { type: "SMA", len, name: "SMA" + len } }; }
  if (/upper/.test(t)) return { operand: "BB.upper", def: BB_DEF };
  if (/lower/.test(t)) return { operand: "BB.lower", def: BB_DEF };
  if (/middle|bollinger|\bbb\b/.test(t)) return { operand: "BB.middle", def: BB_DEF };
  if (/rsi/.test(t)) return { operand: "RSI", def: { type: "RSI", len: "14", name: "RSI" } };
  if (/adx/.test(t)) return { operand: "ADX", def: { type: "ADX", len: "14", name: "ADX" } };
  if (/cci/.test(t)) return { operand: "CCI", def: { type: "CCI", len: "20", name: "CCI" } };
  if (/vwap/.test(t)) return { operand: "VWAP", def: { type: "VWAP", len: "", name: "VWAP" } };
  if (/volume/.test(t)) return { operand: "Volume", def: { type: "Volume", len: "", name: "Volume" } };
  if (/price|close|ltp|spot/.test(t)) return { operand: "Price", def: null };
  return null;
}
const TOKEN_RE = /macd\s*hist\w*|macd\s*signal\w*|signal\s*line|macd\s*line|macd|\d+\s*[- ]?\s*ema|ema\s*\(?\s*\d*\s*\)?|\d+\s*[- ]?\s*sma|sma\s*\(?\s*\d*\s*\)?|upper\s*band|lower\s*band|middle\s*band|bollinger\s*\w*|\brsi\b|\badx\b|\bcci\b|\bvwap\b|\bvolume\b|\bprice\b|\bclose\b|\bltp\b/gi;
function detectOp(clause) {
  const c = clause.toLowerCase();
  if (/cross(es|ing)?\s*(above|over)/.test(c)) return { op: "crosses_above" };
  if (/cross(es|ing)?\s*(below|under)/.test(c)) return { op: "crosses_below" };
  if (/(become|becomes|turn|turns|goes|going)\s*(negative|below\s*zero)/.test(c)) return { op: "<", rhs: "0" };
  if (/(become|becomes|turn|turns|goes|going)\s*(positive|above\s*zero)/.test(c)) return { op: ">", rhs: "0" };
  if (c.includes(">=") || /greater\s*than\s*or\s*equal|at\s*least/.test(c)) return { op: ">=" };
  if (c.includes("<=") || /less\s*than\s*or\s*equal|at\s*most/.test(c)) return { op: "<=" };
  if (c.includes(">") || /greater\s*than|more\s*than|above|exceed|exceeds|rises?\s*above|goes?\s*above|breaks?\s*above/.test(c)) return { op: ">" };
  if (c.includes("<") || /less\s*than|below|under|drops?\s*below|falls?\s*below|dips?\s*below|breaks?\s*below/.test(c)) return { op: "<" };
  if (c.includes("==") || c.includes("=") || /equal|reaches|reach|hits|hit/.test(c)) return { op: "==" };
  return null;
}
function parseClause(clause) {
  const toks = [...clause.matchAll(TOKEN_RE)].map((mm) => ({ idx: mm.index, ...(mapToken(mm[0]) || {}) })).filter((t) => t.operand);
  const opi = detectOp(clause);
  if (!toks.length || !opi) return null;
  const left = toks[0];
  let b, bType, rdef = null;
  if (opi.rhs !== undefined) { b = opi.rhs; bType = "num"; }
  else if (toks[1]) { b = toks[1].operand; bType = "ind"; rdef = toks[1].def; }
  else { const nums = clause.match(/-?\d+(\.\d+)?/g); b = nums ? nums[nums.length - 1] : "0"; bType = "num"; }
  return { cond: { la: left.operand, op: opi.op, b, bType }, defs: [left.def, rdef].filter(Boolean) };
}
function parseRules(text) {
  if (!text || !text.trim()) return { conds: [], defs: [], unparsed: [] };
  const cleaned = text.replace(/^\s*(buy|sell|enter|exit|go long|short|when|if)\b[:,]?\s*/i, "");
  const parts = cleaned.split(/\s+(and|or)\s+/i);
  const conds = [], defs = [], unparsed = [];
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    const gate = i === 0 ? undefined : (parts[i - 1].toLowerCase() === "or" ? "OR" : "AND");
    const p = parseClause(clause);
    if (p) { if (gate) p.cond.gate = gate; conds.push(p.cond); p.defs.forEach((d) => { if (d && !defs.find((x) => x.name === d.name)) defs.push(d); }); }
    else if (clause.trim()) unparsed.push(clause.trim());
  }
  return { conds, defs, unparsed };
}
function condCode(c) { return `${c.la} ${c.op} ${c.b}`; }
function chainCode(conds) { return conds.map((c, i) => `${i ? " " + (c.gate || "AND") + " " : ""}${condCode(c)}`).join(""); }

const TEMPLATES = [
  { name: "Golden Cross + RSI", code: "EMA1 = EMA(length=50, tf=1D)\nEMA2 = EMA(length=200, tf=1D)\nif EMA1 > EMA2 AND RSI1 < 70:\n    enter_trade()", tag: "Trend",
    cfg: { mode: "builder", defs: [{ type: "EMA", len: "50", name: "EMA1" }, { type: "EMA", len: "200", name: "EMA2" }, { type: "RSI", len: "14", name: "RSI1" }], entry: [{ la: "EMA1", op: ">", bType: "ind", b: "EMA2" }, { la: "RSI1", op: "<", bType: "num", b: "70", gate: "AND" }], exit: [{ la: "EMA1", op: "crosses_below", bType: "ind", b: "EMA2" }], sl: "3", tp: "8" } },
  { name: "Bollinger squeeze", code: "if Price <= BB1.lower:\n    enter_trade()\nif Price >= BB1.upper:\n    exit_trade()", tag: "Volatility",
    cfg: { mode: "builder", defs: [{ type: "BB", len: "20", name: "BB1" }], entry: [{ la: "Price", op: "<=", bType: "ind", b: "BB1.lower" }], exit: [{ la: "Price", op: ">=", bType: "ind", b: "BB1.upper" }], sl: "4", tp: "6" } },
  { name: "MACD crossover", code: "if MACD1.line crosses_above MACD1.signal:\n    enter_trade()", tag: "Momentum",
    cfg: { mode: "builder", defs: [{ type: "MACD", len: "", name: "MACD1" }], entry: [{ la: "MACD1.line", op: "crosses_above", bType: "ind", b: "MACD1.signal" }], exit: [{ la: "MACD1.line", op: "crosses_below", bType: "ind", b: "MACD1.signal" }], sl: "3", tp: "8" } },
  { name: "CCI reversal", code: "if CCI1 < -100:\n    enter_trade()\nif CCI1 > 100:\n    exit_trade()", tag: "Reversal",
    cfg: { mode: "builder", defs: [{ type: "CCI", len: "20", name: "CCI1" }], entry: [{ la: "CCI1", op: "<", bType: "num", b: "-100" }], exit: [{ la: "CCI1", op: ">", bType: "num", b: "100" }], sl: "3", tp: "7" } },
  { name: "BB breakout + RSI", code: "BB1 = BollingerBand(length=20)\nRSI1 = RSI(length=14)\nif close crosses_above BB1.upper AND RSI1 > 60:\n    enter_trade()\nif close crosses_below BB1.middle:\n    exit_trade()", tag: "Breakout",
    cfg: { mode: "builder", defs: [{ type: "BB", len: "20", name: "BB1" }, { type: "RSI", len: "14", name: "RSI1" }], entry: [{ la: "Price", op: "crosses_above", bType: "ind", b: "BB1.upper" }, { la: "RSI1", op: ">", bType: "num", b: "60", gate: "AND" }], exit: [{ la: "Price", op: "crosses_below", bType: "ind", b: "BB1.middle" }], sl: "3", tp: "9" } },
  { name: "Multi-timeframe trend (3/5/10/30m)", code: "# Same trend across 3m, 5m, 10m, 30m\nEMA_3 = EMA(20, tf=3m); EMA_5 = EMA(20, tf=5m)\nEMA_10 = EMA(20, tf=10m); EMA_30 = EMA(20, tf=30m)\nif close>EMA_3 AND close>EMA_5 AND close>EMA_10 AND close>EMA_30:\n    enter_trade()\nif close < EMA_5:\n    exit_trade()", tag: "MTF",
    cfg: { mode: "builder", defs: [{ type: "EMA", len: "20", tf: "3m", name: "EMA_3" }, { type: "EMA", len: "20", tf: "5m", name: "EMA_5" }, { type: "EMA", len: "20", tf: "10m", name: "EMA_10" }, { type: "EMA", len: "20", tf: "30m", name: "EMA_30" }], entry: [{ la: "Price", op: ">", bType: "ind", b: "EMA_3" }, { la: "Price", op: ">", bType: "ind", b: "EMA_5", gate: "AND" }, { la: "Price", op: ">", bType: "ind", b: "EMA_10", gate: "AND" }, { la: "Price", op: ">", bType: "ind", b: "EMA_30", gate: "AND" }], exit: [{ la: "Price", op: "crosses_below", bType: "ind", b: "EMA_5" }], sl: "2", tp: "6" } },
  { name: "EMA 13 / SMA 83 crossover", code: "EMA13 = EMA(13); SMA83 = SMA(83); SMA39 = SMA(39)\nif EMA13 crosses_above SMA83:\n    enter_trade()\nif EMA13 crosses_below SMA39:\n    exit_trade()", tag: "Trend",
    cfg: { mode: "builder", defs: [{ type: "EMA", len: "13", name: "EMA13" }, { type: "SMA", len: "83", name: "SMA83" }, { type: "SMA", len: "39", name: "SMA39" }], entry: [{ la: "EMA13", op: "crosses_above", bType: "ind", b: "SMA83" }], exit: [{ la: "EMA13", op: "crosses_below", bType: "ind", b: "SMA39" }], sl: "3", tp: "8" } },
  { name: "EMA 9 / SMA 39 crossover", code: "EMA9 = EMA(9); SMA39 = SMA(39); EMA21 = EMA(21)\nif EMA9 crosses_above SMA39:\n    enter_trade()\nif EMA9 crosses_below EMA21:\n    exit_trade()", tag: "Trend",
    cfg: { mode: "builder", defs: [{ type: "EMA", len: "9", name: "EMA9" }, { type: "SMA", len: "39", name: "SMA39" }, { type: "EMA", len: "21", name: "EMA21" }], entry: [{ la: "EMA9", op: "crosses_above", bType: "ind", b: "SMA39" }], exit: [{ la: "EMA9", op: "crosses_below", bType: "ind", b: "EMA21" }], sl: "3", tp: "8" } },
  { name: "ADX trend + Triple EMA + Volume", code: "if ADX1 > 25 AND EMA_f crosses_above EMA_s AND Volume > VMA:\n    enter_trade()\nif EMA_f crosses_below EMA_m:\n    exit_trade()", tag: "Trend",
    cfg: { mode: "builder", defs: [{ type: "ADX", len: "14", name: "ADX1" }, { type: "EMA", len: "8", name: "EMA_f" }, { type: "EMA", len: "21", name: "EMA_m" }, { type: "EMA", len: "55", name: "EMA_s" }, { type: "Volume", len: "", name: "Volume" }, { type: "SMA", len: "20", name: "VMA" }], entry: [{ la: "ADX1", op: ">", bType: "num", b: "25" }, { la: "EMA_f", op: "crosses_above", bType: "ind", b: "EMA_s", gate: "AND" }], exit: [{ la: "EMA_f", op: "crosses_below", bType: "ind", b: "EMA_m" }], sl: "3", tp: "9" } },
  { name: "Keltner + Heikin-Ashi + MACD", code: "if close crosses_above KC1.upper AND MACD1.line > MACD1.signal:\n    enter_trade()\nif close crosses_below KC1.middle:\n    exit_trade()", tag: "Momentum",
    cfg: { mode: "builder", defs: [{ type: "KC", len: "20", name: "KC1" }, { type: "MACD", len: "", name: "MACD1" }, { type: "CurrentCandle", name: "HA" }], entry: [{ la: "Price", op: "crosses_above", bType: "ind", b: "KC1.upper" }, { la: "MACD1.line", op: ">", bType: "ind", b: "MACD1.signal", gate: "AND" }], exit: [{ la: "Price", op: "crosses_below", bType: "ind", b: "KC1.middle" }], sl: "3", tp: "8" } },
  { name: "RSI + CCI + BB mean-reversion", code: "if RSI1<35 AND CCI1<-100 AND close<=BB1.lower:\n    enter_trade()\nif RSI1>60 OR close>=BB1.middle:\n    exit_trade()", tag: "Reversal",
    cfg: { mode: "builder", defs: [{ type: "RSI", len: "14", name: "RSI1" }, { type: "CCI", len: "20", name: "CCI1" }, { type: "BB", len: "20", name: "BB1" }], entry: [{ la: "RSI1", op: "<", bType: "num", b: "35" }, { la: "CCI1", op: "<", bType: "num", b: "-100", gate: "AND" }, { la: "Price", op: "<=", bType: "ind", b: "BB1.lower", gate: "AND" }], exit: [{ la: "RSI1", op: ">", bType: "num", b: "60" }, { la: "Price", op: ">=", bType: "ind", b: "BB1.middle", gate: "OR" }], sl: "4", tp: "7" } },
];
const SEED_STRATS = [
  { id: "s1", name: "Golden Cross + RSI", by: "Matrix", active: true, alerts: false, cfg: TEMPLATES[0].cfg, cap: 200000, symbols: ["NIFTY50", "BANKNIFTY"], created: Date.now() - 128 * 864e5 },
  { id: "s2", name: "MACD crossover", by: "Matrix", active: true, alerts: false, cfg: TEMPLATES[2].cfg, cap: 100000, symbols: ["RELIANCE", "INFY"], created: Date.now() - 46 * 864e5 },
  { id: "s3", name: "Bollinger squeeze", by: "Matrix", active: false, alerts: false, cfg: TEMPLATES[1].cfg, cap: 150000, symbols: ["NIFTY50"], created: Date.now() - 84 * 864e5 },
  { id: "s4", name: "CCI reversal", by: "Community", active: false, alerts: false, cfg: TEMPLATES[3].cfg, cap: 50000, symbols: ["BANKNIFTY"], created: Date.now() - 210 * 864e5 },
];
// Reusable multi-select (chips). Empty value array = "All".
function MultiSelect({ label, options, value, onChange, allLabel = "All", dark }) {
  const [open, setOpen] = useState(false);
  const txt = dark ? "var(--on-primary)" : "var(--ink)";
  const summary = value.length === 0 ? allLabel : value.length === 1 ? value[0] : value.length + " selected";
  const chipBtn = (sel, on, key, lbl) => (
    <button key={key} onClick={on} className="tap pill" style={{ fontSize: 11, fontWeight: 700, padding: "6px 12px", border: "1px solid " + (sel ? "var(--primary)" : dark ? "rgba(255,255,255,.28)" : "var(--line)"), background: sel ? "var(--primary)" : dark ? "rgba(255,255,255,.1)" : "var(--surface)", color: sel ? "#fff" : txt }}>{lbl}</button>
  );
  const bg = dark ? "rgba(255,255,255,.12)" : "var(--elev)";
  const bd = dark ? "rgba(255,255,255,.28)" : "var(--line)";
  return (
    <div style={{ width: "100%" }}>
      <button onClick={() => setOpen((v) => !v)} className="tap disp" style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: bg, border: "1px solid " + bd, borderRadius: 12, padding: "10px 12px", fontSize: 12, fontWeight: 700, color: txt }}>
        <span>{label}: {summary}</span><ChevronRight size={15} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {chipBtn(value.length === 0, () => onChange([]), "__all", allLabel)}
          {options.map((o) => chipBtn(value.includes(o), () => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]), o, o))}
        </div>
      )}
    </div>
  );
}
// Deterministic performance for a strategy over a chosen window (days).
function stratPerf(strat, rangeDays) {
  const r = lcg(hash(strat.name + strat.by + (strat.id || "")));
  const perYearTrades = 18 + Math.floor(r() * 46);
  const trades = Math.max(1, Math.round(perYearTrades * rangeDays / 365));
  const winRate = 46 + r() * 30;
  const wins = Math.round(trades * winRate / 100);
  const perYearRet = (r() * 0.95 - 0.18) * 42; // ≈ -7.5% .. +32% annualised
  const retPct = perYearRet * (rangeDays / 365);
  const cap = strat.cap || 100000;
  return { trades, wins, winRate, retPct, annual: perYearRet, pnl: cap * retPct / 100, cap };
}
const ACTIVATE_SYMS = [...new Set([...FNO.map((s) => s.sym), "AAPL", "NVDA", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "BTC", "ETH", "SOL", "DOGE"])].filter((sym) => ALL.some((a) => a.sym === sym));
function TemplateCard({ t, onActivate, onToggleBt, btActive }) {
  const [syms, setSyms] = useState([]);
  return (
    <div className="card" style={{ flex: "0 0 auto", width: 250, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="disp" style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</span>
        <span className="pill" style={{ fontSize: 10, background: "var(--primary-soft)", color: "var(--primary)", fontWeight: 700, padding: "2px 8px" }}>{t.tag}</span>
      </div>
      <pre className="mono" style={{ fontSize: 10, background: "var(--bg)", borderRadius: 12, padding: 10, marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{t.code}</pre>
      <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, margin: "10px 0 6px" }}>Select symbol(s) to activate on</div>
      <MultiSelect label="Symbols" options={ACTIVATE_SYMS} value={syms} onChange={setSyms} allLabel="Choose…" />
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button disabled={!syms.length} onClick={() => syms.length && onActivate(t, syms)} className="tap pill" style={{ flex: 1, border: "none", background: syms.length ? "linear-gradient(120deg,var(--primary),var(--primary-2))" : "var(--elev)", color: syms.length ? "var(--on-primary)" : "var(--muted)", fontWeight: 700, fontSize: 11.5, padding: 9, cursor: syms.length ? "pointer" : "not-allowed", opacity: syms.length ? 1 : 0.7 }}>Activate{syms.length ? ` (${syms.length})` : ""}</button>
        <button onClick={() => onToggleBt(t.name)} className="tap pill" style={{ flex: "0 0 auto", border: "1px solid " + (btActive ? "var(--primary)" : "var(--line)"), background: btActive ? "var(--primary-soft)" : "var(--surface)", fontWeight: 700, fontSize: 11.5, padding: "9px 11px", color: btActive ? "var(--primary)" : "var(--ink)", display: "flex", gap: 4, alignItems: "center" }}><Activity size={13} /> Test</button>
      </div>
    </div>
  );
}
function Automation({ market = "IN", onRecord, onBuyReal }) {
  const [mode, setMode] = useState("builder");
  const [defs, setDefs] = useState([
    { id: 1, type: "EMA", len: "50", tf: "1D", name: "EMA1" },
    { id: 2, type: "EMA", len: "200", tf: "1D", name: "EMA2" },
    { id: 3, type: "RSI", len: "14", tf: "15m", name: "RSI1" },
    { id: 4, type: "MACD", len: "", tf: "3m", name: "MACD1" },
  ]);
  const operands = useMemo(() => ["Price", "Volume", ...defOperands(defs)], [defs]);
  const [entryConds, setEntryConds] = useState([
    { la: "EMA1", op: ">", bType: "ind", b: "EMA2" },
    { la: "RSI1", op: "<", bType: "num", b: "70", gate: "AND" },
  ]);
  const [exitConds, setExitConds] = useState([
    { la: "MACD1.line", op: "crosses_below", bType: "ind", b: "MACD1.signal" },
    { la: "RSI1", op: ">", bType: "num", b: "70", gate: "OR" },
  ]);
  const [sl, setSl] = useState("3");
  const [tp, setTp] = useState("8");
  const [capital, setCapital] = useState("100000");
  const [tf, setTf] = useState("5m");
  const [deploySyms, setDeploySyms] = useState(["NIFTY50"]);
  const [symFilter, setSymFilter] = useState([]);
  const DEPLOY_OPTIONS = useMemo(() => FNO.map((s) => s.sym), []);
  const [pEntry, setPEntry] = useState("Buy when EMA 9 crosses above EMA 21 and RSI is above 55.");
  const [pExit, setPExit] = useState("Exit when RSI crosses above 85 or MACD histogram becomes negative or MACD line crosses below MACD signal line.");
  const [aiStrat, setAiStrat] = useState(null); const [aiStratBusy, setAiStratBusy] = useState(false);
  const aiInterpret = async () => {
    setAiStratBusy(true); setAiStrat(null);
    const out = await aiInterpretStrategy(`ENTRY: ${pEntry}\nEXIT: ${pExit}`);
    setAiStratBusy(false);
    if (out) { setAiStrat(out); const sm = out.match(/STOP:\s*(\d+)/i); const tm = out.match(/TARGET:\s*(\d+)/i); if (sm) setSl(sm[1]); if (tm) setTp(tm[1]); }
    else setAiStrat("Couldn't reach the AI interpreter — this needs the backend deployed with a Groq (or other) key. The local parser still handles common phrasings.");
  };
  const [strats, setStrats] = useState(SEED_STRATS);
  const [stratName, setStratName] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const [showBt, setShowBt] = useState(false);
  const [btOpen, setBtOpen] = useState(null);
  const [btTpl, setBtTpl] = useState(null);
  const [notifs, setNotifs] = useState([]);
  const [toast, setToast] = useState(null);
  const [dashBy, setDashBy] = useState("All");
  const [dashRange, setDashRange] = useState(365);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3400); return () => clearTimeout(t); }, [toast]);
  function fireAlert(a) {
    let text;
    try {
      const data = candles("NIFTY50", 23450, 0.62, 80);
      const bt = a.cfg && a.cfg.mode !== "plain" ? backtest(a.cfg, data) : null;
      const last = bt && bt.trades.length ? bt.trades[bt.trades.length - 1] : null;
      const kind = last ? (["Signal", "TP", "SL", "EOD"].includes(last.reason) ? "Exit" : "Entry") : null;
      text = last ? `${a.name}: ${kind} signal on NIFTY50 @ ${last.exit.toFixed(2)}` : `${a.name}: alerts armed — watching for entry/exit signals`;
    } catch { text = `${a.name}: alerts armed`; }
    setNotifs((p) => [{ id: Date.now() + Math.random(), text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }, ...p].slice(0, 8));
    setToast(text);
  }

  // Plain-English → executable rules
  const eParsed = useMemo(() => parseRules(pEntry), [pEntry]);
  const xParsed = useMemo(() => parseRules(pExit), [pExit]);
  const plainDefs = useMemo(() => { const d = []; [...eParsed.defs, ...xParsed.defs].forEach((x) => { if (x && !d.find((y) => y.name === x.name)) d.push(x); }); return d; }, [eParsed, xParsed]);
  const cfg = mode === "builder"
    ? { mode: "builder", tf, defs, entry: entryConds, exit: exitConds, sl, tp }
    : { mode: "builder", tf, defs: plainDefs.map((d) => ({ ...d, tf })), entry: eParsed.conds, exit: xParsed.conds, sl, tp };
  const condStr = (c) => `${c.la} ${c.op} ${c.b}`;
  const chain = (conds) => conds.map((c, i) => `${i ? " " + (c.gate || "AND") + " " : ""}${condStr(c)}`).join("");
  const defLines = defs.map((d) => {
    const cat = IND_CATALOG.find((c) => c.type === d.type);
    const args = [];
    if (cat?.needsLen && d.len) args.push(`length=${d.len}`);
    args.push(`tf=${d.tf}`);
    return `${d.name} = ${d.type}(${args.join(", ")})`;
  }).join("\n");
  const plainDefLines = plainDefs.map((d) => `${d.name} = ${d.type}(${d.len ? "length=" + d.len + ", " : ""}tf=${tf})`).join("\n");
  const unparsed = [...eParsed.unparsed, ...xParsed.unparsed];
  const code = mode === "builder"
    ? `# Indicators\n${defLines}\n\n# Entry\nif ${chain(entryConds)}:\n    enter_trade(stop_loss=${sl}%, take_profit=${tp}%)\n\n# Exit\nif ${chain(exitConds)}:\n    exit_trade()`
    : `# Timeframe: ${tf}\n# Indicators (auto-detected from your text)\n${plainDefLines || "# (none detected yet)"}\n\n# ENTRY\nif ${chainCode(eParsed.conds) || "<describe entry rules>"}:\n    enter_trade(stop_loss=${sl}%, take_profit=${tp}%)\n\n# EXIT\nif ${chainCode(xParsed.conds) || "<describe exit rules>"}:\n    exit_trade()`;

  const saveStrategy = (makeActive) => {
    const name = stratName.trim() || (mode === "builder" ? "Custom strategy" : "Plain-English strategy");
    const id = "u" + Date.now();
    const symbols = deploySyms.length ? deploySyms : ["NIFTY50"];
    const strat = { id, name, by: "You", active: makeActive, alerts: false, cfg, cap: parseInt(capital) || 100000, symbols, created: Date.now() };
    setStrats((p) => [strat, ...p]);
    setStratName(""); setShowBuilder(false);
    if (makeActive) recordAutomateTrades(id, name, cfg, symbols);
    setToast(`${name} ${makeActive ? "deployed & running" : "saved as draft"}`);
  };
  const activateTemplate = (t, syms) => {
    const symbols = syms && syms.length ? syms : ["NIFTY50"];
    const id = "t" + Date.now();
    setStrats((p) => [{ id, name: t.name, by: "Matrix", active: true, alerts: false, cfg: t.cfg, cap: 100000, symbols, created: Date.now() }, ...p]);
    recordAutomateTrades(id, t.name, t.cfg, symbols);
    setToast(`${t.name} activated on ${symbols.join(", ")}`);
  };
  // Record simulated trades produced by an activated automation (deduped by id).
  // Activating a strategy places REAL positions at the live price with the strategy's
  // target/stop. The exit engine then closes them at real market prices. Nothing is
  // fabricated — no invented history, no simulated win/loss.
  const recordAutomateTrades = (stratId, name, cfg, symbols) => {
    if (!onBuyReal) return;
    const slp = (cfg && cfg.sl) || 3, tpp = (cfg && cfg.tp) || 6;
    const per = Math.max(1, (parseInt(capital) || 100000) / Math.max(1, symbols.length));
    symbols.forEach((sym) => {
      const s = ALL.find((a) => a.sym === sym);
      if (!s || !s.price) return;
      const qty = Math.max(1, Math.floor(per / s.price));
      onBuyReal(s, qty, { tp: tpp, sl: slp, tradeType: "Automate" });
    });
  };
  const toggleActive = (id) => setStrats((p) => p.map((s) => s.id === id ? { ...s, active: !s.active } : s));
  const toggleAlerts = (s) => { const willOn = !s.alerts; setStrats((p) => p.map((x) => x.id === s.id ? { ...x, alerts: willOn } : x)); if (willOn) fireAlert(s); };
  const updateStrat = (id, patch) => setStrats((p) => p.map((s) => s.id === id ? { ...s, ...patch } : s));
  const [editStrat, setEditStrat] = useState(null);
  const TF_OPTS = ["3m", "5m", "10m", "15m", "30m", "1h", "1D"];

  // dashboard aggregation — scoped to the selected market
  const amkt = market === "FNO" ? "IN" : market;
  const inMkt = (s) => !(s.symbols && s.symbols.length) || s.symbols.some((x) => marketOf(x) === amkt);
  const shown = strats.filter((s) => inMkt(s) && (dashBy === "All" || s.by === dashBy) && (symFilter.length === 0 || (s.symbols || []).some((x) => symFilter.includes(x))));
  const perf = shown.map((s) => ({ s, p: stratPerf(s, dashRange) }));
  const agg = perf.reduce((a, { p }) => { a.trades += p.trades; a.wins += p.wins; a.pnl += p.pnl; a.cap += p.cap; a.annSum += p.annual; return a; }, { trades: 0, wins: 0, pnl: 0, cap: 0, annSum: 0 });
  const activeCount = shown.filter((s) => s.active).length;
  const dWinRate = agg.trades ? agg.wins / agg.trades * 100 : 0;
  const dRet = agg.cap ? agg.pnl / agg.cap * 100 : 0;
  const dAnn = perf.length ? agg.annSum / perf.length : 0;
  const activeStrats = perf.filter(({ s }) => s.active);
  const inactiveStrats = perf.filter(({ s }) => !s.active);
  const byOptions = ["All", "Matrix", "You", "Community"];
  const dsel = { ...selStyle, flex: "1 1 0", minWidth: 0, padding: "8px 8px", fontSize: 11.5 };
  const fmtDate = (t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });

  const DStat = ({ k, v, c }) => (
    <div style={{ flex: "1 1 28%", minWidth: 88, background: "rgba(255,255,255,.1)", borderRadius: 14, padding: "10px 12px" }}>
      <div style={{ fontSize: 9.5, opacity: .85, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em" }}>{k}</div>
      <div className="mono" style={{ fontWeight: 800, fontSize: 15, marginTop: 3, color: c || "#fff" }}>{v}</div>
    </div>
  );
  const MetricMini = ({ k, v, c }) => (
    <div style={{ flex: "1 1 30%", minWidth: 74 }}>
      <div style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700 }}>{k}</div>
      <div className="mono" style={{ fontWeight: 800, fontSize: 13, color: c || "var(--ink)" }}>{v}</div>
    </div>
  );
  const StrategyCard = ({ s, p }) => (
    <div className="card" style={{ padding: 15, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span style={{ width: 9, height: 9, borderRadius: 9, flex: "0 0 auto", background: s.active ? "var(--up)" : "var(--muted)", boxShadow: s.active ? "0 0 0 4px var(--up-soft)" : "none" }} />
          <div style={{ minWidth: 0 }}>
            <div className="disp" style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>by {s.by} · started {fmtDate(s.created)} · {fmt(s.cap || 100000, "IN")}</div>
            {s.symbols && s.symbols.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                {s.symbols.slice(0, 4).map((sy) => <span key={sy} className="pill" style={{ fontSize: 9.5, fontWeight: 700, background: "var(--primary-soft)", color: "var(--primary)", padding: "2px 8px" }}>{sy}</span>)}
                {s.symbols.length > 4 && <span style={{ fontSize: 9.5, color: "var(--muted)", fontWeight: 700, alignSelf: "center" }}>+{s.symbols.length - 4}</span>}
              </div>
            )}
          </div>
        </div>
        {s.alerts && <span className="pill" style={{ fontSize: 9.5, fontWeight: 800, background: "var(--primary-soft)", color: "var(--primary)", padding: "3px 8px", display: "flex", alignItems: "center", gap: 3, flex: "0 0 auto" }}><Bell size={10} /> Alerts</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <MetricMini k="Trades" v={p.trades} />
        <MetricMini k="Win rate" v={p.winRate.toFixed(0) + "%"} />
        <MetricMini k="P&L" v={(p.pnl >= 0 ? "+" : "") + fmt(p.pnl, "IN")} c={p.pnl >= 0 ? "var(--up)" : "var(--down)"} />
        <MetricMini k="Returns" v={(p.retPct >= 0 ? "+" : "") + p.retPct.toFixed(1) + "%"} c={p.retPct >= 0 ? "var(--up)" : "var(--down)"} />
      </div>
      <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
        <button onClick={() => setEditStrat(editStrat === s.id ? null : s.id)} className="tap" title="Edit symbols & timeframe" style={{ border: "1px solid " + (editStrat === s.id ? "var(--primary)" : "var(--line)"), borderRadius: 11, background: editStrat === s.id ? "var(--primary-soft)" : "var(--surface)", padding: "7px 10px", display: "grid", placeItems: "center", color: editStrat === s.id ? "var(--primary)" : "var(--ink)" }}><SlidersHorizontal size={14} /></button>
        <button onClick={() => toggleAlerts(s)} className="tap" title="Alert on entry/exit signal" style={{ border: "1px solid " + (s.alerts ? "var(--primary)" : "var(--line)"), borderRadius: 11, background: s.alerts ? "var(--primary)" : "var(--surface)", padding: "7px 10px", display: "grid", placeItems: "center", color: s.alerts ? "var(--on-primary)" : "var(--ink)" }}><Bell size={14} /></button>
        <button onClick={() => setBtOpen(btOpen === s.id ? null : s.id)} className="tap" style={{ border: "1px solid " + (btOpen === s.id ? "var(--primary)" : "var(--line)"), borderRadius: 11, background: btOpen === s.id ? "var(--primary-soft)" : "var(--surface)", padding: "7px 11px", display: "flex", gap: 5, alignItems: "center", fontSize: 12, fontWeight: 700, color: btOpen === s.id ? "var(--primary)" : "var(--ink)" }}><Activity size={13} /> Test</button>
        <button onClick={() => toggleActive(s.id)} className="tap disp" style={{ flex: 1, borderRadius: 11, background: s.active ? "var(--surface)" : "linear-gradient(120deg,var(--up),#0EA968)", color: s.active ? "var(--ink)" : "#fff", boxShadow: s.active ? "none" : "0 6px 16px rgba(16,185,129,.3)", padding: "7px 10px", display: "flex", gap: 5, alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 800, border: s.active ? "1px solid var(--line)" : "none" }}>
          {s.active ? <><Pause size={13} /> Deactivate</> : <><Play size={13} /> Activate</>}
        </button>
      </div>
      {editStrat === s.id && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Symbols</div>
          <MultiSelect label="Symbols" options={DEPLOY_OPTIONS} value={s.symbols || []} onChange={(v) => updateStrat(s.id, { symbols: v })} allLabel="Select…" />
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, margin: "12px 0 6px" }}>Timeframe</div>
          <div className="hide-scroll" style={{ display: "flex", gap: 6, overflowX: "auto" }}>
            {TF_OPTS.map((x) => (
              <button key={x} onClick={() => updateStrat(s.id, { tf: x })} className="pill tap disp" style={{ flex: "0 0 auto", padding: "6px 13px", fontSize: 11.5, fontWeight: 700, border: "1px solid " + ((s.tf || "5m") === x ? "var(--primary)" : "var(--line)"), background: (s.tf || "5m") === x ? "var(--primary)" : "var(--surface)", color: (s.tf || "5m") === x ? "var(--on-primary)" : "var(--ink)" }}>{x}</button>
            ))}
          </div>
          <button onClick={() => setEditStrat(null)} className="tap disp" style={{ width: "100%", marginTop: 12, background: "var(--primary)", color: "#fff", border: "none", borderRadius: 11, padding: 10, fontWeight: 700, fontSize: 12.5 }}>Done</button>
        </div>
      )}
      {btOpen === s.id && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <BacktestResult cfg={s.cfg || { mode: "plain" }} />
        </div>
      )}
    </div>
  );

  return (
    <div className="mx fade">
      <div className="disp" style={{ fontWeight: 700, fontSize: 22, marginTop: 8 }}>Trade Automation</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>{{ IN: "🇮🇳 Indian", US: "🇺🇸 US", Crypto: "₿ Crypto", FNO: "⚡ F&O", Commodity: "🪙 Commodity" }[market]} strategies · track performance and manage automations.</div>

      {/* Automation dashboard */}
      <div className="card glow metal" style={{ marginTop: 18, padding: 18, border: "none", background: "var(--feature-grad)", color: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 15 }}>Automation Dashboard</div>
          <span style={{ fontSize: 10.5, opacity: .85 }}>last {dashRange >= 365 ? "12 months" : dashRange + "d"}</span>
        </div>
        <div className="mono" style={{ fontWeight: 800, fontSize: 26, marginTop: 8 }}>{dRet >= 0 ? "+" : ""}{fmt(agg.pnl, "IN")}</div>
        <div style={{ fontSize: 11, opacity: .85, marginTop: -2 }}>Total P&amp;L across {shown.length} strategies</div>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 14 }}>
          <DStat k="Active strategies" v={activeCount} />
          <DStat k="Trades executed" v={agg.trades} />
          <DStat k="Win rate" v={agg.trades ? dWinRate.toFixed(0) + "%" : "—"} />
          <DStat k="P&L total" v={(agg.pnl >= 0 ? "+" : "") + fmt(agg.pnl, "IN")} c={agg.pnl >= 0 ? "#9CFFD6" : "#FFB3BE"} />
          <DStat k="Returns %" v={(dRet >= 0 ? "+" : "") + dRet.toFixed(2) + "%"} c={dRet >= 0 ? "#9CFFD6" : "#FFB3BE"} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <select value={dashBy} onChange={(e) => setDashBy(e.target.value)} style={dsel}>{byOptions.map((o) => <option key={o} value={o}>Created by: {o}</option>)}</select>
          <select value={dashRange} onChange={(e) => setDashRange(+e.target.value)} style={dsel}><option value={30}>30d</option><option value={90}>3m</option><option value={180}>6m</option><option value={365}>12m</option></select>
        </div>
        <div style={{ marginTop: 8 }}>
          <MultiSelect label="Symbol" options={DEPLOY_OPTIONS} value={symFilter} onChange={setSymFilter} dark />
        </div>
      </div>

      {/* Create a new automated strategy */}
      <button onClick={() => setShowBuilder((v) => !v)} className="tap disp glow" style={{ width: "100%", marginTop: 16, background: showBuilder ? "var(--surface)" : "linear-gradient(120deg,var(--primary),var(--primary-2))", color: showBuilder ? "var(--ink)" : "#fff", border: showBuilder ? "1px solid var(--line)" : "none", borderRadius: 16, padding: 15, fontWeight: 700, fontSize: 14.5, display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
        {showBuilder ? <><X size={17} /> Close builder</> : <><Plus size={18} /> Create a New Automated Strategy</>}
      </button>

      {showBuilder && (
        <div className="fade">
          {/* how do you want to build it? */}
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            {[["builder", "🧩 Visual builder"], ["plain", "✍️ Plain English"]].map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} className="tap disp" style={{ flex: 1, padding: "12px 10px", borderRadius: 14, fontWeight: 700, fontSize: 12.5, border: "1px solid " + (mode === k ? "var(--primary)" : "var(--line)"), background: mode === k ? "var(--primary-soft)" : "var(--surface)", color: mode === k ? "var(--primary)" : "var(--ink)" }}>{l}</button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", margin: "8px 2px 0", lineHeight: 1.5 }}>{mode === "plain" ? "Just describe your entry and exit rules in your own words — no indicators to pick. Matrix interprets them when you deploy." : "Pick indicators, then stack them into signals with AND / OR."}</div>

          {mode === "builder" && (
            <>
              {/* Strategy Ideas (templates) */}
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", margin: "18px 2px 10px", display: "flex", alignItems: "center", gap: 7 }}><Sparkles size={14} color="var(--primary)" /> Strategy Ideas — pick a symbol, then activate</div>
              <div className="hide-scroll" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 2 }}>
                {TEMPLATES.map((t) => (
                  <TemplateCard key={t.name} t={t} onActivate={activateTemplate} onToggleBt={(n) => setBtTpl(btTpl === n ? null : n)} btActive={btTpl === t.name} />
                ))}
              </div>
              {btTpl && (
                <div className="card" style={{ marginTop: 12, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span className="disp" style={{ fontWeight: 700, fontSize: 13.5 }}>Backtest · {btTpl} <span style={{ color: "var(--muted)", fontWeight: 600, fontSize: 11 }}>· pick a stock or index</span></span>
                    <X size={18} className="tap" color="var(--muted)" onClick={() => setBtTpl(null)} />
                  </div>
                  <BacktestResult cfg={(TEMPLATES.find((x) => x.name === btTpl) || {}).cfg} />
                </div>
              )}

              {/* Step 1 — define indicators */}
              <div className="card" style={{ marginTop: 16, padding: 16 }}>
                <div className="disp" style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 7 }}>
                  <span className="pill gold-text" style={{ fontWeight: 800, fontSize: 12 }}>STEP 1</span> Your indicators
                </div>
                <div className="gold-line" style={{ width: 40, margin: "10px 0 14px", borderRadius: 2 }} />
                <IndicatorDefs defs={defs} setDefs={setDefs} />
              </div>
            </>
          )}

          {/* Signals (builder) / plain-English description */}
          <div className="card" style={{ marginTop: 14, padding: 16 }}>
            <div className="disp" style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 7 }}>
              {mode === "builder" ? <><span className="pill gold-text" style={{ fontWeight: 800, fontSize: 12 }}>STEP 2</span> Signals</> : <><Sparkles size={16} color="var(--primary)" /> Describe your strategy</>}
            </div>
            <div className="gold-line" style={{ width: 40, margin: "10px 0 16px", borderRadius: 2 }} />

            {mode === "builder" ? (
              <>
                <CondBuilder2 label="Entry signal — combine indicators with AND / OR" conds={entryConds} setConds={setEntryConds} operands={operands} />
                <div className="silver-line" style={{ margin: "16px 0" }} />
                <CondBuilder2 label="Exit signal" conds={exitConds} setConds={setExitConds} operands={operands} />
              </>
            ) : (
              <>
                <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Timeframe</div>
                <div className="hide-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 14 }}>
                  {["3m", "5m", "10m", "15m", "30m", "1h", "1D"].map((x) => (
                    <button key={x} onClick={() => setTf(x)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "7px 14px", fontSize: 12, fontWeight: 700, border: "1px solid " + (tf === x ? "var(--primary)" : "var(--line)"), background: tf === x ? "var(--primary)" : "var(--surface)", color: tf === x ? "var(--on-primary)" : "var(--ink)" }}>{x}</button>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Entry rules — in plain English</div>
                <textarea value={pEntry} onChange={(e) => setPEntry(e.target.value)} placeholder="e.g. Buy when EMA 9 crosses above EMA 21 and RSI is above 55." className="no-ring" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 12, padding: 12, fontSize: 13, minHeight: 84, background: "var(--elev)", resize: "vertical", lineHeight: 1.5 }} />
                {eParsed.conds.length > 0 && <div style={{ fontSize: 10.5, color: "var(--up)", marginTop: 6, fontWeight: 700 }}>✓ Parsed: {chainCode(eParsed.conds)}</div>}
                <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, margin: "14px 0 6px" }}>Exit rules — in plain English</div>
                <textarea value={pExit} onChange={(e) => setPExit(e.target.value)} placeholder="e.g. Exit when RSI crosses above 85 or MACD histogram becomes negative or MACD line crosses below MACD signal line." className="no-ring" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 12, padding: 12, fontSize: 13, minHeight: 84, background: "var(--elev)", resize: "vertical", lineHeight: 1.5 }} />
                {xParsed.conds.length > 0 && <div style={{ fontSize: 10.5, color: "var(--up)", marginTop: 6, fontWeight: 700 }}>✓ Parsed: {chainCode(xParsed.conds)}</div>}
                {unparsed.length > 0 && <div style={{ fontSize: 10.5, color: "#F59E42", marginTop: 8, fontWeight: 600 }}>⚠ Couldn't parse: "{unparsed.join('", "')}". Try phrasing like "RSI crosses above 85" or "EMA 9 crosses above SMA 39" — or let AI interpret it below.</div>}
                <button onClick={aiInterpret} disabled={aiStratBusy} className="tap disp" style={{ marginTop: 10, background: "var(--primary-soft)", color: "var(--primary)", border: "1px solid var(--primary)", borderRadius: 12, padding: "9px 14px", fontWeight: 800, fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center", opacity: aiStratBusy ? 0.6 : 1 }}><Sparkles size={14} /> {aiStratBusy ? "Interpreting…" : "Interpret with AI (Groq)"}</button>
                {aiStrat && <div className="card" style={{ marginTop: 10, padding: 12, background: "var(--elev)", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{aiStrat}</div>}
                <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8, display: "flex", gap: 6 }}><Sparkles size={13} color="var(--primary)" style={{ flex: "0 0 auto", marginTop: 1 }} /> Matrix converts your text into the executable code below on the <b style={{ margin: "0 3px" }}>{tf}</b> timeframe — recognises RSI, MACD (line/signal/histogram), EMA/SMA(n), Bollinger bands, ADX, CCI, VWAP, volume, price, with crosses-above/below, greater/less-than and becomes-positive/negative.</div>
              </>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <NumF label="Stop loss %" v={sl} set={setSl} />
              <NumF label="Take profit %" v={tp} set={setTp} />
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Capital deployed (₹)</div>
              <input value={capital} onChange={(e) => setCapital(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="100000" className="no-ring mono" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 12, padding: 12, fontSize: 14, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" }} />
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 5 }}>Sizes this strategy's P&amp;L. Default ₹1,00,000.</div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Deploy on — symbol(s)</div>
              <MultiSelect label="Symbols" options={DEPLOY_OPTIONS} value={deploySyms} onChange={setDeploySyms} allLabel="Select…" />
              {deploySyms.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {deploySyms.map((sy) => (
                  <span key={sy} className="pill" style={{ fontSize: 11, fontWeight: 700, background: "var(--primary-soft)", color: "var(--primary)", padding: "5px 10px", display: "flex", alignItems: "center", gap: 6 }}>{sy}<X size={12} className="tap" onClick={() => setDeploySyms((p) => p.filter((x) => x !== sy))} /></span>
                ))}
              </div>}
              <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 6 }}>The strategy runs on these instruments. Default NIFTY50.</div>
            </div>
            <pre className="mono" style={{ fontSize: 11, background: "#0E0E18", color: "#C9D2FF", border: "1px solid #2A2A3D", borderRadius: 12, padding: 13, marginTop: 14, whiteSpace: "pre-wrap", lineHeight: 1.55, overflowX: "auto" }}>{code}</pre>

            <button onClick={() => setShowBt((v) => !v)} className="tap disp" style={{ width: "100%", marginTop: 12, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 14, padding: 12, fontWeight: 700, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}><Activity size={16} color="var(--primary)" /> {showBt ? "Hide backtest" : "Backtest this strategy"}</button>
            {showBt && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
                <BacktestResult cfg={cfg} />
              </div>
            )}

            {/* Save */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
              <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 6 }}>Strategy name</div>
              <input value={stratName} onChange={(e) => setStratName(e.target.value)} placeholder="e.g. My Nifty swing setup" className="no-ring disp" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 12, padding: 12, fontSize: 13.5, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => saveStrategy(false)} className="tap disp" style={{ flex: 1, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 14, padding: 13, fontWeight: 700, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}><Check size={16} color="var(--primary)" /> Save strategy</button>
                <button onClick={() => saveStrategy(true)} className="tap disp glow" style={{ flex: 1, background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "#fff", border: "none", borderRadius: 14, padding: 13, fontWeight: 700, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}><Bolt size={16} /> Save &amp; deploy</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Signal alerts */}
      {notifs.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "22px 2px 8px" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--muted)" }}>Signal alerts</span>
            <button onClick={() => setNotifs([])} className="tap" style={{ border: "none", background: "transparent", fontSize: 11, fontWeight: 700, color: "var(--primary)" }}>Clear</button>
          </div>
          <div className="card" style={{ padding: 13, marginBottom: 4 }}>
            {notifs.map((nt) => (
              <div key={nt.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--line)" }}>
                <Bell size={13} color="var(--primary)" style={{ flex: "0 0 auto" }} />
                <span style={{ fontSize: 12, flex: 1 }}>{nt.text}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{nt.time}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Strategies — Active / Inactive */}
      <div className="disp" style={{ fontWeight: 700, fontSize: 18, margin: "28px 2px 4px" }}>Strategies</div>
      <div className="gold-line" style={{ width: 44, margin: "0 0 14px 2px", borderRadius: 2 }} />

      <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--up)", letterSpacing: ".04em", margin: "4px 2px 10px", display: "flex", alignItems: "center", gap: 6 }}>● ACTIVE <span style={{ color: "var(--muted)", fontWeight: 700 }}>({activeStrats.length})</span></div>
      {activeStrats.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12 }}>No active strategies for this filter.</div>
        : activeStrats.map(({ s, p }) => <React.Fragment key={s.id}>{StrategyCard({ s, p })}</React.Fragment>)}

      <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--muted)", letterSpacing: ".04em", margin: "16px 2px 10px", display: "flex", alignItems: "center", gap: 6 }}>● INACTIVE <span style={{ fontWeight: 700 }}>({inactiveStrats.length})</span></div>
      {inactiveStrats.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No inactive strategies for this filter.</div>
        : inactiveStrats.map(({ s, p }) => <React.Fragment key={s.id}>{StrategyCard({ s, p })}</React.Fragment>)}

      {toast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 96, display: "flex", justifyContent: "center", zIndex: 80, pointerEvents: "none" }}>
          <div className="card glow" style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 16px", maxWidth: 380, border: "1px solid var(--primary)" }}>
            <Bell size={16} color="var(--primary)" />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
function IndicatorDefs({ defs, setDefs }) {
  const upd = (id, k, v) => setDefs((p) => p.map((d) => d.id === id ? { ...d, [k]: v } : d));
  const add = () => setDefs((p) => [...p, { id: Date.now(), type: "EMA", len: "20", tf: "1D", name: "IND" + (p.length + 1) }]);
  return (
    <div>
      {defs.map((d) => {
        const cat = IND_CATALOG.find((c) => c.type === d.type) || {};
        return (
          <div key={d.id} style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "nowrap", marginBottom: 8 }}>
            <select value={d.type} onChange={(e) => upd(d.id, "type", e.target.value)} style={{ ...selStyle, flex: "1 1 0", minWidth: 0, padding: "9px 4px" }}>{IND_CATALOG.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}</select>
            <input value={cat.needsLen ? d.len : "—"} onChange={(e) => upd(d.id, "len", e.target.value)} disabled={!cat.needsLen} placeholder="len" className="no-ring mono" style={{ ...selStyle, flex: "0 0 40px", minWidth: 0, textAlign: "center", padding: "9px 2px", opacity: cat.needsLen ? 1 : 0.4 }} />
            <select value={d.tf} onChange={(e) => upd(d.id, "tf", e.target.value)} style={{ ...selStyle, flex: "0 0 56px", minWidth: 0, padding: "9px 2px" }}>{TFS.map((t) => <option key={t}>{t}</option>)}</select>
            <input value={d.name} onChange={(e) => upd(d.id, "name", e.target.value)} placeholder="name" className="no-ring disp" style={{ ...selStyle, flex: "1 1 0", minWidth: 0, fontWeight: 700, padding: "9px 6px" }} />
            <button onClick={() => setDefs((p) => p.filter((x) => x.id !== d.id))} className="tap" style={{ border: "none", background: "transparent", flex: "0 0 auto", padding: 2 }}><Trash2 size={15} color="var(--down)" /></button>
          </div>
        );
      })}
      <button onClick={add} className="tap" style={{ marginTop: 4, border: "1px dashed var(--line)", background: "transparent", borderRadius: 12, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: "var(--primary)", display: "flex", gap: 5, alignItems: "center" }}><Plus size={14} /> Add indicator</button>
      <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 8 }}>Tip: name them (e.g. EMA1, MACD1). Only these appear in your signals below.</div>
    </div>
  );
}
function CondBuilder2({ label, conds, setConds, operands }) {
  const upd = (i, k, v) => setConds((p) => p.map((c, j) => j === i ? { ...c, [k]: v } : c));
  const add = () => setConds((p) => [...p, { la: operands[0] || "Price", op: "<", bType: "num", b: "30", gate: "AND" }]);
  const del = (i) => setConds((p) => p.filter((_, j) => j !== i).map((c, j) => { if (j === 0) { const { gate, ...rest } = c; return rest; } return c; }));
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, marginBottom: 8 }}>{label}</div>
      {conds.map((c, i) => (
        <div key={i} style={{ marginBottom: 4 }}>
          {i > 0 && (
            <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
              {["AND", "OR"].map((g) => (
                <button key={g} onClick={() => upd(i, "gate", g)} className="pill tap disp" style={{ fontSize: 10.5, fontWeight: 800, padding: "3px 14px", border: "1px solid var(--line)", background: (c.gate || "AND") === g ? "var(--primary)" : "transparent", color: (c.gate || "AND") === g ? "var(--on-primary)" : "var(--muted)" }}>{g}</button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", background: "var(--bg)", borderRadius: 12, padding: 8 }}>
            <select value={c.la} onChange={(e) => upd(i, "la", e.target.value)} style={{ ...selStyle, flex: "1 1 104px" }}>{operands.map((o) => <option key={o}>{o}</option>)}</select>
            <select value={c.op} onChange={(e) => upd(i, "op", e.target.value)} style={{ ...selStyle, flex: "1 1 96px" }}>{OPSET.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <div className="pill" style={{ display: "flex", background: "var(--elev)", border: "1px solid var(--line)", padding: 2, flex: "0 0 auto" }}>
              {[["ind", "Ind"], ["num", "#"]].map(([k, l]) => (
                <button key={k} onClick={() => upd(i, "bType", k)} className="pill tap" style={{ fontSize: 10.5, fontWeight: 800, padding: "4px 9px", border: "none", background: c.bType === k ? "var(--primary)" : "transparent", color: c.bType === k ? "var(--on-primary)" : "var(--muted)" }}>{l}</button>
              ))}
            </div>
            {c.bType === "ind"
              ? <select value={c.b} onChange={(e) => upd(i, "b", e.target.value)} style={{ ...selStyle, flex: "1 1 104px" }}>{operands.map((o) => <option key={o}>{o}</option>)}</select>
              : <input value={c.b} onChange={(e) => upd(i, "b", e.target.value)} className="no-ring mono" style={{ ...selStyle, flex: "1 1 64px", textAlign: "center" }} />}
            <button onClick={() => del(i)} disabled={conds.length === 1} className="tap" style={{ border: "none", background: "transparent", opacity: conds.length === 1 ? 0.3 : 1 }}><Trash2 size={15} color="var(--down)" /></button>
          </div>
        </div>
      ))}
      <button onClick={add} className="tap" style={{ marginTop: 10, border: "1px dashed var(--line)", background: "transparent", borderRadius: 12, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: "var(--primary)", display: "flex", gap: 5, alignItems: "center" }}><Plus size={14} /> Add condition</button>
    </div>
  );
}
function NumF({ label, v, set }) {
  return <div style={{ flex: 1 }}><div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600, marginBottom: 5 }}>{label}</div>
    <input value={v} onChange={(e) => set(e.target.value)} className="no-ring mono" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 10, padding: 10, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" }} /></div>;
}

/* ============================== SEARCH OVERLAY ============================== */
function SearchOverlay({ onClose, onOpen, watchlists, addToWatch, createWatchlist }) {
  const [q, setQ] = useState("");
  const res = ALL.filter((s) => (s.sym + s.name).toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 70, maxWidth: 460, margin: "0 auto" }} className="mx">
      <div style={{ display: "flex", gap: 10, padding: 14, alignItems: "center", borderBottom: "1px solid var(--line)" }}>
        <Search size={20} color="var(--muted)" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any stock…" className="no-ring" style={{ flex: 1, border: "none", fontSize: 16, background: "transparent" }} />
        <X size={22} className="tap" onClick={onClose} color="var(--muted)" />
      </div>
      <div className="hide-scroll" style={{ overflowY: "auto", height: "calc(100% - 60px)", padding: "0 14px" }}>
        {res.map((s) => (
          <div key={s.sym} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}><ListRow s={s} market={marketOf(s.sym)} onOpen={(x) => { onOpen(x); }} /></div>
            <WatchAddButton sym={s.sym} watchlists={watchlists} onAdd={addToWatch} onCreate={createWatchlist} />
          </div>
        ))}
        {res.length === 0 && <div style={{ textAlign: "center", color: "var(--muted)", marginTop: 40, fontSize: 14 }}>No matches. Try “TCS”, “NVDA”, “BTC”…</div>}
      </div>
    </div>
  );
}

/* ============================== ONBOARDING ============================== */
function LoginScreen({ onAuthed, onGuest }) {
  const [tab, setTab] = useState("login");
  const [mobile, setMobile] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const field = { width: "100%", background: "rgba(255,255,255,.12)", border: "1px solid rgba(255,255,255,.28)", borderRadius: 14, padding: "14px 16px", fontSize: 15, color: "#fff", outline: "none" };
  const submit = async () => {
    if (mobile.length < 6 || pin.length < 4) { setErr("Enter your mobile number and a 4+ digit PIN."); return; }
    setErr(null); setBusy(true);
    const res = tab === "login" ? await apiLogin(mobile, pin) : await apiRegister(mobile, pin, name);
    setBusy(false);
    if (res && res.ok) onAuthed({ phone: res.userId, name: res.name || name || "" });
    else setErr((res && res.error) || "Something went wrong.");
  };
  return (
    <div className="mx" style={{ position: "fixed", inset: 0, zIndex: 100, background: "linear-gradient(165deg,#232327 0%,#161619 55%,#0C0C0E 100%)", display: "flex", flexDirection: "column", overflow: "auto" }}>
      <style>{`.lginput::placeholder{color:rgba(255,255,255,.55)}`}</style>
      <div style={{ position: "absolute", top: -80, right: -60, width: 280, height: 280, borderRadius: "50%", background: "radial-gradient(circle,rgba(255,255,255,.14),transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: -100, left: -80, width: 320, height: 320, borderRadius: "50%", background: "radial-gradient(circle,rgba(200,200,210,.12),transparent 70%)", pointerEvents: "none" }} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "30px", position: "relative", maxWidth: 460, margin: "0 auto", width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 34 }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 46, color: "#fff", letterSpacing: "-.02em", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 38 }}>✦</span> Matrix
          </div>
          <div style={{ color: "rgba(255,255,255,.7)", fontSize: 12.5, fontWeight: 600, letterSpacing: ".22em", marginTop: 6 }}>SMART TRADING</div>
        </div>

        <div style={{ display: "flex", background: "rgba(255,255,255,.1)", borderRadius: 14, padding: 4, marginBottom: 16 }}>
          {[["login", "Log in"], ["signup", "Sign up"]].map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); setErr(null); }} className="tap disp" style={{ flex: 1, padding: 11, border: "none", borderRadius: 11, fontWeight: 800, fontSize: 13.5, background: tab === k ? "#fff" : "transparent", color: tab === k ? "#141416" : "rgba(255,255,255,.75)" }}>{l}</button>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {tab === "signup" && <input className="lginput" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" style={field} />}
          <input className="lginput mono" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))} inputMode="numeric" placeholder="Mobile number" style={field} />
          <input className="lginput mono" value={pin} onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" type="password" placeholder="PIN (4+ digits)" style={field} />
        </div>
        {err && <div style={{ color: "#FFB3BE", fontSize: 12.5, fontWeight: 600, marginTop: 12 }}>{err}</div>}

        <button onClick={submit} disabled={busy} className="tap disp" style={{ width: "100%", marginTop: 22, background: "#fff", color: "#141416", border: "none", borderRadius: 999, padding: 16, fontWeight: 800, fontSize: 15, letterSpacing: ".02em", opacity: busy ? 0.6 : 1 }}>{busy ? "PLEASE WAIT…" : tab === "login" ? "LOG IN" : "CREATE ACCOUNT"}</button>

        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0" }}>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.25)" }} />
          <span style={{ color: "rgba(255,255,255,.65)", fontSize: 11, fontWeight: 700 }}>OR</span>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.25)" }} />
        </div>

        <button onClick={onGuest} className="tap disp glow" style={{ width: "100%", background: "rgba(255,255,255,.14)", color: "#fff", border: "1.5px solid rgba(255,255,255,.5)", borderRadius: 999, padding: 15, fontWeight: 800, fontSize: 14.5, display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
          <User size={17} /> Continue as guest
        </button>
        <div style={{ textAlign: "center", color: "rgba(255,255,255,.6)", fontSize: 11.5, marginTop: 14 }}>Log in to save your trades, portfolio and automations across visits.</div>
      </div>

      <div style={{ textAlign: "center", color: "rgba(255,255,255,.55)", fontSize: 10.5, padding: "0 30px 26px", position: "relative" }}>Educational research, not investment advice.</div>
    </div>
  );
}
function Onboarding({ onDone, onSkip, initial }) {
  const [step, setStep] = useState(0);
  const [p, setP] = useState(initial || { proficiency: "Beginner", risk: "Balanced", reward: "", style: "Technical", caps: [], sectors: [] });
  const steps = [
    { key: "proficiency", q: "How would you rate your investing skill?", opts: ["Beginner", "Intermediate", "Pro"], multi: false },
    { key: "risk", q: "Your risk appetite?", opts: ["Conservative", "Balanced", "Aggressive"], multi: false },
    { key: "style", q: "Your investing style?", opts: ["Technical", "Fundamental", "News / Event"], multi: false },
    { key: "caps", q: "Preferred market caps?", opts: ["Large", "Mid", "Small"], multi: true },
    { key: "sectors", q: "Any favourite sectors?", opts: ["IT", "Banking", "Auto", "Consumer Tech", "Energy", "Defence"], multi: true },
  ];
  const cur = steps[step];
  const toggle = (o) => {
    if (cur.multi) setP((s) => ({ ...s, [cur.key]: s[cur.key].includes(o) ? s[cur.key].filter((x) => x !== o) : [...s[cur.key], o] }));
    else setP((s) => ({ ...s, [cur.key]: o }));
  };
  const val = p[cur.key];
  const next = () => { if (step < steps.length - 1) setStep(step + 1); else onDone(p); };
  const back = () => { if (step > 0) setStep(step - 1); };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "var(--bg)", maxWidth: 460, margin: "0 auto", padding: 22, display: "flex", flexDirection: "column" }} className="mx">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, marginBottom: 10, minHeight: 38 }}>
        {step > 0 && (
          <button onClick={back} className="tap" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12, width: 38, height: 38, display: "grid", placeItems: "center", color: "var(--ink)" }}><ChevronLeft size={20} /></button>
        )}
        <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>Step {step + 1} of {steps.length}</span>
      </div>
      <div style={{ display: "flex", gap: 5 }}>{steps.map((_, i) => <div key={i} style={{ flex: 1, height: 4, borderRadius: 4, background: i <= step ? "var(--primary)" : "var(--line)" }} />)}</div>
      <div className="disp" style={{ fontWeight: 700, fontSize: 24, marginTop: 30, display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "var(--primary)" }}>✦</span> Matrix</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>Let's personalise your edge.</div>
      <div className="disp" style={{ fontWeight: 700, fontSize: 19, marginTop: 30 }}>{cur.q}</div>
      <div style={{ marginTop: 16, flex: 1 }}>
        {cur.opts.map((o) => {
          const sel = cur.multi ? val.includes(o) : val === o;
          return <button key={o} onClick={() => toggle(o)} className="tap" style={{ width: "100%", textAlign: "left", marginBottom: 10, padding: "15px 16px", borderRadius: 16, border: "1.5px solid " + (sel ? "var(--primary)" : "var(--line)"), background: sel ? "var(--primary-soft)" : "var(--surface)", fontWeight: 600, fontSize: 14.5, display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--ink)" }}>{o}{sel && <Check size={18} color="var(--primary)" />}</button>;
        })}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => (onSkip ? onSkip() : onDone(null))} className="tap" style={{ flex: "0 0 auto", padding: "15px 18px", borderRadius: 16, border: "1px solid var(--line)", background: "var(--surface)", fontWeight: 600, color: "var(--muted)" }}>Skip</button>
        <button onClick={next} className="tap disp glow" style={{ flex: 1, padding: 15, borderRadius: 16, border: "none", background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "#fff", fontWeight: 700, fontSize: 15 }}>{step < steps.length - 1 ? "Continue" : "Enter Matrix"}</button>
      </div>
    </div>
  );
}

/* ============================== PROFILE SHEET ============================== */
function LoginModal({ onClose, onAuthed }) {
  const [tab, setTab] = useState("login");
  const [phone, setPhone] = useState(""); const [pin, setPin] = useState(""); const [name, setName] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const submit = async () => {
    setErr(null); setBusy(true);
    const res = tab === "login" ? await apiLogin(phone, pin) : await apiRegister(phone, pin, name);
    setBusy(false);
    if (res && res.ok) onAuthed({ phone: res.userId, name: res.name || name || "" });
    else setErr((res && res.error) || "Something went wrong.");
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,10,20,.4)", zIndex: 90, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="sheet card" style={{ width: "100%", maxWidth: 460, borderRadius: "24px 24px 0 0", padding: 22 }}>
        <div style={{ width: 40, height: 4, background: "var(--line)", borderRadius: 9, margin: "0 auto 16px" }} />
        <div className="disp" style={{ fontWeight: 700, fontSize: 19 }}>{tab === "login" ? "Log in" : "Create account"}</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>Use your phone number and a PIN to save trades, automations and preferences across visits.</div>
        <div className="pill" style={{ display: "flex", background: "var(--bg)", padding: 4, marginTop: 16 }}>
          {["login", "register"].map((x) => (
            <button key={x} onClick={() => { setTab(x); setErr(null); }} className="pill tap disp" style={{ flex: 1, padding: 9, border: "none", fontWeight: 700, fontSize: 13, background: tab === x ? "var(--primary)" : "transparent", color: tab === x ? "var(--on-primary)" : "var(--muted)" }}>{x === "login" ? "Log in" : "Register"}</button>
          ))}
        </div>
        {tab === "register" && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, marginBottom: 4 }}>Name (optional)</div>
            <input value={name} onChange={(e) => setName(e.target.value)} className="no-ring" style={inpStyle} placeholder="Your name" />
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, marginBottom: 4 }}>Phone number</div>
          <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" className="no-ring mono" style={inpStyle} placeholder="9876543210" />
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, marginBottom: 4 }}>PIN (4+ digits)</div>
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" type="password" className="no-ring mono" style={inpStyle} placeholder="••••" />
        </div>
        {err && <div style={{ fontSize: 12, color: "var(--down)", marginTop: 10, fontWeight: 600 }}>{err}</div>}
        <button onClick={submit} disabled={busy} className="tap disp glow" style={{ width: "100%", marginTop: 16, background: "linear-gradient(120deg,var(--primary),var(--primary-2))", color: "var(--on-primary)", border: "none", borderRadius: 14, padding: 14, fontWeight: 800, fontSize: 14.5, opacity: busy ? 0.6 : 1 }}>{busy ? "Please wait…" : tab === "login" ? "Log in" : "Create account"}</button>
        <button onClick={onClose} className="tap disp" style={{ width: "100%", marginTop: 10, background: "transparent", color: "var(--muted)", border: "none", fontWeight: 700, fontSize: 13 }}>Continue as guest</button>
      </div>
    </div>
  );
}
const inpStyle = { width: "100%", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", fontSize: 15, fontWeight: 700, background: "var(--elev)", color: "var(--ink)" };
// Human-readable summary of the personalisation answers.
function profileSummary(p) {
  if (!p) return null;
  const caps = p.caps && p.caps.length ? p.caps.join(" & ").toLowerCase() + " cap" : "all caps";
  const secs = p.sectors && p.sectors.length ? p.sectors.join(", ") : "all sectors";
  return `${p.risk || "Balanced"}-risk ${(p.proficiency || "Beginner").toLowerCase()} investor with a ${(p.style || "Technical").toLowerCase()}-analysis trading style, interested in ${caps} and ${secs}.`;
}
function ProfileSheet({ profile, walletMap = {}, onClose, onTradeHistory, auth, onLogin, onLogout, onPersonalise }) {
  const WMKTS = [["IN", "🇮🇳 Indian stocks"], ["US", "🇺🇸 US stocks"], ["Crypto", "₿ Crypto"], ["FNO", "⚡ F&O"], ["Commodity", "🪙 Commodity"]];
  const summary = profileSummary(profile);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,10,20,.4)", zIndex: 60, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="sheet card" style={{ width: "100%", maxWidth: 460, borderRadius: "24px 24px 0 0", padding: 20, height: "92vh", overflowY: "auto" }}>
        <div style={{ width: 40, height: 4, background: "var(--line)", borderRadius: 9, margin: "0 auto 16px" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 52, height: 52, borderRadius: 16, background: "linear-gradient(135deg,var(--primary),var(--primary-2))", display: "grid", placeItems: "center", color: "#fff", fontWeight: 700, fontSize: 20 }} className="disp">M</div>
          <div style={{ minWidth: 0 }}>
            <div className="disp" style={{ fontWeight: 700, fontSize: 17 }}>{auth && auth.name ? auth.name : "My Profile"}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{auth ? `Logged in · ${auth.phone}` : "Guest session"}</div>
          </div>
        </div>

        {/* wallets — every market */}
        <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, margin: "18px 2px 8px" }}>VIRTUAL WALLETS</div>
        <div className="card" style={{ padding: "4px 14px", background: "var(--bg)" }}>
          {WMKTS.map(([k, l], i) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: i < WMKTS.length - 1 ? "1px solid var(--line)" : "none" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{l}</span>
              <span className="mono" style={{ fontWeight: 800, fontSize: 14 }}>{fmt(walletMap[k] ?? 0, k)}</span>
            </div>
          ))}
        </div>

        <button onClick={() => { onClose && onClose(); onTradeHistory && onTradeHistory(); }} className="tap disp" style={{ width: "100%", marginTop: 14, background: "var(--primary)", color: "var(--on-primary)", border: "none", borderRadius: 14, padding: 13, fontWeight: 800, fontSize: 13.5, display: "flex", gap: 7, alignItems: "center", justifyContent: "center" }}><Clock size={16} /> Trade history</button>

        {/* personalisation summary */}
        <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, margin: "20px 2px 8px" }}>YOUR INVESTOR PROFILE</div>
        <div className="card metal" style={{ padding: 14, background: "var(--feature-grad)", color: "#fff" }}>
          {summary ? (
            <div style={{ fontSize: 13, lineHeight: 1.6, fontWeight: 600 }}>{summary}</div>
          ) : (
            <div style={{ fontSize: 13, lineHeight: 1.6, opacity: .9 }}>You haven't personalised Matrix yet. Answer a few quick questions and your picks, ideas and screens will be tuned to how you invest.</div>
          )}
        </div>
        {profile && (
          <div style={{ marginTop: 10 }}>
            {[["Skill", profile.proficiency], ["Risk", profile.risk], ["Style", profile.style], ["Caps", (profile.caps || []).join(", ") || "All"], ["Sectors", (profile.sectors || []).join(", ") || "All"]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "10px 2px", borderBottom: "1px solid var(--line)", fontSize: 13 }}><span style={{ color: "var(--muted)" }}>{k}</span><span style={{ fontWeight: 600, textAlign: "right", maxWidth: "62%" }}>{v}</span></div>
            ))}
          </div>
        )}

        {/* personalize */}
        <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 700, margin: "20px 2px 8px" }}>PERSONALIZE</div>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.6 }}>Changed how you invest? Retake the quick questions and Matrix will re-tune your picks, ideas and screens.</div>
          <button onClick={() => { onClose && onClose(); onPersonalise && onPersonalise(); }} className="tap disp" style={{ width: "100%", marginTop: 12, background: "var(--surface)", color: "var(--primary)", border: "1px solid var(--primary)", borderRadius: 12, padding: 11, fontWeight: 800, fontSize: 13, display: "flex", gap: 7, alignItems: "center", justifyContent: "center" }}><Sparkles size={15} /> {profile ? "Update my answers" : "Personalise Matrix"}</button>
        </div>

        {auth ? (
          <button onClick={() => { onClose && onClose(); onLogout && onLogout(); }} className="tap disp" style={{ width: "100%", margin: "16px 0 8px", background: "var(--surface)", color: "var(--down)", border: "1px solid var(--line)", borderRadius: 14, padding: 12, fontWeight: 800, fontSize: 13.5, display: "flex", gap: 7, alignItems: "center", justifyContent: "center" }}><LogOut size={16} /> Log out</button>
        ) : (
          <button onClick={() => { onClose && onClose(); onLogin && onLogin(); }} className="tap disp" style={{ width: "100%", margin: "16px 0 8px", background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 14, padding: 12, fontWeight: 800, fontSize: 13.5, display: "flex", gap: 7, alignItems: "center", justifyContent: "center" }}><LogIn size={16} /> Log in / Register</button>
        )}
      </div>
    </div>
  );
}
/* ---- Trade history (filters hoisted OUT so dropdowns don't remount) ---- */
/* ---- Multi-select filter: renders as a bottom sheet so it can never be
       clipped by a scrolling row (the old absolute dropdown was). ---- */
function FilterChip({ label, options, sel, setter, colors, open, setOpen }) {
  const isOpen = open === label;
  const toggle = (v) => setter(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : label); }} className="pill tap disp" style={{ flex: "0 0 auto", padding: "7px 12px", fontSize: 11.5, fontWeight: 700, border: "1px solid " + (sel.length ? "var(--primary)" : "var(--line)"), background: sel.length ? "var(--primary-soft)" : "var(--surface)", color: sel.length ? "var(--primary)" : "var(--ink)", display: "flex", gap: 5, alignItems: "center", whiteSpace: "nowrap" }}>
        {label}{sel.length ? ` (${sel.length})` : ""}<ChevronRight size={13} style={{ transform: "rotate(90deg)" }} />
      </button>
      {isOpen && (
        <div onClick={(e) => { e.stopPropagation(); setOpen(null); }} style={{ position: "fixed", inset: 0, background: "rgba(10,10,20,.45)", zIndex: 95, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()} className="sheet card" style={{ width: "100%", maxWidth: 460, borderRadius: "22px 22px 0 0", padding: 18, maxHeight: "70vh", display: "flex", flexDirection: "column" }}>
            <div style={{ width: 40, height: 4, background: "var(--line)", borderRadius: 9, margin: "0 auto 14px", flex: "0 0 auto" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flex: "0 0 auto" }}>
              <span className="disp" style={{ fontWeight: 800, fontSize: 15 }}>{label}</span>
              {sel.length > 0 && <button onClick={() => setter([])} className="tap disp" style={{ border: "none", background: "transparent", color: "var(--primary)", fontWeight: 700, fontSize: 12.5 }}>Clear</button>}
            </div>
            <div style={{ overflowY: "auto", marginTop: 10, flex: 1 }}>
              {options.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)", padding: 16, textAlign: "center" }}>No {label.toLowerCase()} options in your history yet.</div> : options.map((o) => {
                const on = sel.includes(o);
                return (
                  <button key={o} onClick={() => toggle(o)} className="tap disp" style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 6px", border: "none", borderBottom: "1px solid var(--line)", background: "transparent", color: "var(--ink)", fontSize: 13.5, fontWeight: 600, textAlign: "left" }}>
                    <span style={{ width: 19, height: 19, borderRadius: 6, border: "1.5px solid " + (on ? "var(--primary)" : "var(--line)"), background: on ? "var(--primary)" : "transparent", display: "grid", placeItems: "center", flexShrink: 0 }}>{on && <Check size={13} color="var(--on-primary)" />}</span>
                    <span style={{ color: colors ? colors(o) : "var(--ink)" }}>{o}</span>
                  </button>
                );
              })}
            </div>
            <button onClick={() => setOpen(null)} className="tap disp" style={{ width: "100%", marginTop: 12, background: "var(--primary)", color: "var(--on-primary)", border: "none", borderRadius: 13, padding: 13, fontWeight: 800, fontSize: 13.5, flex: "0 0 auto" }}>Done{sel.length ? ` · ${sel.length} selected` : ""}</button>
          </div>
        </div>
      )}
    </>
  );
}
function TradeHistory({ userId, trades, onClose }) {
  const RANGES = [["today", "Today"], ["7", "7d"], ["30", "30d"], ["90", "90d"], ["365", "1y"], ["all", "All"]];
  const MKTS = [["all", "All markets"], ["IN", "🇮🇳 Indian"], ["US", "🇺🇸 US"], ["Crypto", "₿ Crypto"], ["FNO", "⚡ F&O"], ["Commodity", "🪙 Commodity"]];
  const [range, setRange] = useState("30");
  const [mkt, setMkt] = useState("all");
  const [remote, setRemote] = useState(null);
  const [fSym, setFSym] = useState([]);
  const [fType, setFType] = useState([]);
  const [fExit, setFExit] = useState([]);
  const [openF, setOpenF] = useState(null);
  const now = Date.now();
  const from = useMemo(() => {
    if (range === "all") return 0;
    if (range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    return Date.now() - (+range) * 86400000;
  }, [range]);
  useEffect(() => { let stop = false; setRemote(null); if (BACKEND_URL) fetchTrades(userId, from, Date.now()).then((t) => { if (!stop && t) setRemote(t); }).catch(() => {}); return () => { stop = true; }; }, [range, userId]);

  const isOpen = (t) => t.exitAt == null || t.exit == null || t.exitType === "Open";
  // Live P&L for still-open positions, using the current price.
  const withPnl = (t) => {
    if (!isOpen(t)) return { ...t, livePnl: t.pnl || 0, open: false };
    const s = ALL.find((a) => a.sym === t.sym);
    const cur = s ? s.price : t.entry;
    return { ...t, open: true, cur, livePnl: +((cur - t.entry) * (t.qty || 1)).toFixed(2) };
  };
  const src = (remote || trades)
    .filter((t) => (isOpen(t) ? (t.entryAt || 0) : (t.exitAt || t.entryAt || 0)) >= from)
    .map(withPnl);
  const allSyms = [...new Set(src.map((t) => t.sym))].sort();
  const TYPES = ["Manual", "Automate", "Auto Buy"];
  const EXITS = ["Manual", "Exit trigger", "Stop loss", "Trailing stop", "Open"];
  const exitOf = (t) => (t.open ? "Open" : (t.exitType || "Manual"));
  const rows = src
    .filter((t) => (mkt === "all" ? true : (t.market || "IN") === mkt))
    .filter((t) => (fSym.length ? fSym.includes(t.sym) : true))
    .filter((t) => (fType.length ? fType.includes(t.tradeType || "Manual") : true))
    .filter((t) => (fExit.length ? fExit.includes(exitOf(t)) : true))
    .sort((a, b) => (b.exitAt || b.entryAt || 0) - (a.exitAt || a.entryAt || 0));
  const dt = (ms) => ms ? new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  const totalPnl = rows.reduce((a, t) => a + (t.livePnl || 0), 0);
  const openN = rows.filter((t) => t.open).length;
  const typeColor = (tt) => tt === "Auto Buy" ? "var(--primary)" : tt === "Automate" ? "#8B5CF6" : "var(--muted)";
  const exitColor = (et) => (et === "Stop loss" || et === "Trailing stop") ? "var(--down)" : et === "Exit trigger" ? "var(--up)" : et === "Open" ? "var(--primary)" : "var(--muted)";

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 80, display: "flex", flexDirection: "column" }} onClick={() => setOpenF(null)}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 16px 12px", borderBottom: "1px solid var(--line)" }}>
        <button onClick={onClose} className="tap" style={{ border: "none", background: "var(--elev)", borderRadius: 11, width: 36, height: 36, display: "grid", placeItems: "center" }}><ChevronLeft size={18} /></button>
        <div>
          <div className="disp" style={{ fontWeight: 700, fontSize: 17 }}>Trade history</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{rows.length} trades{openN ? ` · ${openN} open` : ""} · P&amp;L {totalPnl >= 0 ? "+" : ""}{fmt(totalPnl, mkt === "all" ? "IN" : mkt)}</div>
        </div>
      </div>

      {/* market selector */}
      <div className="hide-scroll" style={{ display: "flex", gap: 7, overflowX: "auto", padding: "10px 16px 4px" }}>
        {MKTS.map(([k, l]) => (
          <button key={k} onClick={() => setMkt(k)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "7px 13px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", border: "1px solid " + (mkt === k ? "var(--primary)" : "var(--line)"), background: mkt === k ? "var(--primary)" : "var(--surface)", color: mkt === k ? "var(--on-primary)" : "var(--ink)" }}>{l}</button>
        ))}
      </div>

      {/* timeframe */}
      <div className="hide-scroll" style={{ display: "flex", gap: 7, overflowX: "auto", padding: "8px 16px 4px" }}>
        {RANGES.map(([k, l]) => (
          <button key={k} onClick={() => setRange(k)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "7px 14px", fontSize: 12, fontWeight: 700, border: "1px solid " + (range === k ? "var(--primary)" : "var(--line)"), background: range === k ? "var(--primary)" : "var(--surface)", color: range === k ? "var(--on-primary)" : "var(--ink)" }}>{l}</button>
        ))}
      </div>

      {/* multi-select filters */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", padding: "6px 16px 10px" }}>
        <FilterChip label="Symbol" options={allSyms} sel={fSym} setter={setFSym} open={openF} setOpen={setOpenF} />
        <FilterChip label="Trade type" options={TYPES} sel={fType} setter={setFType} colors={typeColor} open={openF} setOpen={setOpenF} />
        <FilterChip label="Exit type" options={EXITS} sel={fExit} setter={setFExit} colors={exitColor} open={openF} setOpen={setOpenF} />
        {(fSym.length || fType.length || fExit.length) ? <button onClick={() => { setFSym([]); setFType([]); setFExit([]); }} className="pill tap disp" style={{ flex: "0 0 auto", padding: "7px 12px", fontSize: 11.5, fontWeight: 700, border: "1px solid var(--line)", background: "var(--elev)", color: "var(--muted)", whiteSpace: "nowrap" }}>Clear all</button> : null}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 24px" }}>
        {rows.length === 0 ? (
          <div className="card" style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No trades match. Buys show as <b>Open</b> until you sell; manual, auto-buy and automate trades all record here.</div>
        ) : rows.map((t) => (
          <div key={t.id} className="card" style={{ marginTop: 10, padding: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ minWidth: 0 }}><span className="disp" style={{ fontWeight: 700, fontSize: 14 }}>{t.sym}</span> <span style={{ fontSize: 11, color: "var(--muted)" }}>×{t.qty}</span></div>
              <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                <div className="mono" style={{ fontWeight: 800, fontSize: 14, color: (t.livePnl || 0) >= 0 ? "var(--up)" : "var(--down)" }}>{(t.livePnl || 0) >= 0 ? "+" : ""}{fmt(t.livePnl || 0, t.market || "IN")}</div>
                {t.open && <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 700 }}>unrealised</div>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <span className="pill" style={{ fontSize: 9.5, fontWeight: 800, padding: "3px 8px", background: "var(--elev)", color: typeColor(t.tradeType || "Manual") }}>{t.tradeType || "Manual"}</span>
              <span className="pill" style={{ fontSize: 9.5, fontWeight: 800, padding: "3px 8px", background: t.open ? "var(--primary-soft)" : "var(--elev)", color: exitColor(exitOf(t)) }}>Exit: {exitOf(t)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 9, fontSize: 11 }}>
              <div><div style={{ color: "var(--muted)", fontSize: 9.5 }}>Entry</div><div className="mono" style={{ fontWeight: 700 }}>{fmt(t.entry, t.market || "IN")}</div><div style={{ color: "var(--muted)", fontSize: 9.5 }}>{dt(t.entryAt)}</div></div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "var(--muted)", fontSize: 9.5 }}>{t.open ? "Current" : "Exit"}</div>
                <div className="mono" style={{ fontWeight: 700 }}>{fmt(t.open ? t.cur : t.exit, t.market || "IN")}</div>
                <div style={{ color: "var(--muted)", fontSize: 9.5 }}>{t.open ? "position open" : dt(t.exitAt)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================== ROOT ============================== */
export default function App() {
  const [theme, setTheme] = useState("light");
  const [authed, setAuthed] = useState(() => !!lsGet("mx_auth", null));
  const [guest, setGuest] = useState(false);
  const [onboardSkipped, setOnboardSkipped] = useState(false);
  const [profile, setProfile] = useState(null);
  const [repersonalise, setRepersonalise] = useState(false);
  const [tab, setTab] = useState("home");
  const [market, setMarket] = useState("IN");
  const [segment, setSegment] = useState("Stocks");
  const [walletMap, setWalletMap] = useState({ IN: 1000000, US: 1000000, Crypto: 1000000, FNO: 1000000, Commodity: 1000000 });
  const wallet = walletMap[market] ?? 1000000;
  const adjustWallet = (mkt, delta) => setWalletMap((w) => ({ ...w, [mkt]: (w[mkt] ?? 1000000) + delta }));
  const [portfolio, setPortfolio] = useState([]);
  const [guestId] = useState(getUserId);
  const [auth, setAuth] = useState(() => lsGet("mx_auth", null));   // { phone, name } when logged in, else null
  const userId = auth ? "ph_" + auth.phone : guestId;
  const [loginOpen, setLoginOpen] = useState(false);
  const doLogout = () => { setAuth(null); lsSet("mx_auth", null); };
  const onAuthed = (a) => { setAuth(a); lsSet("mx_auth", a); setLoginOpen(false); };
  const [trades, setTrades] = useState([]);
  const [histOpen, setHistOpen] = useState(false);
  const [hydratedUser, setHydratedUser] = useState(null);
  const recordTrade = (t) => {
    const rec = { id: t.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, tradeType: t.tradeType || "Manual", exitType: t.exitType || "Manual", ...t };
    if (!rec.tradeType) rec.tradeType = "Manual";
    if (!rec.exitType) rec.exitType = "Manual";
    setTrades((p) => { if (rec.id && p.some((x) => x.id === rec.id)) return p; return [rec, ...p].slice(0, 5000); });
    postTrade(userId, rec);
  };
  // Record simulated auto-buy / automate trades once per day (deduped by stable id).
  const recordBatch = (list) => { list.forEach((t) => recordTrade(t)); };
  // ---- REAL EXIT ENGINE ----
  // Every minute, check each OPEN position that has a target/stop against real
  // intraday candles. If a level was actually touched, close the position at that
  // real price/time, credit the wallet, and write the realised P&L to history.
  const resolving = useRef(false);
  useEffect(() => {
    if (!BACKEND_URL) return;                       // needs the live backend
    // Apply a closed trade locally: credit wallet, reduce the holding, notify.
    const applyClose = (t, closed) => {
      const qty = closed.qty || t.qty || 1;
      setTrades((p) => p.map((x) => (x.id === t.id ? closed : x)));
      adjustWallet(closed.market || "IN", closed.exit * qty);
      setPortfolio((p) => p.map((x) => x.sym === closed.sym ? { ...x, qty: x.qty - qty } : x).filter((x) => x.qty > 0));
      const pnl = closed.pnl || 0;
      setBuyToast({ t: `${closed.sym} auto-exited at ${fmt(closed.exit, closed.market || "IN")} (${closed.exitType}) · P&L ${pnl >= 0 ? "+" : ""}${fmt(pnl, closed.market || "IN")}`, e: pnl < 0 });
    };
    const tick = async () => {
      if (resolving.current) return;
      resolving.current = true;
      try {
        // 1) SYNC: the server-side monitor may have closed positions while the app
        //    was shut. Pull them in and settle the wallet/portfolio accordingly.
        const remote = await fetchTrades(userId, 0, Date.now());
        if (remote && remote.length) {
          const byId = new Map(remote.map((r) => [r.id, r]));
          trades.forEach((t) => {
            if (t.exitAt != null) return;                   // already closed locally
            const r = byId.get(t.id);
            if (r && r.exitAt != null) applyClose(t, r);    // server closed it
          });
        }
        // 2) FALLBACK: resolve anything still open in-app (e.g. monitor disabled).
        const open = trades.filter((t) => {
          if (t.exitAt != null) return false;
          const h = portfolio.find((x) => x.sym === t.sym);
          return !!(t.tp || t.sl || t.tsl || (h && (h.tp || h.sl || h.tsl)));
        });
        for (const t of open.slice(0, 6)) {
          const h = portfolio.find((x) => x.sym === t.sym);
          const risk = h ? { tp: h.tp ?? t.tp, sl: h.sl ?? t.sl, tsl: h.tsl ?? t.tsl } : {};
          const hit = await resolveExitFromCandles(t, risk);
          if (!hit) continue;
          const qty = Math.min(t.qty || 1, h ? h.qty : (t.qty || 1));
          if (qty < 1) continue;
          const closed = { ...t, ...hit, qty, pnl: +((hit.exit - t.entry) * qty).toFixed(2) };
          applyClose(t, closed);
          postTrade(userId, closed);
        }
      } catch (e) { /* transient network issues shouldn't break the loop */ }
      finally { resolving.current = false; }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [trades, portfolio, userId]);

  // Portfolio price snapshot — frozen until the user buys or sells (portfolio changes).
  const [priceSnap, setPriceSnap] = useState({});
  useEffect(() => {
    setPriceSnap((prev) => { const m = { ...prev }; portfolio.forEach((h) => { const s = ALL.find((a) => a.sym === h.sym); m[h.sym] = s ? s.price : (prev[h.sym] ?? h.buy); }); return m; });
  }, [portfolio]);
  const [watchlists, setWatchlists] = useState([{ id: "w1", name: "My Watchlist", syms: ["ETERNAL", "TATAPOWER"] }]);
  const [activeWl, setActiveWl] = useState("w1");
  // Load this user's saved data whenever the user changes (login / logout).
  useEffect(() => {
    const st = lsGet("mx_state_" + userId, null);
    setPortfolio((st && st.portfolio) || []);
    setWalletMap((st && st.walletMap) || { IN: 1000000, US: 1000000, Crypto: 1000000, FNO: 1000000, Commodity: 1000000 });
    const wl = (st && st.watchlists) || [{ id: "w1", name: "My Watchlist", syms: ["ETERNAL", "TATAPOWER"] }];
    setWatchlists(wl); setActiveWl(wl[wl.length - 1] ? wl[wl.length - 1].id : "w1");
    setProfile((st && st.profile) || null);
    setOnboardSkipped(!!(st && st.onboardSkipped));
    setTrades(lsGet("mx_trades_" + userId, []));
    setHydratedUser(userId);
    if (BACKEND_URL) fetchTrades(userId, 0, Date.now()).then((t) => { if (t && t.length) setTrades(t); }).catch(() => {});
  }, [userId]);
  // Persist per-user (only after this user's data has been hydrated, to avoid clobbering).
  useEffect(() => { if (hydratedUser === userId) lsSet("mx_state_" + userId, { portfolio, walletMap, watchlists, profile, onboardSkipped }); }, [portfolio, walletMap, watchlists, profile, onboardSkipped, hydratedUser, userId]);
  useEffect(() => { if (hydratedUser === userId) lsSet("mx_trades_" + userId, trades); }, [trades, hydratedUser, userId]);
  const [drawer, setDrawer] = useState(null);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [tradePreset, setTradePreset] = useState(null);
  const [buyToast, setBuyToast] = useState(null);
  useEffect(() => { if (!buyToast) return; const t = setTimeout(() => setBuyToast(null), 3200); return () => clearTimeout(t); }, [buyToast]);
  const [live, setLive] = useState(false);
  const [liveAt, setLiveAt] = useState(null);
  const [, setLiveTick] = useState(0);

  // Refresh prices / indicators / news every 1 minute (only the selected market's symbols).
  const REFRESH_MS = 60000;   // 1 minute
  useEffect(() => {
    let stop = false;
    const syms = (UNIVERSE[market] || []).map((a) => a.sym);
    const pullLive = async () => {
      try {
        const rows = await fetchLiveQuotes(syms);
        if (stop || !rows || !rows.length) { setLive(false); return; }
        let n = 0;
        rows.forEach((r) => { const s = ALL.find((a) => a.sym === r.sym); if (s) { s.price = r.price; s.chg = r.chg; n++; } });
        if (n) { setLive(true); setLiveAt(Date.now()); setLiveTick((t) => t + 1); } else setLive(false);
      } catch { setLive(false); }
    };
    // REAL indicators + REAL volume, computed by the backend from actual candles.
    const pullIndicators = async () => {
      try {
        const ind = await fetchIndicators(syms);
        if (stop || !ind) return;
        let n = 0;
        Object.keys(ind).forEach((ySym) => {
          const s = ALL.find((a) => yahooSymbol(a.sym) === ySym || a.sym === ySym);
          if (!s) return;
          Object.assign(s, ind[ySym], { hasData: true });
          n++;
        });
        if (n) setLiveTick((t) => t + 1);
      } catch { /* leave indicators null -> UI shows "—" */ }
    };
    const pullFundamentals = async () => {
      try {
        const f = await fetchFundamentals(syms);
        if (stop || !f) return;
        Object.keys(f).forEach((ySym) => {
          const s = ALL.find((a) => yahooSymbol(a.sym) === ySym || a.sym === ySym);
          if (s) Object.assign(s, f[ySym]);        // pe, roe, revGrowth, marketCap, inst (real holders)
        });
        setLiveTick((t) => t + 1);
      } catch { /* leave null -> UI shows "—" */ }
    };
    const refresh = () => { if (BACKEND_URL) { pullLive(); pullIndicators(); pullFundamentals(); } };   // no synthetic fallback: no data = no numbers
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => { stop = true; clearInterval(id); };
  }, [market]);

  const watch = useMemo(() => [...new Set(watchlists.flatMap((w) => w.syms))], [watchlists]);
  const toggleWatch = (sym) => setWatchlists((p) => p.map((w) => w.id === activeWl ? { ...w, syms: w.syms.includes(sym) ? w.syms.filter((x) => x !== sym) : [...w.syms, sym] } : w));
  const addToWatch = (sym, listId) => setWatchlists((p) => p.map((w) => w.id === (listId || activeWl) ? (w.syms.includes(sym) ? w : { ...w, syms: [...w.syms, sym] }) : w));
  const createWatchlist = (name) => { const id = "w" + Date.now(); setWatchlists((p) => [...p, { id, name: name && name.trim() ? name.trim() : "List " + (p.length + 1), syms: [] }]); setActiveWl(id); return id; };
  const deleteWatchlist = (id) => setWatchlists((p) => { const n = p.filter((w) => w.id !== id); if (!n.length) { setActiveWl("w1"); return [{ id: "w1", name: "My Watchlist", syms: [] }]; } if (id === activeWl) setActiveWl(n[0].id); return n; });
  const openStock = (s) => { setSearch(false); setDrawer(s); };
  const openDetail = (s) => { setDrawer(null); setDetail(s); };
  const goTrade = (s) => { setDetail(null); setTradePreset(s); setTab("trade"); };
  const buyStock = (s, qty = 1, opts = {}) => {
    const mkt = marketOf(s.sym);
    const cost = s.price * qty;
    if (cost > (walletMap[mkt] ?? 0)) { setBuyToast({ t: `Not enough virtual funds in your ${MKT_LABEL[mkt] || mkt} wallet.`, e: true }); return false; }
    adjustWallet(mkt, -cost);
    setPortfolio((p) => {
      const ex = p.find((h) => h.sym === s.sym);
      if (ex) { const tq = ex.qty + qty; return p.map((h) => h.sym === s.sym ? { ...h, qty: tq, buy: (h.buy * h.qty + cost) / tq, ...opts } : h); }
      return [...p, { sym: s.sym, name: s.name, qty, buy: s.price, date: Date.now(), ...opts }];
    });
    setBuyToast({ t: `Bought ${qty} ${s.sym} @ ${fmt(s.price, mkt)} — added to portfolio.`, e: false });
    recordTrade({ sym: s.sym, name: s.name, entry: s.price, entryAt: Date.now(), exit: null, exitAt: null, pnl: null, qty, market: mkt, tradeType: opts.tradeType || "Manual", exitType: "Open", tp: opts.tp, sl: opts.sl });
    return true;
  };
  const sellStock = (s, qty = 1) => {
    const mkt = marketOf(s.sym);
    const held = portfolio.find((h) => h.sym === s.sym);
    if (!held || held.qty < 1) { setBuyToast({ t: `You don't hold ${s.sym}.`, e: true }); return false; }
    const sellQty = Math.min(qty, held.qty);
    const proceeds = s.price * sellQty;
    adjustWallet(mkt, +proceeds);
    recordTrade({ sym: s.sym, name: s.name || held.name, entry: held.buy, entryAt: held.date, exit: s.price, exitAt: Date.now(), pnl: +((s.price - held.buy) * sellQty).toFixed(2), qty: sellQty, market: mkt, tradeType: "Manual", exitType: "Manual" });
    setPortfolio((p) => p.map((h) => h.sym === s.sym ? { ...h, qty: h.qty - sellQty } : h).filter((h) => h.qty > 0));
    setBuyToast({ t: `Sold ${sellQty} ${s.sym} @ ${fmt(s.price, mkt)} — credited to wallet.`, e: false });
    return true;
  };
  const updateHolding = (sym, patch) => {
    setPortfolio((p) => p.map((h) => h.sym === sym ? { ...h, ...patch } : h));
    // Push the new risk orders onto the OPEN trade too, and sync to the backend so
    // the server-side monitor can honour them even while the app is closed.
    setTrades((p) => p.map((t) => {
      if (t.sym !== sym || t.exitAt != null) return t;
      const upd = { ...t, tp: patch.tp, sl: patch.sl, tsl: patch.tsl };
      postTrade(userId, upd);
      return upd;
    }));
  };

  // personalised ordering for picks
  const list = useMemo(() => {
    let arr = [...UNIVERSE[market]];
    if (profile) {
      arr.sort((a, b) => {
        const score = (s) => (profile.caps.length && profile.caps.includes(s.cap) ? 3 : 0) + (profile.sectors.includes(s.sector) ? 3 : 0) + (profile.risk === "Aggressive" ? s.chg : profile.risk === "Conservative" ? -Math.abs(s.chg) + (s.cap === "Large" ? 2 : 0) : (s.rsi != null ? (s.rsi - 50) / 10 : 0));
        return score(b) - score(a);
      });
    }
    return arr;
  }, [market, profile]);

  const nav = [["home", Home, "Home"], ["ideas", Lightbulb, "Ideas"], ["ask", Bot, "Ask"], ["automation", Bolt, "Auto"], ["portfolio", Briefcase, "Portfolio"], ["watchlist", Star, "Watch"]];

  return (
    <div className={"mx theme-" + theme} style={{ background: "var(--app-bg, var(--bg))", minHeight: "100vh" }}>
      <style>{CSS}</style>
      {/* fixed gradient backdrop so it stays behind scroll */}
      <div style={{ position: "fixed", inset: 0, background: "var(--app-bg, var(--bg))", zIndex: 0, pointerEvents: "none" }} />
      {!authed && <LoginScreen onGuest={() => { setGuest(true); setAuthed(true); }} onAuthed={(a) => { onAuthed(a); setGuest(false); setAuthed(true); }} />}
      {authed && hydratedUser === userId && (repersonalise || (!profile && !onboardSkipped)) && (
        <Onboarding
          initial={repersonalise ? profile : null}
          onDone={(p) => { setProfile(p); setRepersonalise(false); setOnboardSkipped(true); }}
          onSkip={() => { setOnboardSkipped(true); setRepersonalise(false); }}
        />
      )}

      <div style={{ maxWidth: 460, margin: "0 auto", minHeight: "100vh", position: "relative", zIndex: 1, paddingBottom: 86 }}>
        {/* ambient glow */}
        <div style={{ position: "absolute", top: -80, left: "50%", transform: "translateX(-50%)", width: 420, height: 320, background: "radial-gradient(circle, rgba(150,150,160,.12), transparent 70%)", pointerEvents: "none", zIndex: 0 }} />
        {/* HEADER */}
        <div className="glass" style={{ position: "sticky", top: 0, zIndex: 30, background: "var(--header-bg)", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px 8px", gap: 8 }}>
            <div onClick={() => { setTab("home"); setDetail(null); }} className="tap disp" style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span style={{ color: "var(--primary)", fontSize: 19 }}>✦</span>
              <span className="gradtext" style={{ fontWeight: 700, fontSize: 20 }}>Matrix</span>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginLeft: 3 }}>
                <span className="pill" title={`${market} market ${marketOpen(market) ? "open" : "closed"} · ${marketHoursLabel(market)}. Prices refresh every minute.${live ? " Live Yahoo feed." : " Simulated feed — connect the proxy for real data."}`} style={{ fontSize: 8, fontWeight: 800, letterSpacing: ".04em", padding: "2px 6px", display: "flex", alignItems: "center", gap: 3, background: marketOpen(market) ? "var(--up-soft)" : "var(--primary-soft)", color: marketOpen(market) ? "var(--up)" : "var(--muted)" }}>
                  <span style={{ width: 4, height: 4, borderRadius: 4, background: marketOpen(market) ? "var(--up)" : "var(--muted)" }} />{live ? "LIVE" : BACKEND_URL ? (marketOpen(market) ? "NO DATA" : "CLOSED") : "NO DATA"}
                </span>
                {liveAt && <span style={{ fontSize: 8.5, color: "var(--muted)", fontWeight: 700 }}>{new Date(liveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
              <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="tap pill" style={{ width: 34, height: 34, display: "grid", placeItems: "center", background: "var(--elev)", border: "1px solid var(--line)", color: "var(--ink)" }}>
                {theme === "dark" ? <Sun size={16} /> : <Moon size={15} />}
              </button>
              <div onClick={() => setShowProfile(true)} className="tap pill gold-border" style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 11px", whiteSpace: "nowrap", flexShrink: 0 }}>
                <Wallet size={15} color="var(--gold)" />
              </div>
              <div onClick={() => setShowProfile(true)} className="tap glow" style={{ width: 34, height: 34, borderRadius: 11, background: "var(--feature-grad)", display: "grid", placeItems: "center", color: "#fff", flexShrink: 0 }}><User size={17} /></div>
            </div>
          </div>
          <div style={{ padding: "0 18px 14px" }}>
            <div onClick={() => setSearch(true)} className="tap" style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--elev)", border: "1px solid var(--line)", borderRadius: 14, padding: "11px 13px", color: "var(--muted)", fontSize: 13.5 }}>
              <Search size={17} /> Search any stock, crypto or commodity…
            </div>
          </div>
          {!detail && ["home", "ideas", "automation", "portfolio"].includes(tab) && (
            <div className="hide-scroll" style={{ display: "flex", gap: 8, overflowX: "auto", padding: "0 18px 12px" }}>
              {[["IN", "🇮🇳 Indian"], ["US", "🇺🇸 US"], ["Crypto", "₿ Crypto"], ["FNO", "⚡ F&O"], ["Commodity", "🪙 Commodity"]].map(([k, l]) => (
                <button key={k} onClick={() => setMarket(k)} className="pill tap disp" style={{ flex: "0 0 auto", padding: "8px 14px", fontWeight: 700, fontSize: 12.5, border: "1px solid " + (market === k ? "var(--primary)" : "var(--line)"), background: market === k ? "var(--primary)" : "var(--surface)", color: market === k ? "var(--on-primary)" : "var(--ink)" }}>{l}</button>
              ))}
            </div>
          )}
        </div>

        {/* BODY */}
        <div style={{ padding: "0 18px", position: "relative", zIndex: 1 }}>
          {detail ? (
            <DetailPage s={detail} onBack={() => setDetail(null)} watched={watch.includes(detail.sym)} toggleWatch={toggleWatch} onTrade={goTrade} onBuy={buyStock} />
          ) : (
            <>
              {tab === "home" && <HomeView market={market} setMarket={setMarket} segment={segment} setSegment={setSegment} list={list} onOpen={openStock} onBuy={buyStock} watch={watch} toggleWatch={toggleWatch} profile={profile} portfolio={portfolio} wallet={wallet} onGoPortfolio={() => { setDetail(null); setTab("portfolio"); }} onRecord={recordTrade} watchlists={watchlists} addToWatch={addToWatch} createWatchlist={createWatchlist} trades={trades} />}
              {tab === "trade" && <TradeView walletMap={walletMap} adjustWallet={adjustWallet} portfolio={portfolio} setPortfolio={setPortfolio} preset={tradePreset} market={market} recordTrade={recordTrade} />}
              {tab === "ideas" && <Ideas onOpen={openStock} onBuy={buyStock} market={market} />}
              {tab === "automation" && <Automation market={market} onRecord={recordTrade} onBuyReal={buyStock} />}
              {tab === "portfolio" && <Portfolio portfolio={portfolio} wallet={wallet} market={market} onGoHome={() => { setDetail(null); setTab("home"); }} onBuy={buyStock} onSell={sellStock} onUpdate={updateHolding} priceSnap={priceSnap} />}
              {tab === "watchlist" && <WatchlistView watchlists={watchlists} activeWl={activeWl} setActiveWl={setActiveWl} createWatchlist={createWatchlist} deleteWatchlist={deleteWatchlist} toggleWatch={toggleWatch} onOpen={openStock} />}
              {tab === "ask" && (
                <div className="fade">
                  <div className="disp" style={{ fontWeight: 700, fontSize: 20, marginTop: 6 }}>Ask Matrix</div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>Your AI markets expert. Ask about any stock, sector or strategy.</div>
                  <div className="card" style={{ padding: 14, height: 520 }}>
                    <ChatPanel suggestions={["Is it a good time to buy Indian IT?", "Explain RSI vs MACD simply", "Build me a swing-trade checklist", "What sectors look strong now?"]} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* BOTTOM NAV */}
        {!detail && (
          <div className="glass" style={{ position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 460, margin: "0 auto", background: "var(--header-bg)", borderTop: "1px solid var(--line)", borderRadius: "22px 22px 0 0", boxShadow: "0 -10px 34px rgba(40,10,80,.3)", display: "flex", padding: "9px 4px 11px", zIndex: 40 }}>
            {nav.map(([k, Icon, label]) => (
              <button key={k} onClick={() => { setTab(k); setTradePreset(null); }} className="tap" style={{ flex: 1, border: "none", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, color: tab === k ? "var(--primary)" : "var(--muted)" }}>
                <Icon size={20} fill={k === "watchlist" && tab === k ? "var(--primary)" : "none"} />
                <span style={{ fontSize: 9.5, fontWeight: 700 }}>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {drawer && <Drawer s={drawer} onClose={() => setDrawer(null)} onDetails={openDetail} onBuy={buyStock} />}
      {search && <SearchOverlay onClose={() => setSearch(false)} onOpen={openStock} watchlists={watchlists} addToWatch={addToWatch} createWatchlist={createWatchlist} />}
      {showProfile && <ProfileSheet profile={profile} walletMap={walletMap} onClose={() => setShowProfile(false)} onTradeHistory={() => setHistOpen(true)} auth={auth} onLogin={() => setLoginOpen(true)} onLogout={doLogout} onPersonalise={() => setRepersonalise(true)} />}
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onAuthed={onAuthed} />}
      {histOpen && <TradeHistory userId={userId} trades={trades} onClose={() => setHistOpen(false)} />}
      {buyToast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 96, display: "flex", justifyContent: "center", zIndex: 90, pointerEvents: "none" }}>
          <div className="card glow" style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 16px", maxWidth: 380, border: "1px solid " + (buyToast.e ? "var(--down)" : "var(--up)") }}>
            {buyToast.e ? <X size={16} color="var(--down)" /> : <Check size={16} color="var(--up)" />}
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{buyToast.t}</span>
          </div>
        </div>
      )}
    </div>
  );
}
