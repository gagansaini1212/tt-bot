import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { DEFAULT_ASSUMPTIONS } from "@crypto-trading/backtest";
import {
  BinanceHistoryError,
  type HistoricalSymbolFilters,
  type Kline,
} from "@crypto-trading/exchanges";

import type * as Backtest from "./backtest";
import { signInForTesting } from "./current-customer.testing";

let runBacktestRequest: typeof Backtest.runBacktestRequest;
let summarizePeriod: typeof Backtest.summarizePeriod;

before(async () => {
  signInForTesting();
  ({ runBacktestRequest, summarizePeriod } = await import("./backtest"));
});

const HOUR = 60 * 60 * 1000;
const SEPT_1 = Date.UTC(2026, 8, 1);

const filters: HistoricalSymbolFilters = {
  rules: {
    instrument: "BTC-USDT",
    venueSymbol: "BTCUSDT",
    status: "trading",
    protectedEntryAllowed: true,
    minPrice: "0.01000000",
    maxPrice: "1000000.00000000",
    tickSize: "0.01000000",
    minQty: "0.00001000",
    maxQty: "9000.00000000",
    stepSize: "0.00001000",
    minNotional: "5.00000000",
    maxNotional: "9000000.00000000",
  },
  maxStopOrders: 5,
};

function kline(openTime: number, price: number): Kline {
  const text = (value: number) => value.toFixed(2);
  return {
    openTime,
    open: text(price),
    high: text(price + 300),
    low: text(price - 300),
    close: text(price + 100),
    volume: "1",
    closeTime: openTime + HOUR - 1,
    quoteVolume: "1",
    trades: 1,
  };
}

function history(fail?: Error) {
  const calls: [string, number, number][] = [];
  return {
    calls,
    async hourlyKlines(instrument: string, start: number, end: number) {
      calls.push([instrument, start, end]);
      if (fail) throw fail;
      const klines: Kline[] = [];
      for (let time = start; time < end; time += HOUR)
        klines.push(kline(time, 80_000 + ((time - start) / HOUR) * 10));
      return klines;
    },
    async symbolFilters() {
      if (fail) throw fail;
      return filters;
    },
  };
}

const request = {
  source: "rules",
  rules: {
    kind: "grid",
    instrument: "BTC-USDT",
    marketKind: "spot",
    lowerPrice: "78000",
    upperPrice: "83000",
    levelCount: 6,
    amountPerLevel: "100",
    rangeStopPrice: "77000",
    entryExpiresAt: "2026-09-04T00:00:00.000Z",
    holdingPeriodSeconds: 7 * 24 * 3600,
    lossLimits: { daily: "50", total: "150" },
  },
  period: { start: "2026-09-01", end: "2026-09-03" },
  allocation: "1000",
  assumptions: DEFAULT_ASSUMPTIONS,
};

describe("running a backtest", () => {
  test("reads the period's closed candles and runs the rules", async () => {
    const source = history();
    const outcome = await runBacktestRequest(request, {
      history: source,
      now: Date.UTC(2026, 9, 8),
    });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(source.calls, [["BTC-USDT", SEPT_1, SEPT_1 + 72 * HOUR]]);
    const result = outcome.status === "completed" ? outcome.result : undefined;
    assert.equal(result?.candles, 72);
    assert.equal(result?.market.maxStopOrders, 5);
    assert.equal(result?.market.tickSize, "0.01");
    assert.equal(result?.equity.length, 73);
  });

  test("stops at the last hour that has closed", async () => {
    const source = history();
    await runBacktestRequest(request, {
      history: source,
      now: SEPT_1 + 30 * HOUR + 20 * 60_000,
    });
    assert.deepEqual(source.calls, [["BTC-USDT", SEPT_1, SEPT_1 + 30 * HOUR]]);

    const early = await runBacktestRequest(request, {
      history: history(),
      now: SEPT_1 + 20 * 60_000,
    });
    assert.deepEqual(early, {
      status: "invalid",
      message: "Choose a period that has already started.",
    });
  });

  test("explains invalid requests and unavailable data", async () => {
    assert.deepEqual(
      await runBacktestRequest(
        { ...request, allocation: "100" },
        { history: history() },
      ),
      {
        status: "invalid",
        message:
          "These rules can commit 500 at once, more than the allocation of 100.",
      },
    );
    assert.deepEqual(
      await runBacktestRequest(request, {
        history: history(new BinanceHistoryError("rate_limited", 30)),
        now: Date.UTC(2026, 9, 8),
      }),
      {
        status: "unavailable",
        message:
          "Binance market data is rate limited. Try again in 30 seconds.",
      },
    );
    assert.deepEqual(
      await runBacktestRequest(request, {
        history: history(new Error("ENOSPC /secret/path")),
        now: Date.UTC(2026, 9, 8),
      }),
      {
        status: "unavailable",
        message:
          "Binance's market data could not be read. Check the connection and try again.",
      },
    );
  });
});

test("summarizes a period's prices for suggestions", async () => {
  const outcome = await summarizePeriod(
    {
      instrument: "BTC-USDT",
      period: { start: "2026-09-01", end: "2026-09-01" },
    },
    { history: history(), now: Date.UTC(2026, 9, 8) },
  );
  assert.deepEqual(outcome, {
    status: "ready",
    summary: {
      instrument: "BTC-USDT",
      firstOpen: "80000.00",
      low: "79700.00",
      high: "80530.00",
      lastClose: "80330.00",
      candles: 24,
      tickSize: "0.01000000",
      stepSize: "0.00001000",
    },
  });
});
