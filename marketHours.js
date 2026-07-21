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

function marketOpenIST(market, nowMs = Date.now()) {
  if (market === "Crypto") return true;
  const { day, mins } = istParts(nowMs);
  const weekday = day >= 1 && day <= 5;
  if (market === "IN" || market === "FNO") return weekday && mins >= 555 && mins <= 930;      // 09:15–15:30
  if (market === "Commodity") return weekday && mins >= 540 && mins <= 1410;                  // 09:00–23:30
  if (market === "US") return (mins >= 1140 && day >= 1 && day <= 5) || (mins <= 90 && day >= 2 && day <= 6); // 19:00–01:30 IST
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
  if (market === "US") {                                             // close 01:30 IST
    if (mins >= 1140) return (1440 - mins) + 90;                     // evening -> next-day 01:30
    return 90 - mins;                                                // early morning tail
  }
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

module.exports = { istParts, marketOpenIST, minsToCloseIST, intradaySquareDue };
