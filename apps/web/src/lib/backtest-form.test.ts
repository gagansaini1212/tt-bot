import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildBacktestRequest,
  DEFAULT_FORM,
  defaultPeriod,
  niceStep,
  suggestPrices,
  type BacktestForm,
} from "./backtest-form";

const period = { start: "2026-09-01", end: "2026-09-30" };
const grid: BacktestForm = {
  ...DEFAULT_FORM,
  grid: {
    ...DEFAULT_FORM.grid,
    lowerPrice: "77000",
    upperPrice: "82000",
    rangeStopPrice: "76000",
  },
};

describe("the backtest form", () => {
  test("defaults to the latest 30 whole UTC days", () => {
    assert.deepEqual(defaultPeriod("2026-10-08"), {
      start: "2026-09-08",
      end: "2026-10-07",
    });
  });

  test("builds grid rules whose entries expire with the period, including trailing stop", () => {
    const built = buildBacktestRequest(
      {
        ...grid,
        grid: { ...grid.grid, trailingStopPercent: "2" },
      },
      period,
    );
    assert.equal(built.status, "ready");
    assert.deepEqual(built.status === "ready" && built.rules, {
      kind: "grid",
      instrument: "BTC-USDT",
      marketKind: "spot",
      lowerPrice: "77000",
      upperPrice: "82000",
      levelCount: 6,
      amountPerLevel: "100",
      rangeStopPrice: "76000",
      trailingStopPercent: "2",
      entryExpiresAt: "2026-10-01T00:00:00.000Z",
      holdingPeriodSeconds: 168 * 3600,
      lossLimits: { daily: "50", total: "150" },
    });
  });

  test("starts DCA buys with the period, with the dip rule only when set", () => {
    const built = buildBacktestRequest(
      { ...DEFAULT_FORM, choice: "dca" },
      period,
    );
    assert.equal(built.status === "ready" && built.rules?.kind, "dca");
    const rules = built.status === "ready" ? built.rules : undefined;
    assert.equal(
      rules?.kind === "dca" && rules.startsAt,
      "2026-09-01T00:00:00.000Z",
    );
    assert.deepEqual(rules?.kind === "dca" && rules.dip, {
      dropPercent: "3",
      multiplier: "1.25",
    });

    const plain = buildBacktestRequest(
      {
        ...DEFAULT_FORM,
        choice: "dca",
        dca: { ...DEFAULT_FORM.dca, dipDropPercent: "", dipMultiplier: "" },
      },
      period,
    );
    assert.equal(
      plain.status === "ready" &&
        plain.rules?.kind === "dca" &&
        plain.rules.dip,
      undefined,
    );
  });

  test("names the field of the first problem", () => {
    assert.deepEqual(
      buildBacktestRequest(
        { ...grid, grid: { ...grid.grid, lowerPrice: "" } },
        period,
      ),
      {
        status: "invalid",
        message: "Lower price: Must be a non-negative decimal string",
      },
    );
    assert.deepEqual(
      buildBacktestRequest({ ...grid, holdingHours: "1.5" }, period),
      {
        status: "invalid",
        message: "Holding period: Enter a whole number of hours.",
      },
    );
    assert.deepEqual(
      buildBacktestRequest(
        {
          ...DEFAULT_FORM,
          choice: "standing_price_instruction",
          standing: [
            {
              quantity: "0.001",
              entryPrice: "80000",
              stopLossPrice: "81000",
              takeProfitPrice: "82000",
            },
          ],
        },
        period,
      ),
      {
        status: "invalid",
        message:
          "Entry 1: The stop loss and take profit must be on the protective sides of the entry price.",
      },
    );
    assert.deepEqual(
      buildBacktestRequest(grid, { start: "2026-09-01", end: "2026-10-01" }),
      {
        status: "invalid",
        message: "Period: A backtest covers at most 30 days.",
      },
    );
  });

  test("replays a recorded fixture without rules of its own", () => {
    const built = buildBacktestRequest(
      { ...DEFAULT_FORM, choice: "recorded_proposals" },
      period,
    );
    assert.deepEqual(built.status === "ready" && built.request, {
      source: "recorded_proposals",
      fixtureId: "sample-btc-2026-09",
      assumptions: DEFAULT_FORM.assumptions,
    });
  });
});

describe("price suggestions", () => {
  test("rounds steps up to 1, 2, 2.5 or 5 times a power of ten", () => {
    assert.equal(niceStep("812.7").toFixed(), "1000");
    assert.equal(niceStep("41.3").toFixed(), "50");
    assert.equal(niceStep("21").toFixed(), "25");
    assert.equal(niceStep("2").toFixed(), "2");
    assert.equal(niceStep("0.031").toFixed(), "0.05");
  });

  test("uses only the period's first open", () => {
    const suggestion = suggestPrices({
      firstOpen: "81270.37",
      tickSize: "0.01",
      stepSize: "0.00001",
    });
    assert.deepEqual(suggestion.grid, {
      lowerPrice: "78000",
      upperPrice: "83000",
      rangeStopPrice: "77000",
    });
    assert.deepEqual(suggestion.standing, {
      quantity: "0.00124",
      entryPrice: "80457.66",
      stopLossPrice: "77206.85",
      takeProfitPrice: "83708.49",
    });
    // The suggested grid passes the rules' own checks.
    assert.equal(
      buildBacktestRequest(
        { ...DEFAULT_FORM, grid: { ...DEFAULT_FORM.grid, ...suggestion.grid } },
        period,
      ).status,
      "ready",
    );
  });
});
