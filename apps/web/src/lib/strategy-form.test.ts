import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  StrategyMarket,
  StrategyView,
} from "@crypto-trading/exchanges/strategies";

import {
  backtestFormFor,
  buildStrategyDraft,
  formatDuration,
  newStrategyForm,
  strategyEffects,
  strategyFormFrom,
  type StrategyForm,
} from "./strategy-form";

const now = Date.parse("2026-10-08T12:00:00Z");
const btc: StrategyMarket = {
  instrument: "BTC-USDT",
  lastPrice: "60000",
  bestAsk: "60000.01",
  tickSize: "0.01",
  stepSize: "0.00001",
  minNotional: "5",
  maxStopOrders: 5,
  stopOrdersInUse: 0,
};

function ready(form: StrategyForm) {
  const built = buildStrategyDraft(form);
  assert.equal(
    built.status,
    "ready",
    built.status === "invalid" ? built.message : "",
  );
  return built.status === "ready" ? built.draft : undefined!;
}

describe("the strategy form", () => {
  test("suggests a grid around the market that fits its allocation", () => {
    const form = { ...newStrategyForm("grid", now, btc), name: "Grid" };
    assert.deepEqual(
      {
        lower: form.grid.lowerPrice,
        upper: form.grid.upperPrice,
        stop: form.grid.rangeStopPrice,
      },
      { lower: "57000", upper: "62000", stop: "56000" },
    );
    const draft = ready(form);
    assert.equal(draft.rules.kind, "grid");
    assert.equal(
      draft.rules.kind === "grid" && draft.rules.entryExpiresAt,
      "2026-10-15T12:00:00.000Z",
    );
  });

  test("names the field of the first problem, and checks the allocation", () => {
    const form = { ...newStrategyForm("grid", now, btc), name: "Grid" };
    assert.deepEqual(
      buildStrategyDraft({
        ...form,
        grid: { ...form.grid, rangeStopPrice: "60000" },
      }),
      {
        status: "invalid",
        message: "Range stop: The range stop must be below the lower price.",
      },
    );
    assert.deepEqual(buildStrategyDraft({ ...form, allocation: "400" }), {
      status: "invalid",
      message:
        "Allocation: These rules can commit 500 at once, more than the allocation of 400.",
    });
    assert.deepEqual(buildStrategyDraft({ ...form, holdingHours: "1.005" }), {
      status: "invalid",
      message: "Holding period: Enter hours with at most 2 decimals.",
    });
    assert.deepEqual(
      buildStrategyDraft({
        ...form,
        grid: { ...form.grid, entryExpiresAt: "soon" },
      }),
      {
        status: "invalid",
        message: "Entries expire: Enter a date and time in UTC.",
      },
    );
    assert.deepEqual(buildStrategyDraft({ ...form, name: " " }), {
      status: "invalid",
      message: "Name: Give it a name.",
    });
  });

  test("builds an AI-managed strategy that needs approval by default, spot and long only", () => {
    const draft = ready({ ...newStrategyForm("ai_managed", now), name: "AI" });
    assert.deepEqual(draft.ai, {
      proposalApproval: "required",
      analysisIntervalMinutes: 60,
    });
    assert.equal(
      draft.rules.kind === "ai_managed" && draft.rules.allowShort,
      false,
    );
    assert.equal(
      draft.rules.kind === "ai_managed" && draft.rules.maxLeverage,
      1,
    );
  });

  test("shows each grid level exactly as the worker would place it", () => {
    const form = newStrategyForm("grid", now, btc);
    const draft = ready({
      ...form,
      name: "Grid",
      grid: {
        ...form.grid,
        lowerPrice: "57000",
        upperPrice: "63000",
        levelCount: "7",
        rangeStopPrice: "56000",
      },
      allocation: "600",
    });
    const { entries, effects, warnings } = strategyEffects(draft, [btc], now);
    assert.deepEqual(warnings, []);
    assert.equal(
      effects.find((effect) => effect.label === "Entries at once")?.value,
      "5",
    );
    assert.deepEqual(
      entries.map((entry) => [
        entry.label,
        entry.price,
        entry.quantity,
        entry.takeProfit,
        entry.note,
      ]),
      [
        ["Level 6", "62000", "0.00161", "63000", "Above the market"],
        ["Level 5", "61000", "0.00163", "62000", "Above the market"],
        ["Level 4", "60000", "0.00166", "61000", "Above the market"],
        ["Level 3", "59000", "0.00169", "60000", "Rests now"],
        ["Level 2", "58000", "0.00172", "59000", "Rests now"],
        ["Level 1", "57000", "0.00175", "58000", "Rests now"],
      ],
    );
    // Outside its range, a grid would complete at once.
    assert.match(
      strategyEffects(draft, [{ ...btc, lastPrice: "64000" }], now).warnings[0],
      /above the range/,
    );
  });

  test("shows a DCA's schedule and its first buy at the ask", () => {
    const form = newStrategyForm("dca", now, btc);
    const draft = ready({ ...form, name: "DCA" });
    const { entries, effects } = strategyEffects(draft, [btc], now);
    assert.match(
      effects.find((effect) => effect.label === "Schedule")?.detail ?? "",
      /the last at 2026-10-13 12:00 UTC/,
    );
    assert.deepEqual(
      entries.map((entry) => [
        entry.price,
        entry.quantity,
        entry.stopLoss,
        entry.takeProfit,
      ]),
      [["60000.01", "0.00041", "57000.01", "63000.02"]],
    );
  });

  test("edits from a strategy's current version, and hands its rules to the backtest", () => {
    const form = newStrategyForm("dca", now, btc);
    const draft = ready({ ...form, name: "DCA" });
    const view = {
      id: "6f7f6c2c-0d7b-4c3f-9a51-8b8f1b9a3f10",
      name: draft.name,
      status: "simulation",
      version: 2,
      createdAt: new Date(now).toISOString(),
      rules: draft.rules,
      ai: null,
      allocation: draft.allocation,
    } as StrategyView;
    assert.deepEqual(ready(strategyFormFrom(view)), draft);
    const backtest = backtestFormFor(draft);
    assert.equal(backtest.choice, "dca");
    assert.equal(backtest.dca.amountPerBuy, "25");
    assert.equal(backtest.holdingHours, "168");
    assert.equal(backtest.allocation, "225");
    const ai = ready({ ...newStrategyForm("ai_managed", now), name: "AI" });
    assert.equal(backtestFormFor(ai).choice, "recorded_proposals");
  });

  test("configures trailing stop loss and displays effects", () => {
    const dcaForm = {
      ...newStrategyForm("dca", now, btc),
      name: "Trailing DCA",
      dca: {
        ...newStrategyForm("dca", now, btc).dca,
        trailingStopPercent: "2.5",
      },
    };
    const draft = ready(dcaForm);
    assert.equal(draft.rules.kind === "dca" && draft.rules.trailingStopPercent, "2.5");
    const { effects } = strategyEffects(draft, [btc], now);
    const trailingEffect = effects.find((e) => e.label === "Trailing stop loss");
    assert.ok(trailingEffect);
    assert.equal(trailingEffect?.value, "2.5% pullback from peak");

    // Grid trailing stop
    const gridForm = {
      ...newStrategyForm("grid", now, btc),
      name: "Trailing Grid",
      grid: {
        ...newStrategyForm("grid", now, btc).grid,
        trailingStopPercent: "3",
      },
    };
    const gridDraft = ready(gridForm);
    assert.equal(gridDraft.rules.kind === "grid" && gridDraft.rules.trailingStopPercent, "3");
    const gridEffects = strategyEffects(gridDraft, [btc], now).effects;
    assert.equal(
      gridEffects.find((e) => e.label === "Trailing stop loss")?.value,
      "3% pullback from peak",
    );

    // Standing instruction trailing stop
    const standingForm: StrategyForm = {
      ...newStrategyForm("standing_price_instruction", now, btc),
      name: "Trailing Standing",
      standing: {
        entryExpiresAt: "2026-10-15T12:00",
        entries: [
          {
            quantity: "0.001",
            entryPrice: "58000",
            stopLossPrice: "55000",
            takeProfitPrice: "65000",
            trailingStopPercent: "4",
          },
        ],
      },
      allocation: "200",
    };
    const standingDraft = ready(standingForm);
    assert.equal(
      standingDraft.rules.kind === "standing_price_instruction" &&
        standingDraft.rules.entries[0]?.trailingStopPercent,
      "4",
    );
    const standingRes = strategyEffects(standingDraft, [btc], now);
    assert.ok(
      standingRes.effects.find((e) => e.label === "Trailing stop loss"),
    );
    assert.match(standingRes.entries[0]?.stopLoss ?? "", /4% trail/);
  });

  test("says how long a holding period is", () => {
    assert.equal(formatDuration(60), "1 minute");
    assert.equal(formatDuration(5400), "90 minutes");
    assert.equal(formatDuration(3600), "1 hour");
    assert.equal(formatDuration(30 * 3600), "30 hours");
    assert.equal(formatDuration(7 * 86_400), "7 days");
  });
});
