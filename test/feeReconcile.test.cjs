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
  const fills = [{ fillId: "x2", orderId: "O9", real: true, fees: 2, feeFinal: false }];
  const note = [{ orderId: "O9", charges: 1.5 }, { orderId: "O9", charges: 2.5 }];   // two lines for the order
  const out = reconcileEodFees({ fills, contractNote: note, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].finalFees, 4);              // 1.5 + 2.5
  assert.equal(out[0].feeDelta, 2);               // 4 − 2
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
