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

  it("rejects a malformed decimal instead of throwing", () => {
    const result = authorizeTradeProposal(
      { ...proposal, quantity: "0.01abc" },
      policy,
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "invalid_proposal");
  });

  it("rejects a spot short", () => {
    const result = authorizeTradeProposal(
      {
        ...proposal,
        direction: "short",
        stopLossPrice: "63000",
        takeProfitPrice: "54000",
      },
      policy,
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "unsupported_spot_short");
  });

  it("rejects an entry that has already expired", () => {
    const result = authorizeTradeProposal(
      { ...proposal, entryExpiresAt: now.toISOString() },
      policy,
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "entry_expired");
  });
});

describe("authorizeTradeProposal with several protected entries", () => {
  it("lets a strategy add an entry to a position it already holds", () => {
    const result = authorizeTradeProposal(
      proposal,
      {
        ...policy,
        positionNotionalByInstrument: { "BTC-USDT": "150" },
        protectedEntries: 2,
        maxProtectedEntries: 3,
      },
      now,
    );

    assert.equal(result.allowed, true);
    if (result.allowed) {
      assert.equal(result.positionNotional, "600");
      assert.equal(result.reservationAmount, "600");
    }
  });

  it("counts the entries already held in the instrument against the position limit", () => {
    const atLimit = authorizeTradeProposal(
      proposal,
      { ...policy, positionNotionalByInstrument: { "BTC-USDT": "150" } },
      now,
    );
    const past = authorizeTradeProposal(
      proposal,
      { ...policy, positionNotionalByInstrument: { "BTC-USDT": "150.01" } },
      now,
    );

    assert.equal(atLimit.allowed, true);
    assert.equal(past.allowed, false);
    if (!past.allowed) assert.equal(past.code, "position_limit_exceeded");
  });

  it("keeps each instrument's position separate", () => {
    const result = authorizeTradeProposal(
      proposal,
      { ...policy, positionNotionalByInstrument: { "ETH-USDT": "750" } },
      now,
    );

    assert.equal(result.allowed, true);
  });

  it("rejects an entry once the strategy holds its most protected entries", () => {
    const result = authorizeTradeProposal(
      proposal,
      {
        ...policy,
        positionNotionalByInstrument: {},
        protectedEntries: 3,
        maxProtectedEntries: 3,
      },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "entry_limit_exceeded");
  });

  it("caps capital across every open and pending entry at the allocation", () => {
    // 100 committed and 200 reserved leave exactly 700 of 1000.
    const fits = authorizeTradeProposal(
      {
        ...proposal,
        quantity: "0.01",
        entryPrice: "70000",
        takeProfitPrice: "77000",
      },
      { ...policy, maxPositionNotional: "1000" },
      now,
    );
    const over = authorizeTradeProposal(
      {
        ...proposal,
        quantity: "0.01",
        entryPrice: "70000.01",
        takeProfitPrice: "77000",
      },
      { ...policy, maxPositionNotional: "1000" },
      now,
    );

    assert.equal(fits.allowed, true);
    assert.equal(over.allowed, false);
    if (!over.allowed) assert.equal(over.code, "allocation_exceeded");
  });

  it("still rejects a paused strategy's entries", () => {
    const result = authorizeTradeProposal(
      proposal,
      {
        ...policy,
        strategyStatus: "paused",
        positionNotionalByInstrument: {},
        protectedEntries: 0,
        maxProtectedEntries: 5,
      },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "strategy_not_active");
  });

  it("requires an entry limit to come with the entries already held", () => {
    assert.throws(() =>
      authorizeTradeProposal(
        proposal,
        { ...policy, maxProtectedEntries: 3 },
        now,
      ),
    );
    assert.throws(() =>
      authorizeTradeProposal(
        proposal,
        { ...policy, protectedEntries: 0, maxProtectedEntries: 3 },
        now,
      ),
    );
  });

  it("rejects a market kind the strategy does not trade", () => {
    const result = authorizeTradeProposal(
      {
        ...proposal,
        marketKind: "perpetual",
        direction: "short",
        stopLossPrice: "63000",
        takeProfitPrice: "54000",
      },
      { ...policy, marketKind: "spot", allowedDirections: ["long"] },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "market_kind_not_allowed");
  });

  it("rejects a short on a strategy that only opens longs", () => {
    const result = authorizeTradeProposal(
      {
        ...proposal,
        marketKind: "perpetual",
        direction: "short",
        stopLossPrice: "63000",
        takeProfitPrice: "54000",
      },
      { ...policy, marketKind: "perpetual", allowedDirections: ["long"] },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "direction_not_allowed");
  });
});
