import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AiManagedRules,
  DcaRules,
  GridRules,
  StandingPriceInstructionRules,
} from "@crypto-trading/domain";

import { HOUR_MS, type Candle } from "./candles";
import type { BacktestAssumptions, BacktestMarket } from "./market";
import type { RecordedProposal } from "./recorded-proposals";
import { simulate, type BacktestInput } from "./simulator";

// A Monday, 00:00 UTC.
const START = Date.parse("2026-03-02T00:00:00.000Z");
const at = (hour: number) => new Date(START + hour * HOUR_MS).toISOString();

/** Hourly candles from `START + offset` hours: open, high, low, close. */
function candles(
  rows: [string, string, string, string][],
  offset = 0,
): Candle[] {
  return rows.map(([open, high, low, close], hour) => ({
    openTime: START + (offset + hour) * HOUR_MS,
    open,
    high,
    low,
    close,
  }));
}

const market: BacktestMarket = {
  rules: {
    instrument: "BTC-USDT",
    trading: true,
    protectedEntryAllowed: true,
    minPrice: "0.01",
    maxPrice: "1000000",
    tickSize: "0.01",
    minQty: "0.00001",
    maxQty: "9000",
    stepSize: "0.00001",
    minNotional: "5",
    maxNotional: "9000000",
  },
  maxStopOrders: 5,
};

const free: BacktestAssumptions = {
  makerFeePercent: "0",
  takerFeePercent: "0",
  slippagePercent: "0",
};

type Entry = StandingPriceInstructionRules["entries"][number];
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  quantity: "0.001",
  entryPrice: "50000",
  stopLossPrice: "49000",
  takeProfitPrice: "51000",
  ...overrides,
});

function standing(
  entries: Entry[],
  overrides: Partial<StandingPriceInstructionRules> = {},
): StandingPriceInstructionRules {
  return {
    kind: "standing_price_instruction",
    instrument: "BTC-USDT",
    marketKind: "spot",
    direction: "long",
    leverage: 1,
    entries,
    entryExpiresAt: at(48),
    holdingPeriodSeconds: 24 * 60 * 60,
    lossLimits: { daily: "500", total: "500" },
    ...overrides,
  };
}

function run(
  rules: BacktestInput["rules"],
  rows: Candle[],
  options: Partial<BacktestInput> = {},
) {
  return simulate({
    rules,
    instrument: "BTC-USDT",
    candles: rows,
    allocation: "1000",
    market,
    assumptions: free,
    ...options,
  });
}

describe("limit fills", () => {
  it("fills a resting buy only when the price trades through it, at its price", () => {
    const result = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "50000", "50400"],
        ["50400", "50450", "49999.99", "50200"],
      ]),
    );
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].entryAt, at(1));
    assert.equal(result.trades[0].entryPrice, "50000");
    assert.equal(result.trades[0].exit, undefined);
  });

  it("buys at the ask at once when the entry is at or above it", () => {
    const result = run(
      standing([entry()]),
      candles([["49800", "49900", "49700", "49850"]]),
      { assumptions: { ...free, slippagePercent: "0.1" } },
    );
    // 49800 plus 0.1%, rounded up to the tick.
    assert.equal(result.trades[0].entryPrice, "49849.8");
    assert.equal(result.trades[0].entryAt, at(0));
  });

  it("takes profit only when the price trades through the target", () => {
    const result = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["50100", "51000", "50000", "50900"],
        ["50900", "51000.01", "50800", "50950"],
      ]),
    );
    assert.deepEqual(result.trades[0].exit, {
      at: at(2),
      price: "51000",
      reason: "take_profit",
    });
  });
});

describe("the worst order within a candle", () => {
  it("fills the stop loss before the take profit when a candle reaches both", () => {
    const result = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["50100", "51500", "48900", "50000"],
      ]),
    );
    assert.deepEqual(result.trades[0].exit, {
      at: at(1),
      price: "49000",
      reason: "stop_loss",
    });
  });

  it("takes no profit in the candle an entry filled in, but can stop it out", () => {
    const profit = run(
      standing([entry()]),
      candles([
        ["50500", "51200", "49990", "50800"],
        ["50800", "51000", "50700", "50900"],
      ]),
    );
    assert.equal(profit.trades[0].exit, undefined);

    const stopped = run(
      standing([entry()]),
      candles([["50500", "50600", "48500", "49500"]]),
    );
    assert.deepEqual(stopped.trades[0].exit, {
      at: at(0),
      price: "49000",
      reason: "stop_loss",
    });
  });

  it("lets an entry that filled at the open take profit in that candle", () => {
    const result = run(
      standing([entry()]),
      candles([["49800", "51100", "49700", "50900"]]),
    );
    assert.equal(result.trades[0].entryPrice, "49800");
    assert.equal(result.trades[0].exit?.reason, "take_profit");
  });

  it("sells a stop the market opened through from the open, less slippage", () => {
    const result = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["48000", "48200", "47900", "48100"],
      ]),
      { assumptions: { ...free, slippagePercent: "0.05" } },
    );
    // 48000 less 0.05%, rounded down to the tick.
    assert.equal(result.trades[0].exit?.price, "47976");
  });
});

describe("fees and equity", () => {
  it("charges maker fees on resting fills and taker fees on stops", () => {
    const assumptions = {
      makerFeePercent: "0.1",
      takerFeePercent: "0.2",
      slippagePercent: "0",
    };
    const profit = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["50100", "51100", "50000", "50900"],
      ]),
      { assumptions },
    );
    // Entry 50 USDT at 0.1%, exit 51 USDT at 0.1%.
    assert.equal(profit.fees, "0.101");
    assert.equal(profit.trades[0].fees, "0.101");
    assert.equal(profit.trades[0].pnl, "0.899");
    assert.equal(profit.realizedPnl, "1");
    assert.equal(profit.finalEquity, "1000.899");

    const loss = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["50100", "50200", "48900", "49100"],
      ]),
      { assumptions },
    );
    // Exit 49 USDT at the 0.2% taker fee.
    assert.equal(loss.fees, "0.148");
    assert.equal(loss.trades[0].pnl, "-1.148");
  });

  it("values open entries at each close, starting from the allocation", () => {
    const result = run(
      standing([entry()]),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["50100", "50300", "50000", "50250"],
      ]),
    );
    assert.deepEqual(
      result.equity.map(({ time, equity }) => [time, equity]),
      [
        [START, "1000"],
        // 950 USDT cash plus 0.001 BTC at the close.
        [START + HOUR_MS, "1000.1"],
        [START + 2 * HOUR_MS, "1000.25"],
      ],
    );
    assert.equal(result.unrealizedPnl, "0.25");
    assert.equal(result.trades[0].pnl, "0.25");
  });
});

describe("expiry and holding deadlines", () => {
  it("closes an entry at the first open at or after its deadline", () => {
    const result = run(
      standing([entry()], { holdingPeriodSeconds: 60 * 60 }),
      candles([
        ["49800", "50100", "49700", "50000"],
        ["50100", "50300", "50000", "50250"],
      ]),
    );
    // Bought at the 00:00 open, so due out at 01:00.
    assert.deepEqual(result.trades[0].exit, {
      at: at(1),
      price: "50100",
      reason: "holding_deadline",
    });
  });

  it("never closes an entry that filled during a candle before its deadline", () => {
    const result = run(
      standing([entry()], { holdingPeriodSeconds: 60 * 60 }),
      candles([
        ["50500", "50600", "49990", "50100"],
        ["50100", "50300", "50000", "50250"],
        ["50200", "50300", "50100", "50250"],
      ]),
    );
    // It filled some time before 01:00, so its hour may run until 02:00.
    assert.equal(result.trades[0].entryAt, at(0));
    assert.deepEqual(result.trades[0].exit, {
      at: at(2),
      price: "50200",
      reason: "holding_deadline",
    });
  });

  it("does not fill an entry in the candle it expires in, then cancels it", () => {
    const expiresMidCandle = run(
      standing([entry()], {
        entryExpiresAt: new Date(START + 1.5 * HOUR_MS).toISOString(),
      }),
      candles([
        ["50500", "50600", "50100", "50400"],
        ["50400", "50450", "49900", "50200"],
        ["50200", "50300", "49800", "50000"],
      ]),
    );
    assert.equal(expiresMidCandle.trades.length, 0);
    assert.equal(expiresMidCandle.state, "completed");

    const expiresAtClose = run(
      standing([entry()], { entryExpiresAt: at(2) }),
      candles([
        ["50500", "50600", "50100", "50400"],
        ["50400", "50450", "49900", "50200"],
      ]),
    );
    assert.equal(expiresAtClose.trades.length, 1);
  });
});

describe("loss limits", () => {
  it("closes everything and pauses the strategy when a limit is reached", () => {
    const result = run(
      standing(
        [
          entry({ stopLossPrice: "40000" }),
          entry({ entryPrice: "45000", stopLossPrice: "40000" }),
        ],
        { lossLimits: { daily: "1", total: "5" } },
      ),
      candles([
        ["50500", "50600", "49990", "49500"],
        ["48900", "49000", "44000", "44500"],
        ["44500", "44600", "43000", "44000"],
      ]),
    );
    assert.equal(result.state, "paused");
    // The loss is measured at the open: 0.001 × (48900 − 50000) = −1.1.
    assert.deepEqual(
      result.trades.map((trade) => trade.exit),
      [{ at: at(1), price: "48900", reason: "loss_limit" }],
    );
    assert.match(result.notices[0].message, /daily loss limit of 1 USDT/);
  });

  it("measures the daily limit from midnight UTC, and the total from the start", () => {
    const rules = standing([entry({ stopLossPrice: "40000" })], {
      lossLimits: { daily: "1", total: "2" },
    });
    // From 23:00: at midnight the entry is 0.8 down, at 01:00 1.5 down.
    const rows = candles(
      [
        ["50500", "50600", "49990", "49500"],
        ["49200", "49300", "49100", "49200"],
        ["48500", "48600", "48400", "48500"],
        ["47900", "48000", "47800", "47900"],
      ],
      -1,
    );
    const result = run(rules, rows);
    // 01:00: the day's loss is 0.7, below 1, and the total 1.5, below 2.
    // 02:00: the total reaches 2.1.
    assert.equal(result.trades[0].exit?.at, at(2));
    assert.match(result.notices[0].message, /total loss limit of 2 USDT/);
  });

  it("counts a loss in the day's last hour against that day", () => {
    const result = run(
      standing(
        [
          entry({ quantity: "0.01", stopLossPrice: "44000" }),
          entry({
            entryPrice: "43000",
            stopLossPrice: "40000",
            takeProfitPrice: "46000",
          }),
        ],
        { lossLimits: { daily: "50", total: "500" } },
      ),
      // From 22:00. The stop sells at 23:00 for a loss of 60.
      candles(
        [
          ["50500", "50600", "49990", "50000"],
          ["50000", "50100", "43900", "44500"],
          ["44500", "44600", "44400", "44500"],
          ["44000", "44100", "42900", "43500"],
        ],
        -2,
      ),
    );
    assert.equal(result.state, "paused");
    assert.equal(result.trades.length, 1);
    assert.deepEqual(result.notices[0], {
      at: at(-1),
      message:
        "The daily loss limit of 50 USDT was reached with a loss of 60.00 USDT. Pending entries were cancelled, open entries closed, and the strategy paused. A backtest does not resume it.",
    });
  });
});

describe("the exchange's stop-order limit", () => {
  const grid: GridRules = {
    kind: "grid",
    instrument: "BTC-USDT",
    marketKind: "spot",
    lowerPrice: "49000",
    upperPrice: "50000",
    levelCount: 11,
    amountPerLevel: "100",
    rangeStopPrice: "48000",
    entryExpiresAt: at(48),
    holdingPeriodSeconds: 7 * 24 * 60 * 60,
    lossLimits: { daily: "500", total: "500" },
  };
  const drop = candles([["49950", "49960", "49450", "49460"]]);

  it("holds at most five protected entries, however many levels are free", () => {
    const result = run(grid, drop);
    assert.equal(result.entryLimit, 5);
    assert.deepEqual(
      result.trades.map((trade) => trade.entryPrice),
      ["49900", "49800", "49700", "49600", "49500"],
    );
  });

  it("follows a lower stop-order limit", () => {
    const result = run(grid, drop, {
      market: { ...market, maxStopOrders: 3 },
    });
    assert.equal(result.entryLimit, 3);
    assert.equal(result.trades.length, 3);
  });
});

describe("grid range exits", () => {
  const grid: GridRules = {
    kind: "grid",
    instrument: "BTC-USDT",
    marketKind: "spot",
    lowerPrice: "49000",
    upperPrice: "50000",
    levelCount: 3,
    amountPerLevel: "100",
    rangeStopPrice: "48000",
    entryExpiresAt: at(48),
    holdingPeriodSeconds: 7 * 24 * 60 * 60,
    lossLimits: { daily: "500", total: "500" },
  };

  it("stops out every entry and completes when the price reaches the range stop", () => {
    const result = run(
      grid,
      candles([
        ["49800", "49900", "49400", "49450"],
        ["49450", "49500", "47950", "48100"],
        ["48100", "49800", "48000", "49700"],
      ]),
    );
    assert.equal(result.state, "completed");
    assert.deepEqual(
      result.trades.map((trade) => [trade.entryPrice, trade.exit?.reason]),
      [
        ["49500", "stop_loss"],
        ["49000", "stop_loss"],
      ],
    );
    assert.match(result.notices.at(-1)!.message, /range stop/);
  });

  it("closes what remains at the close and completes above the range", () => {
    const result = run(
      grid,
      candles([
        ["49800", "49900", "49400", "49450"],
        ["49450", "50100", "48900", "50050"],
      ]),
    );
    assert.equal(result.state, "completed");
    assert.deepEqual(
      result.trades.map((trade) => [trade.entryPrice, trade.exit]),
      [
        ["49500", { at: at(1), price: "50000", reason: "take_profit" }],
        ["49000", { at: at(1), price: "50050", reason: "range_exit" }],
      ],
    );
  });
});

describe("DCA buys", () => {
  const dca: DcaRules = {
    kind: "dca",
    instrument: "BTC-USDT",
    marketKind: "spot",
    amountPerBuy: "100",
    interval: "1h",
    startsAt: at(0),
    maxBuys: 4,
    stopLossPercent: "10",
    takeProfitPercent: "10",
    dip: { dropPercent: "2", multiplier: "1.5" },
    holdingPeriodSeconds: 7 * 24 * 60 * 60,
    lossLimits: { daily: "500", total: "500" },
  };

  it("buys at the ask with slippage and a taker fee, more on a dip", () => {
    const result = run(
      dca,
      candles([
        ["50000", "50100", "49900", "50000"],
        ["48900", "49000", "48800", "48900"],
      ]),
      {
        assumptions: {
          makerFeePercent: "0",
          takerFeePercent: "0.1",
          slippagePercent: "0.1",
        },
      },
    );
    assert.deepEqual(
      result.trades.map((trade) => [
        trade.entryPrice,
        trade.quantity,
        trade.fees,
      ]),
      [
        // 100 USDT at 50050 buys 0.00199 BTC.
        ["50050", "0.00199", "0.0995995"],
        // 48948.9 is at least 2% below 50050, so the buy spends 150 USDT.
        ["48948.9", "0.00306", "0.149783634"],
      ],
    );
  });

  it("skips buys while the strategy holds as many entries as it may", () => {
    const result = run(
      dca,
      candles([
        ["50000", "50100", "49900", "50000"],
        ["50000", "50100", "49900", "50000"],
        ["50000", "50100", "49900", "50000"],
        ["50000", "50100", "49900", "50000"],
        ["50000", "50100", "49900", "50000"],
      ]),
      { market: { ...market, maxStopOrders: 2 } },
    );
    assert.equal(result.trades.length, 2);
    assert.deepEqual(
      result.notices.map((notice) => notice.message),
      ["2 DCA buys were skipped: the strategy held as many entries as it may."],
    );
  });
});

describe("execution checks", () => {
  const ai: AiManagedRules = {
    kind: "ai_managed",
    allowedInstruments: ["BTC-USDT"],
    marketKind: "spot",
    allowShort: false,
    maxLeverage: 1,
    maxPositionNotional: "100",
    maxProtectedEntries: 3,
    holdingPeriodSeconds: 24 * 60 * 60,
    takeProfitAdjustable: false,
    lossLimits: { daily: "50", total: "100" },
  };
  const proposal = (
    overrides: Partial<RecordedProposal> = {},
  ): RecordedProposal => ({
    at: at(0),
    instrument: "BTC-USDT",
    marketKind: "spot",
    direction: "long",
    quantity: "0.001",
    entryPrice: "49000",
    stopLossPrice: "48000",
    takeProfitPrice: "51000",
    leverage: 1,
    entryExpiresAt: at(24),
    rationale: "Test proposal",
    ...overrides,
  });

  it("turns away recorded proposals that the rules or the exchange refuse", () => {
    const result = run(
      ai,
      candles([
        ["50000", "50100", "49900", "50000"],
        ["50000", "50100", "49900", "50000"],
      ]),
      {
        proposals: [
          proposal(),
          proposal({
            direction: "short",
            stopLossPrice: "50000",
            takeProfitPrice: "48000",
          }),
          proposal({ quantity: "0.002" }),
          proposal({ quantity: "0.0001" }),
          // With the first proposal's 49 USDT pending, 53.9 more is too much.
          proposal({ at: at(1), quantity: "0.0011" }),
        ],
      },
    );
    assert.deepEqual(result.rejections, {
      direction_not_allowed: 1,
      position_limit_exceeded: 2,
      exchange_filter: 1,
    });
    assert.deepEqual(
      result.notices.map((notice) => [notice.at, notice.message]),
      [
        [
          at(0),
          "Proposal 2 was turned away: The strategy does not open short positions.",
        ],
        [
          at(0),
          "Proposal 3 was turned away: The proposed position exceeds the strategy position limit.",
        ],
        [
          at(0),
          "Proposal 4 was turned away: Order value is below Binance's minimum of 5 USDT.",
        ],
        [
          at(1),
          "Proposal 5 was turned away: The proposed position exceeds the strategy position limit.",
        ],
      ],
    );
  });

  it("refuses rules it cannot simulate", () => {
    const rows = candles([["50000", "50100", "49900", "50000"]]);
    assert.throws(
      () =>
        run({ ...ai, marketKind: "perpetual", maxLeverage: 2 }, rows, {
          proposals: [],
        }),
      /spot strategies only/,
    );
    assert.throws(
      () => run(standing([entry()]), rows, { instrument: "ETH-USDT" }),
      /do not trade ETH-USDT/,
    );
    assert.throws(
      () =>
        run({ ...ai, allowedInstruments: ["BTC-USDT", "ETH-USDT"] }, rows, {
          proposals: [proposal({ instrument: "ETH-USDT" })],
        }),
      /must all be for BTC-USDT/,
    );
  });
});

it("gives the same result for the same input", () => {
  const input: BacktestInput = {
    rules: standing([entry()]),
    instrument: "BTC-USDT",
    candles: candles([
      ["50500", "50600", "49990", "50100"],
      ["50100", "51100", "50000", "50900"],
    ]),
    allocation: "1000",
    market,
    assumptions: { ...free, makerFeePercent: "0.1" },
  };
  assert.deepEqual(simulate(input), simulate(input));
});
