import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Decimal from "decimal.js";

import { HOUR_MS } from "./candles";
import type { BacktestMarket } from "./market";
import {
  buyAndHold,
  maxDrawdown,
  PERIODS_PER_YEAR,
  sharpeRatio,
  tradeStats,
} from "./metrics";
import type { BacktestTrade } from "./simulator";

const curve = (...values: string[]) =>
  values.map((equity, index) => ({ time: index * HOUR_MS, equity }));

describe("maximum drawdown", () => {
  it("finds the deepest fall from an earlier peak, by percentage", () => {
    // 120 → 90 is 25%; 130 → 100 is a larger amount but only 23%.
    assert.deepEqual(maxDrawdown(curve("100", "120", "90", "130", "100")), {
      amount: "30",
      percent: "25",
      peakAt: HOUR_MS,
      troughAt: 2 * HOUR_MS,
    });
  });

  it("is zero when equity never falls", () => {
    assert.deepEqual(maxDrawdown(curve("100", "100", "101")), {
      amount: "0",
      percent: "0",
    });
  });
});

describe("Sharpe ratio", () => {
  it("annualises the mean hourly return over its sample deviation", () => {
    // Returns of +10%, −10% and +10%: mean 1/30, sample deviation √(2/150).
    const expected = new Decimal(1)
      .dividedBy(30)
      .dividedBy(new Decimal(2).dividedBy(150).sqrt())
      .times(new Decimal(PERIODS_PER_YEAR).sqrt());
    const sharpe = sharpeRatio(curve("100", "110", "99", "108.9"));
    assert.equal(new Decimal(sharpe!).toFixed(10), expected.toFixed(10));
    assert.equal(new Decimal(sharpe!).toFixed(2), "27.02");
  });

  it("subtracts the risk-free rate, spread across the year's hours", () => {
    const equity = curve("100", "110", "99", "108.9");
    const withoutRate = new Decimal(sharpeRatio(equity)!);
    const withRate = new Decimal(sharpeRatio(equity, "8.76")!);
    // 8.76% a year is 0.00001 an hour, taken off every return.
    const deviation = new Decimal(2).dividedBy(150).sqrt();
    assert.equal(
      withoutRate.minus(withRate).toFixed(10),
      new Decimal("0.00001")
        .dividedBy(deviation)
        .times(new Decimal(PERIODS_PER_YEAR).sqrt())
        .toFixed(10),
    );
  });

  it("is undefined without two returns or without any variation", () => {
    assert.equal(sharpeRatio(curve("100", "110")), null);
    assert.equal(sharpeRatio(curve("100", "100", "100")), null);
  });
});

describe("trade statistics", () => {
  const trade = (pnl: string, closed = true): BacktestTrade => ({
    key: "entry:0",
    entryAt: "2026-03-02T00:00:00.000Z",
    entryPrice: "50000",
    quantity: "0.001",
    stopLossPrice: "49000",
    takeProfitPrice: "51000",
    fees: "0.1",
    pnl,
    ...(closed
      ? {
          exit: {
            at: "2026-03-02T01:00:00.000Z",
            price: "51000",
            reason: "take_profit" as const,
          },
        }
      : {}),
  });

  it("rates closed trades by their result after fees", () => {
    assert.deepEqual(
      tradeStats([
        trade("1"),
        trade("-0.5"),
        trade("2"),
        trade("0"),
        trade("-3", false),
      ]),
      {
        trades: 5,
        closed: 4,
        open: 1,
        wins: 2,
        losses: 1,
        breakeven: 1,
        winRate: "50",
        lossRate: "25",
      },
    );
  });

  it("has no rates before a trade closes", () => {
    const stats = tradeStats([trade("1", false)]);
    assert.equal(stats.winRate, null);
    assert.equal(stats.lossRate, null);
  });
});

describe("buy-and-hold baseline", () => {
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

  it("buys with the whole allocation at the first open and holds", () => {
    const baseline = buyAndHold({
      candles: [
        { openTime: 0, open: "100", high: "101", low: "99", close: "100.5" },
        {
          openTime: HOUR_MS,
          open: "100.5",
          high: "111",
          low: "100",
          close: "110",
        },
      ],
      allocation: "1000",
      market,
      assumptions: {
        makerFeePercent: "0.1",
        takerFeePercent: "0.1",
        slippagePercent: "0.05",
      },
    });
    // 1000 / 1.001 buys 9.98501 at 100.05, leaving room for the 0.1% fee.
    assert.equal(baseline.entryPrice, "100.05");
    assert.equal(baseline.quantity, "9.98501");
    assert.equal(baseline.fee, "0.9990002505");
    assert.deepEqual(
      baseline.equity.map((point) => point.equity),
      ["1000", "1003.4942542495", "1098.3518492495"],
    );
  });
});
