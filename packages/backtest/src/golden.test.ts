import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { it } from "node:test";

import { runBacktest } from "./backtest";
import { candleSeriesSchema } from "./candles";
import { DEFAULT_ASSUMPTIONS, type BacktestMarket } from "./market";
import { recordedProposalFixture } from "./recorded-proposals";

// BTCUSDT hourly candles for 4–10 September 2026, recorded from
// data-api.binance.vision, and BTCUSDT's filters from its exchangeInfo.
const recording = JSON.parse(
  await readFile(
    new URL("./fixtures/btcusdt-1h-2026-09-04.json", import.meta.url),
    "utf8",
  ),
);
const candles = candleSeriesSchema.parse(recording.candles);
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
const common = {
  instrument: "BTC-USDT",
  candles,
  allocation: "1000",
  market,
  assumptions: DEFAULT_ASSUMPTIONS,
} as const;
const lossLimits = { daily: "50", total: "150" };
const fixture = recordedProposalFixture("sample-btc-2026-09")!;

const GOLDEN = new URL("./fixtures/golden-runs.json", import.meta.url);

it("replays the recorded week exactly as before", async () => {
  const runs = {
    grid: runBacktest({
      ...common,
      rules: {
        kind: "grid",
        instrument: "BTC-USDT",
        marketKind: "spot",
        lowerPrice: "77000",
        upperPrice: "81500",
        levelCount: 10,
        amountPerLevel: "100",
        rangeStopPrice: "76000",
        entryExpiresAt: "2026-09-11T00:00:00.000Z",
        holdingPeriodSeconds: 7 * 24 * 60 * 60,
        lossLimits,
      },
    }),
    dca: runBacktest({
      ...common,
      rules: {
        kind: "dca",
        instrument: "BTC-USDT",
        marketKind: "spot",
        amountPerBuy: "40",
        interval: "4h",
        startsAt: "2026-09-04T00:00:00.000Z",
        maxBuys: 20,
        stopLossPercent: "3",
        takeProfitPercent: "1",
        dip: { dropPercent: "1", multiplier: "1.25" },
        holdingPeriodSeconds: 2 * 24 * 60 * 60,
        lossLimits,
      },
    }),
    recordedProposals: runBacktest({
      ...common,
      rules: fixture.rules,
      allocation: fixture.allocation,
      proposals: fixture.proposals,
      fixture,
    }),
  };
  // Run with UPDATE_GOLDEN=1 to record a deliberate change, then review the
  // diff and run Prettier on the file.
  if (process.env.UPDATE_GOLDEN === "1")
    await writeFile(GOLDEN, `${JSON.stringify(runs, null, 2)}\n`);
  const golden = JSON.parse(await readFile(GOLDEN, "utf8"));
  assert.deepEqual(runs, golden);
});
