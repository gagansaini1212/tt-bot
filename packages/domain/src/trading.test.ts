import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeTradeProposal,
  type ExecutionPolicy,
  type TradeProposal,
} from "./trading";

const now = new Date("2026-09-29T10:00:00.000Z");

const proposal: TradeProposal = {
  proposalId: "10000000-0000-4000-8000-000000000001",
  customerId: "10000000-0000-4000-8000-000000000002",
  exchangeAccountId: "10000000-0000-4000-8000-000000000003",
  strategyId: "10000000-0000-4000-8000-000000000004",
  strategyVersion: 3,
  instrument: "BTC-USDT",
  marketKind: "spot",
  direction: "long",
  quantity: "0.01",
  entryPrice: "60000",
  stopLossPrice: "57000",
  takeProfitPrice: "66000",
  leverage: 1,
  entryExpiresAt: "2026-09-29T11:00:00.000Z",
  rationale: "Fixture-backed momentum signal.",
  sourceSnapshotId: "10000000-0000-4000-8000-000000000005",
};

const policy: ExecutionPolicy = {
  customerId: proposal.customerId,
  exchangeAccountId: proposal.exchangeAccountId,
  strategyId: proposal.strategyId,
  strategyVersion: 3,
  tradingMode: "simulation",
  strategyStatus: "simulation",
  liveTradingEnabled: false,
  allowedInstruments: ["BTC-USDT", "ETH-USDT"],
  allocation: "1000",
  committedCapital: "100",
  reservedBudget: "200",
  maxPositionNotional: "750",
  maxLeverage: 2,
};

describe("authorizeTradeProposal", () => {
  it("approves a bounded proposal and calculates an exact reservation", () => {
    const result = authorizeTradeProposal(proposal, policy, now);

    assert.deepEqual(result, {
      allowed: true,
      proposal,
      reservationAmount: "600",
      positionNotional: "600",
    });
  });

  it("rejects a proposal that would spend reserved capital", () => {
    const result = authorizeTradeProposal(
      { ...proposal, quantity: "0.02" },
      { ...policy, maxPositionNotional: "1500" },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "allocation_exceeded");
  });

  it("rejects a stop loss on the wrong side of a long entry", () => {
    const result = authorizeTradeProposal(
      { ...proposal, stopLossPrice: "61000" },
      policy,
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "invalid_protection");
  });

  it("keeps live execution disabled even for an otherwise valid proposal", () => {
    const result = authorizeTradeProposal(
      proposal,
      {
        ...policy,
        tradingMode: "live",
        strategyStatus: "active",
      },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "live_trading_disabled");
  });
});
