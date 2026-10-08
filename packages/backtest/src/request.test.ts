import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GridRules } from "@crypto-trading/domain";

import { DEFAULT_ASSUMPTIONS } from "./market";
import {
  backtestRequestSchema,
  periodBounds,
  resolveBacktest,
} from "./request";

const grid: GridRules = {
  kind: "grid",
  instrument: "ETH-USDT",
  marketKind: "spot",
  lowerPrice: "3000",
  upperPrice: "3500",
  levelCount: 6,
  amountPerLevel: "100",
  rangeStopPrice: "2900",
  entryExpiresAt: "2026-09-11T00:00:00.000Z",
  holdingPeriodSeconds: 7 * 24 * 60 * 60,
  lossLimits: { daily: "50", total: "150" },
};

const request = {
  source: "rules",
  rules: grid,
  period: { start: "2026-09-01", end: "2026-09-30" },
  allocation: "1000",
  assumptions: DEFAULT_ASSUMPTIONS,
};

const messages = (input: unknown) => {
  const parsed = backtestRequestSchema.safeParse(input);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
};

describe("backtest requests", () => {
  it("covers whole UTC days, up to 30 of them", () => {
    assert.deepEqual(messages(request), []);
    assert.deepEqual(periodBounds(request.period), {
      start: Date.parse("2026-09-01T00:00:00.000Z"),
      end: Date.parse("2026-10-01T00:00:00.000Z"),
    });
    assert.deepEqual(
      messages({
        ...request,
        period: { start: "2026-09-01", end: "2026-10-01" },
      }),
      ["A backtest covers at most 30 days."],
    );
    assert.deepEqual(
      messages({
        ...request,
        period: { start: "2026-09-02", end: "2026-09-01" },
      }),
      ["The period must not end before it starts."],
    );
  });

  it("requires rules that fit the allocation", () => {
    assert.deepEqual(messages({ ...request, allocation: "400" }), [
      "These rules can commit 500 at once, more than the allocation of 400.",
    ]);
  });

  it("backtests spot rules, and AI-managed strategies only from recorded proposals", () => {
    assert.deepEqual(
      messages({
        ...request,
        rules: {
          kind: "standing_price_instruction",
          instrument: "BTC-USDT",
          marketKind: "perpetual",
          direction: "long",
          leverage: 2,
          entries: [
            {
              quantity: "0.001",
              entryPrice: "50000",
              stopLossPrice: "49000",
              takeProfitPrice: "51000",
            },
          ],
          entryExpiresAt: "2026-09-11T00:00:00.000Z",
          holdingPeriodSeconds: 3600,
          lossLimits: { daily: "50", total: "150" },
        },
      }),
      [
        "Backtests cover spot only: perpetual funding, margin and liquidation are not simulated.",
      ],
    );
    assert.match(
      messages({
        ...request,
        rules: {
          kind: "ai_managed",
          allowedInstruments: ["BTC-USDT"],
          marketKind: "spot",
          allowShort: false,
          maxLeverage: 1,
          maxPositionNotional: "100",
          maxProtectedEntries: 2,
          holdingPeriodSeconds: 3600,
          takeProfitAdjustable: false,
          lossLimits: { daily: "50", total: "100" },
        },
      })[0],
      /needs recorded proposals/,
    );
  });

  it("takes the market, period and allocation of a recorded fixture from the fixture", () => {
    const resolved = resolveBacktest(
      backtestRequestSchema.parse({
        source: "recorded_proposals",
        fixtureId: "sample-btc-2026-09",
        assumptions: DEFAULT_ASSUMPTIONS,
      }),
    );
    assert.equal(resolved.instrument, "BTC-USDT");
    assert.equal(resolved.allocation, "1000");
    assert.equal(resolved.start, Date.parse("2026-09-04T00:00:00.000Z"));
    assert.equal(resolved.end, Date.parse("2026-09-11T00:00:00.000Z"));
    assert.equal(resolved.proposals?.length, 7);
    assert.deepEqual(
      messages({
        source: "recorded_proposals",
        fixtureId: "unknown",
        assumptions: DEFAULT_ASSUMPTIONS,
      }),
      ["There is no recorded-proposal fixture with that ID."],
    );
  });

  it("resolves a rules request to its instrument and hours", () => {
    const resolved = resolveBacktest(backtestRequestSchema.parse(request));
    assert.equal(resolved.instrument, "ETH-USDT");
    assert.equal(resolved.end - resolved.start, 30 * 24 * 60 * 60 * 1000);
    assert.equal(resolved.fixture, undefined);
  });
});
