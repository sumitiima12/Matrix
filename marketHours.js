/**
 * marketHours.js — is a given market open right now, in IST?
 *
 * Pulled out of server.js so it can be unit-tested with an injected clock (the auto-buy engine and
 * the frontend both mirror this logic; a wrong answer here places real orders when the exchange is
 * shut — exactly the "Indian trade at 8:18pm" bug this guards against).
 *
 * Hours (IST):
 *   Crypto     — 24×7
 *   IN / FNO   — 09:15–15:30, Mon–Fri
 *   Commodity  — 09:00–23:30, Mon–Fri  (MCX evening session)
 *   US         — 19:00–01:30 IST, i.e. Mon-evening → Sat-early (regular US cash session)
 */

/* Day-of-week (0=Sun) and minutes-past-midnight in IST for a given epoch, regardless of the host
   machine's own timezone. Uses the Intl calendar rather than a fixed +5:30 so it's correct. */
function istParts(nowMs = Date.now()) {
  const ist = new Date(new Date(nowMs).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return { day: ist.getDay(), mins: ist.getHours() * 60 + ist.getMinutes() };
}

/* Wall-clock day/minutes in US EASTERN time (handles EST/EDT via Intl). US market hours must be defined
   in ET, not a fixed IST window — 9:30 ET is 19:00 IST in summer (EDT) but 20:00 IST in winter (EST), so
   a hardcoded IST window is wrong for ~4 months a year. */
function etParts(nowMs = Date.now()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(nowMs)).reduce((a, x) => (a[x.type] = x.value, a), {});
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const mins = (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10);
  return { day, mins };
}

/* ── EXCHANGE HOLIDAYS (P1-04) ────────────────────────────────────────────────────────────────
   A weekday can still be a full-day CLOSURE. US market holidays are rule-based, so we COMPUTE them
   (no annual maintenance). NSE/MCX holidays follow announced/lunar calendars, so they're a data
   table that MUST be verified against the official exchange circular each year. Deliberately
   conservative: a MISSING entry only makes the app attempt an order the broker then rejects (market
   shut), whereas a WRONG entry would skip a real session — so we list only high-confidence dates. */
const pad2 = (n) => String(n).padStart(2, "0");
const keyOf = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
function nthWeekday(y, m, weekday, n) { let c = 0; for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === weekday && ++c === n) return d; } return null; }
function lastWeekday(y, m, weekday) { for (let d = 31; d >= 1; d--) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) continue; if (dt.getUTCDay() === weekday) return d; } return null; }
function easterSunday(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * mm + 114) / 31), day = ((h + l - 7 * mm + 114) % 31) + 1; return { month, day }; }
function observedFixed(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); const dow = dt.getUTCDay(); if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1); else if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1); return keyOf(dt); }
const _usHolidayCache = {};
function usMarketHolidays(y) {
  if (_usHolidayCache[y]) return _usHolidayCache[y];
  const s = new Set();
  s.add(observedFixed(y, 1, 1));                        // New Year's Day
  s.add(ymd(y, 1, nthWeekday(y, 1, 1, 3)));             // MLK — 3rd Mon Jan
  s.add(ymd(y, 2, nthWeekday(y, 2, 1, 3)));             // Washington's Birthday — 3rd Mon Feb
  const e = easterSunday(y); const gf = new Date(Date.UTC(y, e.month - 1, e.day)); gf.setUTCDate(gf.getUTCDate() - 2); s.add(keyOf(gf)); // Good Friday
  s.add(ymd(y, 5, lastWeekday(y, 5, 1)));               // Memorial Day — last Mon May
  s.add(observedFixed(y, 6, 19));                       // Juneteenth
  s.add(observedFixed(y, 7, 4));                        // Independence Day
  s.add(ymd(y, 9, nthWeekday(y, 9, 1, 1)));             // Labor Day — 1st Mon Sep
  s.add(ymd(y, 11, nthWeekday(y, 11, 4, 4)));           // Thanksgiving — 4th Thu Nov
  s.add(observedFixed(y, 12, 25));                      // Christmas
  _usHolidayCache[y] = s; return s;
}
/* NSE/MCX full-day equity closures — VERIFY ANNUALLY against the official exchange circular. Each year
   is the high-confidence subset (fixed national holidays + computable Good Friday); lunar-calendar
   holidays (Diwali, Holi, Eid, etc.) not listed here just fall through to a broker rejection, never a
   wrong trade. When trading spills into a year with NO table below, isMarketHoliday() warns ONCE (see
   below) so the omission is loud, not silent — add that year's circular dates before it arrives. */
const IN_HOLIDAYS = {
  // R31-M06 — 2025 NSE trading holidays (official circular): Republic Day fell on a Sunday; the traded closures are
  // Mahashivratri, Holi, Id-ul-Fitr, Mahavir Jayanti, Good Friday, Maharashtra Day, Independence Day, Ganesh Chaturthi,
  // Gandhi Jayanti/Dussehra, Diwali Balipratipada, Prakash Gurpurb, and Christmas.
  2025: ["2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18", "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25"],
  // 2026 — FULL NSE equity & equity-derivatives trading-holiday calendar (official circular; cross-checked across
  // Zerodha/Upstox/NSE aggregators). 15 weekday full-day closures: Republic Day, Holi, Ram Navami, Mahavir Jayanti,
  // Good Friday, Ambedkar Jayanti, Maharashtra Day, Bakri Id, Muharram, Ganesh Chaturthi, Gandhi Jayanti, Dussehra,
  // Diwali-Balipratipada, Guru Nanak Jayanti, Christmas. (Mahashivratri 02-15 Sun, Id-ul-Fitr 03-21 Sat, Independence
  // Day 08-15 Sat and Diwali Laxmi Pujan 11-08 Sun fall on weekends — markets already closed; 11-08 has a Muhurat
  // session.) NOTE: MCX treats several of these as MORNING-closed/EVENING-open partial days; this unified table marks
  // them fully closed for Commodity too, which only ever errs toward NOT trading (the safe direction).
  2026: ["2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25"],
  // 2027 date-certain subset (Republic Day, Good Friday 2027-03-26 via Easter computus, Maharashtra/Labour
  // Day, Independence Day, Gandhi Jayanti, Christmas). Lunar dates still TBD from the 2027 NSE circular.
  2027: ["2027-01-26", "2027-03-26", "2027-05-01", "2027-08-15", "2027-10-02", "2027-12-25"],
};
const _warnedHolidayYears = new Set();
function zoneDateKey(nowMs, tz) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs)); }
function isMarketHoliday(market, nowMs = Date.now()) {
  if (market === "Crypto") return false;
  if (market === "US") { const k = zoneDateKey(nowMs, "America/New_York"); return usMarketHolidays(Number(k.slice(0, 4))).has(k); }
  const k = zoneDateKey(nowMs, "Asia/Kolkata");                    // IN / FNO / Commodity use the IST calendar date
  const yr = Number(k.slice(0, 4));
  if (!IN_HOLIDAYS[yr] && !_warnedHolidayYears.has(yr)) {          // no table for this year → warn once, not per call
    _warnedHolidayYears.add(yr);
    console.warn(`[marketHours] No Indian holiday calendar for ${yr} — update IN_HOLIDAYS from the NSE circular. Weekday exchange holidays will not be recognised until then (orders fall through to a broker rejection, never a wrong fill).`);
  }
  return (IN_HOLIDAYS[yr] || []).includes(k);
}

/* R4/R5-P2-02: is the exchange holiday calendar COMPLETE for the market's current year? Crypto (24/7) and
   US (holidays are computed, never stale) are always ready. IN/FNO/Commodity need a loaded IN_HOLIDAYS
   table for the current IST year — if it's missing we can't know weekday holidays, so unattended REAL
   entries must FAIL CLOSED rather than trade on a possibly-closed exchange day. */
/* Years whose IN_HOLIDAYS list is a VERIFIED-COMPLETE exchange calendar (full official NSE/F&O weekday closures,
   including lunar holidays). 2026 is complete (see the 2026 note above). 2027 remains a date-certain SUBSET
   (lunar dates still TBD from the 2027 circular), so it is NOT listed here. Add a year only once its list is full. */
const IN_HOLIDAYS_COMPLETE = new Set([2026]);
function holidayCalendarReady(market, nowMs = Date.now()) {
  if (market === "Crypto" || market === "US") return true;
  const yr = Number(zoneDateKey(nowMs, "Asia/Kolkata").slice(0, 4));
  // OPERATOR DECISION (2026-10): the calendar is treated as READY whenever a high-confidence subset table exists
  // for the year (IN_HOLIDAYS[yr]). This unblocks unattended IN/FNO/Commodity entries, which were previously
  // fail-closed because IN_HOLIDAYS_COMPLETE is deliberately empty. The residual risk is bounded: a lunar holiday
  // omitted from the subset (Diwali/Holi/Eid) just falls through to a BROKER REJECTION (see isMarketHoliday), never
  // a wrong fill. To restore the original strict fail-closed behavior (require a VERIFIED-COMPLETE year), set
  // STRICT_HOLIDAY_CALENDAR=1. ALLOW_INCOMPLETE_HOLIDAY_CALENDAR is still honored for back-compat.
  if (/^(1|true|yes)$/i.test(String(process.env.STRICT_HOLIDAY_CALENDAR || ""))) return IN_HOLIDAYS_COMPLETE.has(yr);
  return !!IN_HOLIDAYS[yr] || IN_HOLIDAYS_COMPLETE.has(yr);
}

function marketOpenIST(market, nowMs = Date.now()) {
  if (market === "Crypto") return true;
  if (isMarketHoliday(market, nowMs)) return false;                // exchange holiday — shut even on a weekday
  if (market === "US") { const { day, mins } = etParts(nowMs); return day >= 1 && day <= 5 && mins >= 570 && mins <= 960; }  // 09:30–16:00 ET (DST-correct)
  const { day, mins } = istParts(nowMs);
  const weekday = day >= 1 && day <= 5;
  if (market === "IN" || market === "FNO") return weekday && mins >= 555 && mins <= 930;      // 09:15–15:30
  if (market === "Commodity") return weekday && mins >= 540 && mins <= 1410;                  // 09:00–23:30
  return true;
}

/* Minutes until the market's regular close, in IST. Returns null for Crypto (no close) and a
   negative number once the session is over. US wraps past midnight (closes 01:30 IST), handled
   for both the evening (mins ≥ 19:00) and the early-morning tail (mins ≤ 01:30). */
function minsToCloseIST(market, nowMs = Date.now()) {
  if (market === "Crypto") return null;
  const { mins } = istParts(nowMs);
  if (market === "IN" || market === "FNO") return 930 - mins;        // close 15:30
  if (market === "Commodity") return 1410 - mins;                    // close 23:30
  if (market === "US") return 960 - etParts(nowMs).mins;             // minutes to 16:00 ET (DST-correct)
  return null;
}

/* Should an INTRADAY (MIS) position be squared off now? True within `bufferMin` minutes of the
   close, OR any time the market is already shut (an intraday position must never carry overnight).
   Crypto never squares. This mirrors what the broker does to MIS positions, so the app's own
   tracking doesn't leave an intraday trade sitting "open" past the session. */
function intradaySquareDue(market, nowMs = Date.now(), bufferMin = 15) {
  if (market === "Crypto") return false;
  if (!marketOpenIST(market, nowMs)) return true;                    // closed but still tracked open
  const m = minsToCloseIST(market, nowMs);
  return m != null && m <= bufferMin;
}

module.exports = { istParts, marketOpenIST, minsToCloseIST, intradaySquareDue, isMarketHoliday, holidayCalendarReady, usMarketHolidays };
