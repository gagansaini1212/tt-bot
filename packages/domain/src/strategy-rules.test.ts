import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aiManagedRulesSchema,
  allocationIssues,
  dcaRulesSchema,
  gridRulesSchema,
  maximumCommitment,
  ruleLimits,
  standingPriceInstructionRulesSchema,
  strategyRulesSchema,
  strategyRulesWithinAllocation,
  type AiManagedRules,
  type DcaRules,
  type GridRules,
  type StandingPriceInstructionRules,
} from "./strategy-rules";

const lossLimits = { daily: "50", total: "150" };

const standingRules: StandingPriceInstructionRules = {
  kind: "standing_price_instruction",
  instrument: "BTC-USDT",
  marketKind: "spot",
  direction: "long",
  leverage: 1,
  entries: [
    {
      quantity: "0.002",
      entryPrice: "60000",
      stopLossPrice: "57000",
      takeProfitPrice: "66000",
    },
    {
      quantity: "0.003",
      entryPrice: "58000",
      stopLossPrice: "55000",
      takeProfitPrice: "64000",
    },
  ],
  entryExpiresAt: "2026-10-15T00:00:00.000Z",
  holdingPeriodSeconds: 7 * 24 * 60 * 60,
  lossLimits,
};

const aiRules: AiManagedRules = {
  kind: "ai_managed",
  allowedInstruments: ["BTC-USDT", "ETH-USDT"],
  marketKind: "spot",
  allowShort: false,
  maxLeverage: 1,
  maxPositionNotional: "300",
  maxProtectedEntries: 4,
  holdingPeriodSeconds: 24 * 60 * 60,
  takeProfitAdjustable: false,
  lossLimits,
};

const dcaRules: DcaRules = {
  kind: "dca",
  instrument: "BTC-USDT",
  marketKind: "spot",
  amountPerBuy: "25",
  interval: "1d",
  startsAt: "2026-10-01T09:00:00.000Z",
  maxBuys: 10,
  stopLossPercent: "10",
  takeProfitPercent: "20",
  dip: { dropPercent: "5", multiplier: "1.5" },
  holdingPeriodSeconds: 30 * 24 * 60 * 60,
  lossLimits,
};

const gridRules: GridRules = {
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
  lossLimits,
};

function issuePaths(result: ReturnType<typeof strategyRulesSchema.safeParse>) {
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("strategyRulesSchema", () => {
  it("accepts valid rules of every kind", () => {
    for (const rules of [standingRules, aiRules, dcaRules, gridRules])
      assert.deepEqual(strategyRulesSchema.parse(rules), rules);
  });

  it("rejects an unknown kind and unknown fields", () => {
    assert.equal(
      strategyRulesSchema.safeParse({ ...gridRules, kind: "martingale" })
        .success,
      false,
    );
    assert.deepEqual(
      issuePaths(strategyRulesSchema.safeParse({ ...dcaRules, leverage: 3 })),
      [""],
    );
  });

  it("requires both loss limits, with the daily limit no higher than the total", () => {
    assert.deepEqual(
      issuePaths(
        strategyRulesSchema.safeParse({
          ...gridRules,
          lossLimits: { daily: "150.01", total: "150" },
        }),
      ),
      ["lossLimits.daily"],
    );
    assert.equal(
      strategyRulesSchema.safeParse({
        ...gridRules,
        lossLimits: { daily: "150", total: "150" },
      }).success,
      true,
    );
    assert.equal(
      strategyRulesSchema.safeParse({ ...gridRules, lossLimits: undefined })
        .success,
      false,
    );
  });

  it("bounds the holding period", () => {
    const parse = (holdingPeriodSeconds: number) =>
      strategyRulesSchema.safeParse({ ...aiRules, holdingPeriodSeconds })
        .success;

    assert.equal(parse(59), false);
    assert.equal(parse(60), true);
    assert.equal(parse(90 * 24 * 60 * 60), true);
    assert.equal(parse(90 * 24 * 60 * 60 + 1), false);
  });
});

describe("standing price instruction rules", () => {
  const parse = (rules: object) =>
    issuePaths(standingPriceInstructionRulesSchema.safeParse(rules));

  it("requires at least one entry and at most ten", () => {
    assert.deepEqual(parse({ ...standingRules, entries: [] }), ["entries"]);
    assert.deepEqual(
      parse({
        ...standingRules,
        entries: Array(11).fill(standingRules.entries[0]),
      }),
      ["entries"],
    );
  });

  it("requires a stop loss on every entry, on its protective side", () => {
    const [first, second] = standingRules.entries;
    assert.deepEqual(
      parse({
        ...standingRules,
        entries: [first, { ...second, stopLossPrice: undefined }],
      }),
      ["entries.1.stopLossPrice"],
    );
    assert.deepEqual(
      parse({
        ...standingRules,
        entries: [first, { ...second, stopLossPrice: "58000" }],
      }),
      ["entries.1"],
    );
    assert.deepEqual(
      parse({
        ...standingRules,
        entries: [{ ...first, takeProfitPrice: "60000" }, second],
      }),
      ["entries.0"],
    );
  });

  it("keeps spot entries long and unleveraged", () => {
    assert.deepEqual(parse({ ...standingRules, leverage: 2 }), ["leverage"]);
    assert.deepEqual(
      parse({
        ...standingRules,
        direction: "short",
        entries: [
          {
            quantity: "0.002",
            entryPrice: "60000",
            stopLossPrice: "63000",
            takeProfitPrice: "54000",
          },
        ],
      }),
      ["direction"],
    );
  });

  it("allows a leveraged short perpetual entry", () => {
    assert.deepEqual(
      parse({
        ...standingRules,
        marketKind: "perpetual",
        direction: "short",
        leverage: 3,
        entries: [
          {
            quantity: "0.002",
            entryPrice: "60000",
            stopLossPrice: "63000",
            takeProfitPrice: "54000",
          },
        ],
      }),
      [],
    );
    assert.deepEqual(
      parse({ ...standingRules, marketKind: "perpetual", leverage: 11 }),
      ["leverage"],
    );
  });

  it("requires an explicit expiry", () => {
    assert.deepEqual(parse({ ...standingRules, entryExpiresAt: undefined }), [
      "entryExpiresAt",
    ]);
  });
});

describe("AI-managed rules", () => {
  const parse = (rules: object) =>
    issuePaths(aiManagedRulesSchema.safeParse(rules));

  it("keeps spot strategies long and unleveraged", () => {
    assert.deepEqual(parse({ ...aiRules, allowShort: true }), ["allowShort"]);
    assert.deepEqual(parse({ ...aiRules, maxLeverage: 2 }), ["maxLeverage"]);
    assert.deepEqual(
      parse({
        ...aiRules,
        marketKind: "perpetual",
        allowShort: true,
        maxLeverage: 10,
      }),
      [],
    );
  });

  it("requires distinct instruments and bounds the entries", () => {
    assert.deepEqual(
      parse({ ...aiRules, allowedInstruments: ["BTC-USDT", "BTC-USDT"] }),
      ["allowedInstruments"],
    );
    assert.deepEqual(parse({ ...aiRules, allowedInstruments: [] }), [
      "allowedInstruments",
    ]);
    assert.deepEqual(parse({ ...aiRules, maxProtectedEntries: 0 }), [
      "maxProtectedEntries",
    ]);
    assert.deepEqual(parse({ ...aiRules, maxProtectedEntries: 11 }), [
      "maxProtectedEntries",
    ]);
  });
});

describe("DCA rules", () => {
  const parse = (rules: object) => issuePaths(dcaRulesSchema.safeParse(rules));

  it("is spot only", () => {
    assert.deepEqual(parse({ ...dcaRules, marketKind: "perpetual" }), [
      "marketKind",
    ]);
  });

  it("bounds the stop loss and take profit percentages", () => {
    assert.deepEqual(parse({ ...dcaRules, stopLossPercent: "0.09" }), [
      "stopLossPercent",
    ]);
    assert.deepEqual(parse({ ...dcaRules, stopLossPercent: "0.1" }), []);
    assert.deepEqual(parse({ ...dcaRules, stopLossPercent: "50" }), []);
    assert.deepEqual(parse({ ...dcaRules, stopLossPercent: "50.01" }), [
      "stopLossPercent",
    ]);
    assert.deepEqual(parse({ ...dcaRules, takeProfitPercent: "1000.1" }), [
      "takeProfitPercent",
    ]);
  });

  it("caps the dip multiplier at 2 and requires it to raise the buy", () => {
    const dip = (multiplier: string) =>
      parse({ ...dcaRules, dip: { dropPercent: "5", multiplier } });

    assert.deepEqual(dip("1"), ["dip.multiplier"]);
    assert.deepEqual(dip("1.01"), []);
    assert.deepEqual(dip("2"), []);
    assert.deepEqual(dip("2.01"), ["dip.multiplier"]);
    assert.deepEqual(parse({ ...dcaRules, dip: undefined }), []);
  });

  it("bounds the number of buys", () => {
    assert.deepEqual(parse({ ...dcaRules, maxBuys: 0 }), ["maxBuys"]);
    assert.deepEqual(parse({ ...dcaRules, maxBuys: 1000 }), []);
    assert.deepEqual(parse({ ...dcaRules, maxBuys: 1001 }), ["maxBuys"]);
  });

  it("accepts only the listed intervals", () => {
    assert.deepEqual(parse({ ...dcaRules, interval: "1m" }), ["interval"]);
  });
});

describe("grid rules", () => {
  const parse = (rules: object) => issuePaths(gridRulesSchema.safeParse(rules));

  it("requires the upper price above the lower price", () => {
    assert.deepEqual(parse({ ...gridRules, upperPrice: "58000" }), [
      "upperPrice",
    ]);
  });

  it("requires the range stop below the lowest level", () => {
    assert.deepEqual(parse({ ...gridRules, rangeStopPrice: "58000" }), [
      "rangeStopPrice",
    ]);
    assert.deepEqual(parse({ ...gridRules, rangeStopPrice: "57999.99" }), []);
    assert.deepEqual(parse({ ...gridRules, rangeStopPrice: undefined }), [
      "rangeStopPrice",
    ]);
  });

  it("requires levels at exact, equal steps", () => {
    // 4000 over 3 steps is 1333.33…
    assert.deepEqual(parse({ ...gridRules, levelCount: 4 }), ["levelCount"]);
    // 4000 over 8 steps is 500.
    assert.deepEqual(parse({ ...gridRules, levelCount: 9 }), []);
    // 2 over 3 steps is 0.666…, however far the digits go.
    assert.deepEqual(
      parse({
        ...gridRules,
        lowerPrice: "100",
        upperPrice: "102",
        levelCount: 4,
        rangeStopPrice: "99",
      }),
      ["levelCount"],
    );
    assert.deepEqual(
      parse({
        ...gridRules,
        lowerPrice: "100",
        upperPrice: "100.00000000000000002",
        levelCount: 4,
        rangeStopPrice: "99",
      }),
      ["levelCount"],
    );
    assert.deepEqual(
      parse({
        ...gridRules,
        lowerPrice: "100",
        upperPrice: "100.03",
        levelCount: 4,
        rangeStopPrice: "99",
      }),
      [],
    );
  });

  it("bounds the level count", () => {
    assert.deepEqual(parse({ ...gridRules, levelCount: 1 }), ["levelCount"]);
    assert.deepEqual(parse({ ...gridRules, levelCount: 2 }), []);
    assert.deepEqual(parse({ ...gridRules, levelCount: 101 }), ["levelCount"]);
  });
});

describe("maximumCommitment and ruleLimits", () => {
  it("adds up every entry a standing instruction plans", () => {
    // 0.002 × 60000 + 0.003 × 58000
    assert.equal(maximumCommitment(standingRules), "294");
    assert.deepEqual(ruleLimits(standingRules), {
      allowedInstruments: ["BTC-USDT"],
      marketKind: "spot",
      allowedDirections: ["long"],
      maxLeverage: 1,
      maxPositionNotional: "294",
      maxProtectedEntries: 2,
    });
  });

  it("counts a leveraged perpetual instruction's margin", () => {
    assert.equal(
      maximumCommitment({
        ...standingRules,
        marketKind: "perpetual",
        leverage: 3,
      }),
      "98",
    );
  });

  it("bounds a DCA by every buy at the dip multiplier", () => {
    assert.equal(maximumCommitment(dcaRules), "375");
    assert.equal(maximumCommitment({ ...dcaRules, dip: undefined }), "250");
    assert.equal(ruleLimits(dcaRules).maxProtectedEntries, 10);
    assert.equal(ruleLimits(dcaRules).maxLeverage, 1);
  });

  it("bounds a grid by a buy at every level below the top", () => {
    assert.equal(maximumCommitment(gridRules), "400");
    assert.deepEqual(ruleLimits(gridRules), {
      allowedInstruments: ["BTC-USDT"],
      marketKind: "spot",
      allowedDirections: ["long"],
      maxLeverage: 1,
      maxPositionNotional: "400",
      maxProtectedEntries: 4,
    });
  });

  it("bounds an AI-managed strategy by each instrument's position limit", () => {
    assert.equal(maximumCommitment(aiRules), "600");
    assert.equal(ruleLimits(aiRules).maxProtectedEntries, 4);
    assert.deepEqual(ruleLimits(aiRules).allowedDirections, ["long"]);
    assert.deepEqual(
      ruleLimits({
        ...aiRules,
        marketKind: "perpetual",
        allowShort: true,
        maxLeverage: 3,
      }).allowedDirections,
      ["long", "short"],
    );
  });
});

describe("allocation fit", () => {
  it("accepts a plan that adds up to exactly the allocation", () => {
    assert.deepEqual(allocationIssues(gridRules, "400"), []);
    assert.deepEqual(allocationIssues(dcaRules, "375"), []);
  });

  it("rejects a plan that adds up to more than the allocation", () => {
    assert.deepEqual(allocationIssues(gridRules, "399.99"), [
      {
        path: [],
        message:
          "These rules can commit 400 at once, more than the allocation of 399.99.",
      },
    ]);
    assert.equal(allocationIssues(standingRules, "293").length, 1);
  });

  it("requires an AI-managed position limit within the allocation", () => {
    assert.deepEqual(allocationIssues(aiRules, "300"), []);
    assert.deepEqual(
      allocationIssues(aiRules, "299").map((issue) => issue.path),
      [["maxPositionNotional"]],
    );
  });

  it("rejects a total loss limit above the allocation", () => {
    assert.deepEqual(
      allocationIssues({ ...gridRules, amountPerLevel: "10" }, "149").map(
        (issue) => issue.path,
      ),
      [["lossLimits", "total"]],
    );
  });

  it("reports allocation issues through the schema", () => {
    const result = strategyRulesWithinAllocation("399").safeParse(gridRules);

    assert.equal(result.success, false);
    assert.equal(
      strategyRulesWithinAllocation("400").safeParse(gridRules).success,
      true,
    );
    assert.throws(() => strategyRulesWithinAllocation("0"));
  });
});
