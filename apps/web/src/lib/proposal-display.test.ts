import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EntryReconciliation,
  ProposalView,
} from "@crypto-trading/exchanges/ai-decisions";

import { proposalFigures, proposalOutcome } from "./proposal-display";

const proposal: ProposalView = {
  id: "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a01",
  instrument: "BTC-USDT",
  marketKind: "spot",
  direction: "long",
  quantity: "0.005",
  entryPrice: "83500",
  stopLossPrice: "81830",
  takeProfitPrice: "86840",
  leverage: 1,
  entryExpiresAt: "2026-10-08T15:00:00.000Z",
  strategyId: null,
  strategyVersion: null,
  status: "draft",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  order: null,
};

const leg = (status: string, filledQuantity = "0") => ({
  orderId: "20",
  status,
  filledQuantity,
  averageFillPrice: filledQuantity === "0" ? null : "83490.5",
});

test("a proposal shows its size, each exit's distance from the entry and its risk to reward", () => {
  assert.deepEqual(proposalFigures(proposal), {
    notional: "417.50",
    stopLossPercent: "-2.00%",
    takeProfitPercent: "+4.00%",
    riskReward: "1 : 2",
  });
  assert.equal(
    proposalFigures({ ...proposal, takeProfitPrice: "86733.33" })?.riskReward,
    "1 : 1.94",
  );
  // Exact decimals: no floating-point drift in the size.
  assert.equal(
    proposalFigures({ ...proposal, quantity: "0.1", entryPrice: "0.3" })
      ?.notional,
    "0.03",
  );
  // A draft still streaming in has no figures yet.
  assert.equal(proposalFigures({ ...proposal, entryPrice: "" }), null);
});

test("each status explains what happened to the proposal", () => {
  assert.match(proposalOutcome(proposal), /until 2026-10-08 15:00:00 UTC/);
  assert.match(
    proposalOutcome({ ...proposal, status: "expired" }),
    /Nothing was sent/,
  );
  assert.equal(
    proposalOutcome({
      ...proposal,
      status: "rejected",
      decidedBy: "customer",
      decisionReason: "Too close to resistance.",
    }),
    "You rejected it: “Too close to resistance.”",
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "rejected",
      decidedBy: "execution_checks",
      decisionReason: "Per-order cap: 417.5 USDT is over the 100 USDT cap.",
    }),
    /execution checks rejected it.*Per-order cap/,
  );
  const order = {
    listClientOrderId: "ct_aiCx5WFFI-TB2Kexwh0-P1oQ",
    intentStatus: "acknowledged",
    entry: leg("NEW"),
    takeProfit: null,
    stopLoss: null,
    reconciliation: null,
    checkedAt: null,
  };
  const watched = (
    state: EntryReconciliation["state"],
    filledQuantity: string,
    closeBlocked = false,
  ) => ({
    ...order,
    reconciliation: {
      state,
      filledQuantity,
      heldQuantity: filledQuantity,
      exitReason: null,
      closeBlocked,
      detail: "From the loop.",
      checkedAt: "2026-10-08T14:00:00.000Z",
    },
  });
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "rejected",
      decidedBy: "customer",
      order: { ...order, intentStatus: "rejected" },
    }),
    /Binance refused the order, or never received it/,
  );
  assert.match(
    proposalOutcome({ ...proposal, status: "submitted", order }),
    /waiting to fill/,
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "submitted",
      order: { ...order, entry: leg("PARTIALLY_FILLED", "0.002") },
    }),
    /bought 0.002 BTC so far/,
  );
  assert.equal(
    proposalOutcome({
      ...proposal,
      status: "filled",
      order: {
        ...order,
        entry: leg("FILLED", "0.005"),
        takeProfit: leg("NEW"),
        stopLoss: leg("NEW"),
      },
    }),
    "Bought 0.005 BTC at 83,490.50. Its take profit and stop loss are on Binance.",
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "filled",
      order: {
        ...order,
        entry: leg("FILLED", "0.005"),
        takeProfit: leg("EXPIRED"),
        stopLoss: leg("FILLED", "0.005"),
      },
    }),
    /stop loss closed the position/,
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "cancelled",
      order: { ...order, entry: leg("CANCELED", "0.001") },
    }),
    /after buying 0.001 BTC/,
  );
  assert.match(
    proposalOutcome({ ...proposal, status: "approved" }),
    /never sent twice/,
  );
  // Once the execution loop has checked the entry, its finding decides.
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "filled",
      order: watched("unprotected", "0.005"),
    }),
    /^Bought 0.005 BTC. The execution worker is selling what it holds.$/,
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "filled",
      order: watched("exiting", "0.005", true),
    }),
    /stopped trying. Sell it yourself./,
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "filled",
      order: watched("closed", "0.005"),
    }),
    /The position is closed./,
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "cancelled",
      order: watched("handed_over", "0.002"),
    }),
    /after it bought 0.002 BTC, which has no exits and is yours to manage/,
  );
  assert.match(
    proposalOutcome({
      ...proposal,
      status: "cancelled",
      order: watched("missing", "0"),
    }),
    /testnet reset/,
  );
});
