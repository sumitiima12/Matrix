"use strict";
/* alertSeverity.js — PURE classifier that maps a notice/event kind to a severity level so notifications can
   be triaged instead of all looking the same (ALERT-1). Three levels:
     "urgent" — money at risk right now; the user should act (rejected order, unprotected position, daily-loss
                limit hit, reconciliation required, failed exit).
     "action" — needs attention soon but not bleeding (broker disconnected, partial fill, order stuck unknown,
                strategy paused).
     "info"   — confirmation / FYI (order filled, entry/exit completed, automation on/off).
   Kept pure + tested so the triage rules can't silently drift, and callers can pass an explicit severity to
   override (a specific event that knows better than the keyword heuristic). */

const LEVELS = ["info", "action", "urgent"];

/* Ordered rules — first match wins. Each rule is [regex, level]. Applied to a lowercased kind/type string. */
const RULES = [
  [/reject|failed|declin/, "urgent"],
  [/unprotected|no[_-]?stop|no[_-]?sl|missing[_-]?protection/, "urgent"],
  [/daily[_-]?loss|loss[_-]?limit|risk[_-]?lock|halt/, "urgent"],
  [/reconcil|manual[_-]?review|mismatch|drift|orphan/, "urgent"],
  [/exit[_-]?fail|close[_-]?fail|square[_-]?off[_-]?fail/, "urgent"],
  [/disconnect|token[_-]?expir|broker[_-]?down|auth[_-]?fail/, "action"],
  [/partial/, "action"],
  [/unknown|pending|stuck|delayed/, "action"],
  [/paused|deactivat|stopped/, "action"],
  [/fill|filled|complete|executed|entry|exit|activ|target|profit/, "info"],
];

/* Return "urgent" | "action" | "info". An explicit, valid `override` always wins. */
function alertSeverity(kind, override) {
  if (override && LEVELS.includes(String(override))) return String(override);
  const k = String(kind || "").toLowerCase();
  for (const [re, level] of RULES) if (re.test(k)) return level;
  return "info";
}

/* Coarse notification CATEGORY (for the user's per-category push prefs): trades | broker | alerts. */
function alertCategory(kind, override) {
  if (override && ["trades", "broker", "alerts", "other"].includes(String(override))) return String(override);
  const k = String(kind || "").toLowerCase();
  if (/fill|order|trade|exit|entry|protect|position|square/.test(k)) return "trades";
  if (/broker|connect|token|auth|disconnect/.test(k)) return "broker";
  return "alerts";
}

module.exports = { LEVELS, alertSeverity, alertCategory };
