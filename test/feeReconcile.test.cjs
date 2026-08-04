/* R31-P2-08 — EOD contract-note fee reconciliation. Pins the pure matcher: exact execId match, per-order fallback,
   skips already-final and unmatched, computes the fee delta, ignores non-real fills, and summarizes a batch. */
const test = require("node:test");
const assert = require("node:assert");
const { reconcileEodFees, summarizeFinalizations, runEodFeeReconcile } = require("../feeReconcile.js");

const NOW = 1_700_000_000_000;

test("R31-P2-08: finalizes a fill by EXACT execId and computes the fee delta", () => {
  const fills = [{ fillId: "x1", execId: "E1", orderId: "O1", broker: "fyers", real: true, fees: 3.0, feeFinal: false }];
  const note = [{ execId: "E1", charges: 4.25 }];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].fillId, "x1");
  assert.equal(out[0].finalFees, 4.25);
  assert.equal(out[0].provisionalFees, 3.0);
  assert.equal(out[0].feeDelta, 1.25);
  assert.equal(out[0].feeFinal, true);
  assert.equal(out[0].feeStatus, "contract-note");
});

test("R31-P2-08: falls back to the PER-ORDER total (summed lines) when there's no execId match", () => {
  const fills = [{ fillId: "x2", orderId: "O9", qty: 1, real: true, fees: 2, feeFinal: false }];
  const note = [{ orderId: "O9", charges: 1.5 }, { orderId: "O9", charges: 2.5 }];   // two order-level lines
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].finalFees, 4);              // 1.5 + 2.5, one fill gets the whole order total
  assert.equal(out[0].feeDelta, 2);               // 4 − 2
});

test("R32-P2-01: an order-level charge is ALLOCATED across the order's executions, never multiplied", () => {
  // ₹30 order charge across THREE equal-qty execution fills ⇒ ₹10 each, summing EXACTLY to ₹30 (not ₹90).
  const fills = [
    { fillId: "e1", orderId: "O1", qty: 1, real: true, fees: 0, feeFinal: false },
    { fillId: "e2", orderId: "O1", qty: 1, real: true, fees: 0, feeFinal: false },
    { fillId: "e3", orderId: "O1", qty: 1, real: true, fees: 0, feeFinal: false },
  ];
  const note = [{ orderId: "O1", charges: 30 }];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 3);
  const total = out.reduce((a, x) => a + x.finalFees, 0);
  assert.equal(+total.toFixed(2), 30, "allocated fees sum EXACTLY to the order total (no multiply)");
  out.forEach((x) => assert.equal(x.finalFees, 10));
});

test("R32-P2-01: order-level allocation is QUANTITY-weighted with the remainder on the last fill", () => {
  // ₹10 order over qty 1 and qty 2 ⇒ ~3.33 + 6.67 (last absorbs rounding) summing to exactly 10.
  const fills = [
    { fillId: "a", orderId: "OQ", qty: 1, real: true, fees: 0, feeFinal: false },
    { fillId: "b", orderId: "OQ", qty: 2, real: true, fees: 0, feeFinal: false },
  ];
  const out = reconcileEodFees({ fills, contractNote: [{ orderId: "OQ", charges: 10 }], now: NOW });
  const total = out.reduce((a, x) => a + x.finalFees, 0);
  assert.equal(+total.toFixed(2), 10, "weighted allocation still sums exactly to the order total");
  assert.ok(out.find((x) => x.fillId === "b").finalFees > out.find((x) => x.fillId === "a").finalFees, "the larger-qty fill bears more fee");
});

test("R32-P2-02: each finalization carries the leg it corrects (entry vs exit)", () => {
  const fills = [
    { fillId: "en", execId: "E1", orderId: "O1", real: true, fees: 1, feeFinal: false },                 // entry (no kind)
    { fillId: "ex", execId: "E2", orderId: "O2", kind: "exit", real: true, fees: 1, feeFinal: false },   // exit leg
  ];
  const note = [{ execId: "E1", charges: 2 }, { execId: "E2", charges: 3 }];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.find((x) => x.fillId === "en").leg, "entry");
  assert.equal(out.find((x) => x.fillId === "ex").leg, "exit");
});

test("R31-P2-08: prefers execId over orderId when both are present", () => {
  const fills = [{ fillId: "x3", execId: "E3", orderId: "O3", real: true, fees: 1, feeFinal: false }];
  const note = [{ execId: "E3", charges: 5 }, { orderId: "O3", charges: 99 }];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out[0].finalFees, 5, "the exact execution charge wins over the order-level line");
});

test("R31-P2-08: skips already-final fills and fills with no contract-note match", () => {
  const fills = [
    { fillId: "done", execId: "E1", real: true, fees: 3, feeFinal: true },     // already reconciled
    { fillId: "nomatch", execId: "E404", real: true, fees: 3, feeFinal: false }, // no EOD line yet
  ];
  const note = [{ execId: "E1", charges: 4 }];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 0, "nothing to finalize — one is final, the other has no line");
});

test("R31-P2-08: ignores non-real (virtual) fills — they bear no brokerage", () => {
  const fills = [{ fillId: "v1", execId: "E1", real: false, fees: 0, feeFinal: false }];
  const note = [{ execId: "E1", charges: 4 }];
  assert.equal(reconcileEodFees({ fills, contractNote: note, now: NOW }).length, 0);
});

test("R31-P2-08: a zero-charge EOD line still finalizes (a genuinely free execution) with a negative delta", () => {
  const fills = [{ fillId: "z1", execId: "E0", real: true, fees: 1.2, feeFinal: false }];
  const note = [{ execId: "E0", charges: 0 }];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].finalFees, 0);
  assert.equal(out[0].feeDelta, -1.2);            // over-estimated intraday → corrected down
  assert.equal(out[0].feeFinal, true);
});

test("R31-P2-08: summarizeFinalizations reports count, net correction, and still-provisional gap (alertable)", () => {
  const finals = [{ feeDelta: 1.25 }, { feeDelta: -0.25 }];
  const s = summarizeFinalizations(finals, 5);
  assert.equal(s.finalized, 2);
  assert.equal(s.netFeeCorrection, 1);            // 1.25 − 0.25
  assert.equal(s.stillProvisional, 3, "5 provisional fills, 2 finalized ⇒ 3 still awaiting the contract note");
});

test("R33-P2-02: charges are BROKER-SCOPED — an identical orderId across two brokers never cross-allocates", () => {
  // FYERS order "123" and Delta order "123" both exist for the same user. Each broker's charge must land ONLY on
  // that broker's fill; without broker scoping, one broker's fee could be applied to the other broker's fill.
  const fills = [
    { fillId: "fy", execId: "E1", orderId: "123", broker: "fyers", real: true, fees: 1, feeFinal: false },
    { fillId: "dl", execId: "E2", orderId: "123", broker: "delta", real: true, fees: 1, feeFinal: false },
  ];
  const note = [
    { execId: "E1", orderId: "123", charges: 5, broker: "fyers" },
    { execId: "E2", orderId: "123", charges: 9, broker: "delta" },
  ];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.find((x) => x.fillId === "fy").finalFees, 5, "FYERS fill gets ONLY the FYERS charge");
  assert.equal(out.find((x) => x.fillId === "dl").finalFees, 9, "Delta fill gets ONLY the Delta charge");
});

test("R33-P2-02: order-level charges are broker-scoped too (no cross-broker order-total bleed)", () => {
  const fills = [
    { fillId: "fy", orderId: "999", qty: 1, broker: "fyers", real: true, fees: 0, feeFinal: false },
    { fillId: "dl", orderId: "999", qty: 1, broker: "delta", real: true, fees: 0, feeFinal: false },
  ];
  const note = [
    { orderId: "999", charges: 12, broker: "fyers" },
    { orderId: "999", charges: 30, broker: "delta" },
  ];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.find((x) => x.fillId === "fy").finalFees, 12);
  assert.equal(out.find((x) => x.fillId === "dl").finalFees, 30);
});

test("R33-P2-02: an UNTAGGED (wildcard) contract-note line still matches (backward compat)", () => {
  const fills = [{ fillId: "x", execId: "E1", broker: "fyers", real: true, fees: 1, feeFinal: false }];
  const out = reconcileEodFees({ fills, contractNote: [{ execId: "E1", charges: 4 }], now: NOW });   // no broker on the line
  assert.equal(out.length, 1);
  assert.equal(out[0].finalFees, 4);
});

test("R33-P2-01: the job counts a NEW insert as finalized, an identical replay as alreadyFinal, a changed row as a conflict", async () => {
  // recordFeeFinal simulates the immutable-ledger adapter: first write inserts, a re-run of the same content is an
  // idempotent replay (inserted:false, no conflict), and a DIFFERENT amount on the same key is a flagged conflict.
  const calls = [];
  const summary = await runEodFeeReconcile({
    userKeys: ["u1"],
    now: NOW,
    listProvisionalFills: async () => [
      { fillId: "a", execId: "EA", broker: "fyers", real: true, fees: 1, feeFinal: false },
      { fillId: "b", execId: "EB", broker: "fyers", real: true, fees: 1, feeFinal: false },
      { fillId: "c", execId: "EC", broker: "fyers", real: true, fees: 1, feeFinal: false },
    ],
    fetchContractNote: async () => [
      { execId: "EA", charges: 2 },   // a → NEW insert
      { execId: "EB", charges: 3 },   // b → replay (already final, identical)
      { execId: "EC", charges: 4 },   // c → conflict (existing row has a different delta)
    ],
    recordFeeFinal: async (uk, fin) => {
      calls.push(fin.fillId);
      if (fin.fillId === "a") return { inserted: true };
      if (fin.fillId === "b") return { inserted: false, conflict: false };
      return { inserted: false, conflict: true };
    },
  });
  assert.equal(summary.finalized, 1, "only the genuinely new write counts as finalized");
  assert.equal(summary.alreadyFinal, 1, "an identical replay is idempotent success, not a re-finalization");
  assert.equal(summary.conflicts, 1, "a changed correction on an existing key is flagged, not silently lost");
  assert.equal(summary.netFeeCorrection, 1, "net correction moves ONLY by the inserted delta (2 − 1)");
});

test("R36-P2-01: malformed charge TYPES (boolean/array/object/whitespace) are rejected — never coerced to a fee", () => {
  // The R35 code used Number(raw), so `true`→1, `false`/`[]`/whitespace→0 could all finalize a fabricated fee. Strict
  // typing must reject them all: only finite numbers or strict decimal strings are accepted.
  const fills = [
    { fillId: "t", execId: "ET", broker: "fyers", real: true, fees: 9, feeFinal: false },
    { fillId: "f", execId: "EF", broker: "fyers", real: true, fees: 9, feeFinal: false },
    { fillId: "a", execId: "EA", broker: "fyers", real: true, fees: 9, feeFinal: false },
    { fillId: "w", execId: "EW", broker: "fyers", real: true, fees: 9, feeFinal: false },
    { fillId: "o", execId: "EO", broker: "fyers", real: true, fees: 9, feeFinal: false },
    { fillId: "s", execId: "ES", broker: "fyers", real: true, fees: 9, feeFinal: false },
  ];
  const note = [
    { execId: "ET", broker: "fyers", charges: true },     // boolean true → REJECTED (would have become 1)
    { execId: "EF", broker: "fyers", charges: false },    // boolean false → REJECTED (would have become 0)
    { execId: "EA", broker: "fyers", charges: [] },       // array → REJECTED
    { execId: "EW", broker: "fyers", charges: "  " },     // whitespace → REJECTED
    { execId: "EO", broker: "fyers", charges: {} },       // object → REJECTED
    { execId: "ES", broker: "fyers", charges: "12.50" },  // strict decimal STRING → ACCEPTED
  ];
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 1, "only the strict decimal string finalizes; every malformed type is dropped");
  assert.equal(out[0].fillId, "s");
  assert.equal(out[0].finalFees, 12.5);
});

test("R36-P3-01: stillProvisional reflects DURABLE inserts — a persistence failure keeps the fill provisional", async () => {
  // recordFeeFinal throws for one fill (DB failure) and reports a conflict for another. Neither is durably resolved, so
  // both must remain counted in stillProvisional — the monitor can't report a false-empty backlog.
  const summary = await runEodFeeReconcile({
    userKeys: ["u1"],
    now: NOW,
    listReconcilableFills: async () => [
      { fillId: "ok", execId: "E1", broker: "fyers", real: true, fees: 1, feeFinalized: false },
      { fillId: "boom", execId: "E2", broker: "fyers", real: true, fees: 1, feeFinalized: false },
      { fillId: "conf", execId: "E3", broker: "fyers", real: true, fees: 1, feeFinalized: false },
    ],
    fetchContractNote: async () => [{ execId: "E1", charges: 2 }, { execId: "E2", charges: 3 }, { execId: "E3", charges: 4 }],
    recordFeeFinal: async (uk, fin) => {
      if (fin.fillId === "boom") throw new Error("db write failed");
      if (fin.fillId === "conf") return { inserted: false, conflict: true };
      return { inserted: true };
    },
  });
  assert.equal(summary.finalized, 1, "only the durably-inserted fill counts as finalized");
  assert.equal(summary.errors, 1, "the failed write is an error");
  assert.equal(summary.conflicts, 1, "the collision is a conflict");
  assert.equal(summary.stillProvisional, 2, "the failed + conflicted fills remain provisional (not falsely zero)");
});

// R38-P2-01 — helpers: two distinct IST trading days derived from the pinned NOW.
const DAY_A_MS = NOW;                       // "today"
const DAY_B_MS = NOW - 86400000;            // "yesterday"
const IST = 19800000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const DAY_A = istDay(DAY_A_MS), DAY_B = istDay(DAY_B_MS);

test("R38-P2-01: reconciliation fetches ONE statement per (broker, trading-day) and finalizes each day", async () => {
  const fetchDays = [];
  const persisted = [];
  const summary = await runEodFeeReconcile({
    userKeys: ["u1"],
    now: NOW,
    listReconcilableFills: async () => [
      { fillId: "y", execId: "E1", broker: "fyers", real: true, fees: 1, feeFinalized: false, ts: DAY_B_MS }, // yesterday
      { fillId: "t", execId: "E2", broker: "fyers", real: true, fees: 1, feeFinalized: false, ts: DAY_A_MS }, // today
    ],
    fetchContractNote: async (uk, broker, tradingDate) => {
      fetchDays.push(tradingDate);
      if (tradingDate === DAY_B) return [{ execId: "E1", charges: 5 }];
      if (tradingDate === DAY_A) return [{ execId: "E2", charges: 7 }];
      return [];
    },
    recordFeeFinal: async (uk, fin) => { persisted.push({ fillId: fin.fillId, tradingDate: fin.tradingDate, finalFees: fin.finalFees }); return { inserted: true }; },
  });
  assert.equal(summary.finalized, 2, "both days' fills finalize");
  assert.deepEqual(fetchDays.sort(), [DAY_B, DAY_A].sort(), "one statement fetched per distinct trading day");
  // Each finalization carries its own verified trading day (audit identity).
  assert.deepEqual(persisted.find((p) => p.fillId === "y").tradingDate, DAY_B);
  assert.deepEqual(persisted.find((p) => p.fillId === "t").tradingDate, DAY_A);
});

test("R38-P2-01: same order/exec IDs on DIFFERENT days never cross-match (per-day candidate set)", async () => {
  // Both days have an execution with id "E1", but the statements differ by day. Day A's E1 must get Day A's charge and
  // Day B's E1 must get Day B's charge — a single-window match would have mixed them.
  const persisted = [];
  await runEodFeeReconcile({
    userKeys: ["u1"],
    now: NOW,
    listReconcilableFills: async () => [
      { fillId: "fb", execId: "E1", broker: "fyers", real: true, fees: 0, feeFinalized: false, ts: DAY_B_MS },
      { fillId: "fa", execId: "E1", broker: "fyers", real: true, fees: 0, feeFinalized: false, ts: DAY_A_MS },
    ],
    fetchContractNote: async (uk, broker, tradingDate) => tradingDate === DAY_B ? [{ execId: "E1", charges: 2 }] : [{ execId: "E1", charges: 9 }],
    recordFeeFinal: async (uk, fin) => { persisted.push({ fillId: fin.fillId, finalFees: fin.finalFees }); return { inserted: true }; },
  });
  assert.equal(persisted.find((p) => p.fillId === "fb").finalFees, 2, "yesterday's E1 got yesterday's charge");
  assert.equal(persisted.find((p) => p.fillId === "fa").finalFees, 9, "today's E1 got today's charge");
});

test("R38-P2-01: a DELAYED prior-day statement finalizes on a later run (older fills not stranded)", async () => {
  const fills = [{ fillId: "old", execId: "EO", broker: "fyers", real: true, fees: 1, feeFinalized: false, ts: DAY_B_MS }];
  // First run: yesterday's statement isn't ready yet → stays provisional.
  const s1 = await runEodFeeReconcile({
    userKeys: ["u1"], now: NOW,
    listReconcilableFills: async () => fills,
    fetchContractNote: async () => [],                       // no statement yet
    recordFeeFinal: async () => { throw new Error("should not persist"); },
  });
  assert.equal(s1.finalized, 0);
  assert.equal(s1.stillProvisional, 1, "unmatched prior-day fill remains provisional");
  // Later run: yesterday's statement has arrived for DAY_B → it finalizes.
  const persisted = [];
  const s2 = await runEodFeeReconcile({
    userKeys: ["u1"], now: NOW,
    listReconcilableFills: async () => fills,
    fetchContractNote: async (uk, broker, tradingDate) => tradingDate === DAY_B ? [{ execId: "EO", charges: 4 }] : [],
    recordFeeFinal: async (uk, fin) => { persisted.push(fin.fillId); return { inserted: true }; },
  });
  assert.equal(s2.finalized, 1, "the delayed prior-day statement finalizes the older fill");
  assert.deepEqual(persisted, ["old"]);
});

test("R31-P2-08: runEodFeeReconcile orchestrates per-user, persists finalizations, and is fail-soft", async () => {
  const persisted = [];
  const summary = await runEodFeeReconcile({
    userKeys: ["ph_1", "ph_2", "ph_3"],
    now: NOW,
    listProvisionalFills: async (uk) => {
      if (uk === "ph_1") return [{ fillId: "a", execId: "E1", broker: "fyers", real: true, fees: 3, feeFinal: false }];
      if (uk === "ph_2") throw new Error("db read blip");                     // fail-soft: skip this user
      return [{ fillId: "b", orderId: "O2", broker: "delta", real: true, fees: 1, feeFinal: false }];   // ph_3
    },
    fetchContractNote: async (uk, broker) => {
      if (uk === "ph_1" && broker === "fyers") return [{ execId: "E1", charges: 4 }];
      if (uk === "ph_3" && broker === "delta") return [{ orderId: "O2", charges: 1.5 }];
      return [];
    },
    recordFeeFinal: async (uk, fin) => { persisted.push({ uk, fillId: fin.fillId, finalFees: fin.finalFees }); },
  });
  assert.equal(summary.finalized, 2, "both matchable users' fills finalized");
  assert.equal(summary.errors, 1, "the failing db read counted as one soft error, not a crash");
  assert.equal(summary.usersTouched, 2, "ph_2 skipped (read failed), ph_1 + ph_3 processed");
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted.map((p) => p.fillId).sort(), ["a", "b"]);
});
