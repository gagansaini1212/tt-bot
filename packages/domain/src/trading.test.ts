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
  accountAccess: "trade",
  accountingCurrency: "USDT",
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

  it("rejects a market outside the allowed instruments, though it is a valid name", () => {
    for (const instrument of ["SOL-USDT", "ETH-BTC", "BTC-USD"]) {
      const result = authorizeTradeProposal(
        { ...proposal, instrument },
        policy,
        now,
      );
      assert.equal(result.allowed, false, instrument);
      assert.equal(
        !result.allowed && result.code,
        "instrument_not_allowed",
        instrument,
      );
    }
    // A name that is not BASE-QUOTE is not a proposal at all.
    const malformed = authorizeTradeProposal(
      { ...proposal, instrument: "BTCUSDT" },
      policy,
      now,
    );
    assert.equal(!malformed.allowed && malformed.code, "invalid_proposal");
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

describe("authorizeTradeProposal across exchange accounts (ADR 0009)", () => {
  // A second exchange account of the same customer, with its own strategy.
  const otherAccount = "10000000-0000-4000-8000-000000000013";
  const otherStrategy = "10000000-0000-4000-8000-000000000014";
  const onOther: TradeProposal = {
    ...proposal,
    proposalId: "10000000-0000-4000-8000-000000000015",
    exchangeAccountId: otherAccount,
    strategyId: otherStrategy,
  };
  const otherPolicy: ExecutionPolicy = {
    ...policy,
    exchangeAccountId: otherAccount,
    strategyId: otherStrategy,
  };

  it("checks a proposal only against the one exchange account it names", () => {
    // Plenty of capital on this account cannot pay for an entry on another.
    const result = authorizeTradeProposal(
      onOther,
      { ...policy, allocation: "1000000", maxPositionNotional: "1000000" },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "account_mismatch");
  });

  it("does not let spare capital on one account fund an entry on another", () => {
    // The other account's allocation is spent; this one has 700 to spare.
    const spent = {
      ...otherPolicy,
      committedCapital: "1000",
      reservedBudget: "0",
    };

    assert.equal(authorizeTradeProposal(proposal, policy, now).allowed, true);
    const result = authorizeTradeProposal(onOther, spent, now);
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "allocation_exceeded");
  });

  it("refuses a proposal that names no exchange account", () => {
    const { exchangeAccountId: _, ...unaddressed } = proposal;
    const result = authorizeTradeProposal(unaddressed, policy, now);

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "invalid_proposal");
  });

  it("never targets a read-only exchange account, however the rest checks out", () => {
    const result = authorizeTradeProposal(
      proposal,
      { ...policy, accountAccess: "read_only" },
      now,
    );

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "account_read_only");
  });

  it("trades only markets quoted in the account's accounting currency", () => {
    const euro: TradeProposal = {
      ...proposal,
      instrument: "BTC-EUR",
    };
    const allowsEuro = {
      ...policy,
      allowedInstruments: ["BTC-USDT" as const, "BTC-EUR" as const],
    };
    const inUsdt = authorizeTradeProposal(euro, allowsEuro, now);
    const inEur = authorizeTradeProposal(
      euro,
      { ...allowsEuro, accountingCurrency: "EUR" },
      now,
    );

    assert.equal(inUsdt.allowed, false);
    if (!inUsdt.allowed) assert.equal(inUsdt.code, "quote_currency_mismatch");
    assert.equal(inEur.allowed, true);
  });

  it("holds the same instrument on two accounts as two positions, never netted", () => {
    // This account's strategy holds its largest BTC position.
    const full = {
      ...policy,
      committedCapital: "750",
      reservedBudget: "0",
      positionNotionalByInstrument: { "BTC-USDT": "750" },
      protectedEntries: 1,
      maxProtectedEntries: 5,
    };
    // The other account's strategy holds nothing yet.
    const empty = {
      ...otherPolicy,
      committedCapital: "0",
      reservedBudget: "0",
      positionNotionalByInstrument: {},
      protectedEntries: 0,
      maxProtectedEntries: 5,
    };

    const here = authorizeTradeProposal(proposal, full, now);
    const there = authorizeTradeProposal(onOther, empty, now);
    // A position on the other account does not make room here...
    assert.equal(here.allowed, false);
    if (!here.allowed) assert.equal(here.code, "position_limit_exceeded");
    // ...and this account's position does not count against the other's.
    assert.equal(there.allowed, true);
    if (there.allowed) assert.equal(there.positionNotional, "600");
  });
});
