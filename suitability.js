/**
 * suitability.js — REC-5: onboarding SUITABILITY knowledge check (pure logic).
 *
 * Before a user turns on real-money automation, they should demonstrably understand what they're switching on:
 * that the engine places REAL orders (even with the app closed), that estimated/backtested performance is not a
 * promise, that stops can slip, that leverage can lose more than deposited, and that they — not Matrix — own the
 * funds and the risk. This module holds the question bank and grades an attempt. It is PURE (no storage, no
 * network) so the pass/fail rule is unit-tested; the server persists the result and decides whether to gate the
 * Real toggle on it.
 *
 * Each question has an id, prompt, options, the index of the correct option, and a `critical` flag. The rule:
 * you must get EVERY critical question right AND clear the overall threshold — a near-miss on a safety-critical
 * concept is a fail even if the total looks high.
 */

const VERSION = "2026-08-07";
const PASS_THRESHOLD = 0.8;   // ≥80% overall AND all critical correct

const QUESTIONS = [
  { id: "real-orders", critical: true,
    prompt: "When you arm a strategy for real trading, who places the orders and with whose money?",
    options: [
      "Matrix simulates the orders; no real money moves",
      "The engine places REAL orders on your connected broker with YOUR money — even while the app is closed",
      "Your broker's staff place the orders manually after reviewing them",
      "Orders are placed only when you tap confirm each time",
    ], answer: 1 },
  { id: "past-performance", critical: true,
    prompt: "What does a strategy's backtested or displayed past performance tell you about future results?",
    options: [
      "It guarantees similar returns going forward",
      "Nothing — past/estimated performance does not guarantee future results",
      "It is a regulator-approved forecast",
      "It removes the risk of loss",
    ], answer: 1 },
  { id: "capital-loss", critical: true,
    prompt: "What is the most you could lose?",
    options: [
      "Only the profit, never the principal",
      "A fixed 10% of your account",
      "Your entire invested capital — and, with leverage/derivatives, potentially more",
      "Nothing; trades are insured",
    ], answer: 2 },
  { id: "stop-loss", critical: true,
    prompt: "Is a stop-loss guaranteed to close your position at the exact stop price?",
    options: [
      "Yes, always exactly at the stop",
      "No — in a fast or gapping market it can fill worse than the stop (slippage)",
      "Yes, the broker guarantees it",
      "Only for crypto",
    ], answer: 1 },
  { id: "responsibility", critical: false,
    prompt: "Who is responsible for your funds and for keeping your broker credentials secure?",
    options: [
      "Matrix holds and insures your funds",
      "You are — Matrix is a tool that connects to YOUR broker; it is not a broker or custodian",
      "The exchange",
      "No one; it's automated",
    ], answer: 1 },
  { id: "leverage", critical: false,
    prompt: "With leveraged products (e.g. F&O or crypto perpetuals), losses can be…",
    options: [
      "Capped at your margin, never more",
      "Larger than the amount you put in",
      "Impossible if you use a stop",
      "Refunded by the broker",
    ], answer: 1 },
];

/** Public view of the bank WITHOUT the answers (for the client to render). */
function questionsPublic() {
  return { version: VERSION, passThresholdPct: Math.round(PASS_THRESHOLD * 100),
    questions: QUESTIONS.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options, critical: !!q.critical })) };
}

/**
 * Grade an attempt. `answers` is a map { [questionId]: selectedOptionIndex }. Returns
 * { passed, score, total, correct, criticalMissed:[ids], missed:[ids], version, threshold }.
 * Fails closed: an unanswered or out-of-range answer counts as wrong; missing a critical concept fails the
 * whole attempt regardless of the overall percentage.
 */
function gradeSuitability(answers) {
  const a = answers && typeof answers === "object" ? answers : {};
  const total = QUESTIONS.length;
  let correct = 0;
  const missed = [], criticalMissed = [];
  for (const q of QUESTIONS) {
    const got = Number(a[q.id]);
    const ok = Number.isInteger(got) && got === q.answer;
    if (ok) correct += 1;
    else { missed.push(q.id); if (q.critical) criticalMissed.push(q.id); }
  }
  const score = correct / total;
  const passed = criticalMissed.length === 0 && score >= PASS_THRESHOLD;
  return { passed, score: +score.toFixed(2), total, correct, criticalMissed, missed,
    version: VERSION, threshold: PASS_THRESHOLD };
}

module.exports = { VERSION, PASS_THRESHOLD, QUESTIONS, questionsPublic, gradeSuitability };
