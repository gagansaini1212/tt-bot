import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Decimal from "decimal.js";

import { entryIntentProposal, type EntryIntent } from "./entry-plans";
import {
  gridLevelEntry,
  gridLevels,
  gridRangePosition,
  planGridEntries,
  type GridState,
} from "./grid";
import type { GridRules } from "./strategy-rules";
import { authorizeTradeProposal } from "./trading";

const rules: GridRules = {
  kind: "grid",
  instrument: "BTC-USDT",
  marketKind: "spot",
  lowerPrice: "58000",
  upperPrice: "62000",
  levelCount: 5,
  amountPerLevel: "100",
  rangeStopPrice: "57000",
  entryExpiresAt: "2026-11-01T00:00:00.000Z",
  holdingPeriodSeconds: 14 * 24 * 60 * 60,
  lossLimits: { daily: "50", total: "150" },
};

const steps = { tickSize: "0.01", quantityStep: "0.00001" };

const state: GridState = {
  now: new Date("2026-10-08T12:00:00.000Z"),
  price: "60500",
  steps,
  occupiedLevels: [],
  maxProtectedEntries: 5,
};

describe("grid levels", () => {
  it("spaces the levels equally from the lower to the upper price", () => {
    assert.deepEqual(gridLevels(rules), [
      "58000",
      "59000",
      "60000",
      "61000",
      "62000",
    ]);
    assert.deepEqual(
      gridLevels({
        ...rules,
        lowerPrice: "0.5",
        upperPrice: "1",
        levelCount: 3,
      }),
      ["0.5", "0.75", "1"],
    );
  });

  it("takes profit at the next level up and stops at the range stop", () => {
    assert.deepEqual(gridLevelEntry(rules, 2, steps), {
      key: "level:2",
      instrument: "BTC-USDT",
      marketKind: "spot",
      direction: "long",
      leverage: 1,
      // 100 / 60000, floored to the step.
      quantity: "0.00166",
      entryPrice: "60000",
      stopLossPrice: "57000",
      takeProfitPrice: "61000",
      entryExpiresAt: "2026-11-01T00:00:00.000Z",
      holdingPeriodSeconds: 14 * 24 * 60 * 60,
    });
  });

  it("has no buy at the top level", () => {
    assert.equal(gridLevelEntry(rules, 3, steps)?.takeProfitPrice, "62000");
    assert.throws(() => gridLevelEntry(rules, 4, steps), RangeError);
    assert.throws(() => gridLevelEntry(rules, -1, steps), RangeError);
  });

  it("skips a level whose amount buys less than one step", () => {
    assert.equal(
      gridLevelEntry({ ...rules, amountPerLevel: "0.5" }, 0, steps),
      undefined,
    );
  });

  it("rounds prices off the tick: the buy down, the target and stop up", () => {
    // Levels 100, 100.01, 100.02 and 100.03.
    const narrow: GridRules = {
      ...rules,
      lowerPrice: "100",
      upperPrice: "100.03",
      levelCount: 4,
      rangeStopPrice: "99.9",
    };
    const prices = (intent: EntryIntent | undefined) =>
      intent && [
        intent.entryPrice,
        intent.takeProfitPrice,
        intent.stopLossPrice,
      ];

    assert.deepEqual(prices(gridLevelEntry(narrow, 1, steps)), [
      "100.01",
      "100.02",
      "99.9",
    ]);
    assert.deepEqual(
      prices(gridLevelEntry(narrow, 1, { ...steps, tickSize: "0.02" })),
      ["100", "100.02", "99.9"],
    );
  });

  it("skips a level when rounding leaves its stop at the entry", () => {
    const narrow: GridRules = {
      ...rules,
      lowerPrice: "100",
      upperPrice: "100.03",
      levelCount: 4,
      rangeStopPrice: "99.995",
    };

    // The stop rounds up to 100, which is where level 0 buys.
    assert.equal(gridLevelEntry(narrow, 0, steps), undefined);
    assert.deepEqual(planGridEntries(narrow, { ...state, price: "100.005" }), {
      action: "wait",
      reason: "unprotectable",
    });
  });
});

describe("gridRangePosition", () => {
  it("stops at or below the range stop", () => {
    assert.equal(gridRangePosition(rules, "57000"), "range_stop");
    assert.equal(gridRangePosition(rules, "56999.99"), "range_stop");
    assert.equal(gridRangePosition(rules, "57000.01"), "in_range");
  });

  it("leaves the range only above the upper price", () => {
    assert.equal(gridRangePosition(rules, "62000"), "in_range");
    assert.equal(gridRangePosition(rules, "62000.01"), "above_range");
  });
});

describe("planGridEntries", () => {
  it("buys at every free level below the market, nearest first", () => {
    const plan = planGridEntries(rules, state);

    assert.equal(plan.action, "enter");
    if (plan.action === "enter")
      assert.deepEqual(
        plan.intents.map((intent) => [intent.key, intent.takeProfitPrice]),
        [
          ["level:2", "61000"],
          ["level:1", "60000"],
          ["level:0", "59000"],
        ],
      );
  });

  it("never buys at a level the market is at, so no buy fills at once", () => {
    const plan = planGridEntries(rules, { ...state, price: "60000" });

    assert.equal(plan.action, "enter");
    if (plan.action === "enter")
      assert.deepEqual(
        plan.intents.map((intent) => intent.key),
        ["level:1", "level:0"],
      );
  });

  it("skips occupied levels and buys a level again once its entry closes", () => {
    const occupied = planGridEntries(rules, {
      ...state,
      occupiedLevels: [2, 0],
    });
    assert.equal(occupied.action, "enter");
    if (occupied.action === "enter")
      assert.deepEqual(
        occupied.intents.map((intent) => intent.key),
        ["level:1"],
      );

    assert.deepEqual(
      planGridEntries(rules, { ...state, occupiedLevels: [0, 1, 2] }),
      { action: "wait", reason: "no_free_level" },
    );
  });

  it("stops at the most protected entries the strategy may hold", () => {
    const plan = planGridEntries(rules, {
      ...state,
      occupiedLevels: [3],
      maxProtectedEntries: 3,
    });
    assert.equal(plan.action, "enter");
    if (plan.action === "enter")
      assert.deepEqual(
        plan.intents.map((intent) => intent.key),
        ["level:2", "level:1"],
      );

    assert.deepEqual(
      planGridEntries(rules, {
        ...state,
        occupiedLevels: [3, 2, 1],
        maxProtectedEntries: 3,
      }),
      { action: "wait", reason: "entry_limit" },
    );
  });

  it("closes everything when the market reaches the range stop", () => {
    assert.deepEqual(
      planGridEntries(rules, { ...state, price: "57000", occupiedLevels: [0] }),
      { action: "close_and_complete", reason: "range_stop" },
    );
  });

  it("closes everything when the market leaves the range upwards", () => {
    assert.deepEqual(planGridEntries(rules, { ...state, price: "62000.01" }), {
      action: "close_and_complete",
      reason: "above_range",
    });
  });

  it("waits between the lowest level and the range stop", () => {
    assert.deepEqual(planGridEntries(rules, { ...state, price: "57500" }), {
      action: "wait",
      reason: "no_free_level",
    });
  });

  it("opens no entries once the grid expires, but still honours the range stop", () => {
    const expired = { ...state, now: new Date(rules.entryExpiresAt) };

    assert.deepEqual(planGridEntries(rules, expired), {
      action: "no_more_entries",
      reason: "expired",
    });
    assert.deepEqual(planGridEntries(rules, { ...expired, price: "56000" }), {
      action: "close_and_complete",
      reason: "range_stop",
    });
  });

  it("waits when no level's amount buys a whole step", () => {
    assert.deepEqual(
      planGridEntries({ ...rules, amountPerLevel: "0.5" }, state),
      { action: "wait", reason: "unprotectable" },
    );
  });

  it("produces entries that pass the execution checks within the allocation", () => {
    const plan = planGridEntries(rules, state);
    assert.equal(plan.action, "enter");
    if (plan.action !== "enter") return;

    let reserved = new Decimal(0);
    for (const [index, intent] of plan.intents.entries()) {
      const result = authorizeTradeProposal(
        entryIntentProposal(intent, {
          proposalId: `10000000-0000-4000-8000-00000000000${index}`,
          customerId: "10000000-0000-4000-8000-000000000010",
          exchangeAccountId: "10000000-0000-4000-8000-000000000011",
          strategyId: "10000000-0000-4000-8000-000000000012",
          strategyVersion: 1,
          sourceSnapshotId: "10000000-0000-4000-8000-000000000013",
          rationale: `Grid buy at ${intent.entryPrice}.`,
        }),
        {
          customerId: "10000000-0000-4000-8000-000000000010",
          exchangeAccountId: "10000000-0000-4000-8000-000000000011",
          accountAccess: "trade",
          accountingCurrency: "USDT",
          strategyId: "10000000-0000-4000-8000-000000000012",
          strategyVersion: 1,
          tradingMode: "simulation",
          strategyStatus: "simulation",
          liveTradingEnabled: false,
          allowedInstruments: ["BTC-USDT"],
          allocation: "400",
          committedCapital: "0",
          reservedBudget: reserved.toFixed(),
          maxPositionNotional: "400",
          maxLeverage: 1,
          positionNotionalByInstrument: { "BTC-USDT": reserved.toFixed() },
          protectedEntries: index,
          maxProtectedEntries: 4,
        },
        state.now,
      );
      assert.equal(result.allowed, true, intent.key);
      if (result.allowed) reserved = reserved.plus(result.reservationAmount);
    }
  });
});
