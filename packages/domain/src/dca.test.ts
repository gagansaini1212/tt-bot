import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dcaBuyAmount,
  dcaBuyDueAt,
  dcaBuyIndexAt,
  planDcaBuy,
  type DcaState,
} from "./dca";
import type { DcaRules } from "./strategy-rules";

const rules: DcaRules = {
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
  lossLimits: { daily: "50", total: "150" },
};

const state: DcaState = {
  now: new Date("2026-10-03T10:00:00.000Z"),
  price: "60000",
  steps: { tickSize: "0.01", quantityStep: "0.00001" },
  previousBuy: { index: 1, entryPrice: "61000" },
  protectedEntries: 1,
  maxProtectedEntries: 5,
};

describe("DCA schedule", () => {
  it("is due every interval from the start", () => {
    assert.equal(
      dcaBuyDueAt(rules, 0).toISOString(),
      "2026-10-01T09:00:00.000Z",
    );
    assert.equal(
      dcaBuyDueAt(rules, 9).toISOString(),
      "2026-10-10T09:00:00.000Z",
    );
    assert.equal(
      dcaBuyDueAt({ ...rules, interval: "4h" }, 3).toISOString(),
      "2026-10-01T21:00:00.000Z",
    );
  });

  it("finds the buy due at a time, at its boundaries", () => {
    assert.equal(
      dcaBuyIndexAt(rules, new Date("2026-10-01T08:59:59.999Z")),
      -1,
    );
    assert.equal(dcaBuyIndexAt(rules, new Date("2026-10-01T09:00:00.000Z")), 0);
    assert.equal(dcaBuyIndexAt(rules, new Date("2026-10-02T08:59:59.999Z")), 0);
    assert.equal(dcaBuyIndexAt(rules, new Date("2026-10-02T09:00:00.000Z")), 1);
  });
});

describe("dcaBuyAmount", () => {
  it("multiplies the buy at or past the dip threshold", () => {
    // 5% below 61000 is 57950.
    assert.deepEqual(dcaBuyAmount(rules, "57950", { entryPrice: "61000" }), {
      amount: "37.5",
      dip: true,
    });
    assert.deepEqual(dcaBuyAmount(rules, "57950.01", { entryPrice: "61000" }), {
      amount: "25",
      dip: false,
    });
  });

  it("never multiplies the first buy or a DCA without a dip rule", () => {
    assert.equal(dcaBuyAmount(rules, "1").amount, "25");
    assert.equal(
      dcaBuyAmount({ ...rules, dip: undefined }, "1", { entryPrice: "61000" })
        .amount,
      "25",
    );
  });

  it("does not compound after a dip buy", () => {
    // The previous buy was itself a dip buy; the next is still at most 1.5×.
    assert.equal(
      dcaBuyAmount(rules, "50000", { entryPrice: "55000" }).amount,
      "37.5",
    );
  });
});

describe("planDcaBuy", () => {
  it("buys the due amount at the best ask, protected from its entry price", () => {
    assert.deepEqual(planDcaBuy(rules, state), {
      action: "enter",
      intents: [
        {
          key: "buy:2",
          instrument: "BTC-USDT",
          marketKind: "spot",
          direction: "long",
          leverage: 1,
          // 25 / 60000, floored to the step.
          quantity: "0.00041",
          entryPrice: "60000",
          stopLossPrice: "54000",
          takeProfitPrice: "72000",
          entryExpiresAt: "2026-10-04T09:00:00.000Z",
          holdingPeriodSeconds: 30 * 24 * 60 * 60,
        },
      ],
    });
  });

  it("rounds the stop up and the target up to the tick", () => {
    const plan = planDcaBuy(
      { ...rules, stopLossPercent: "3.33", takeProfitPercent: "7.77" },
      { ...state, price: "60000.01" },
    );

    assert.equal(plan.action, "enter");
    if (plan.action === "enter") {
      // 60000.01 × 0.9667 = 58002.009667
      assert.equal(plan.intents[0].stopLossPrice, "58002.01");
      // 60000.01 × 1.0777 = 64662.010777
      assert.equal(plan.intents[0].takeProfitPrice, "64662.02");
    }
  });

  it("spends the multiplied amount on a dip", () => {
    const plan = planDcaBuy(rules, { ...state, price: "57950" });

    assert.equal(plan.action, "enter");
    // 37.5 / 57950, floored to the step.
    if (plan.action === "enter")
      assert.equal(plan.intents[0].quantity, "0.00064");
  });

  it("rejects a zero price instead of buying infinitely much", () => {
    assert.throws(
      () => planDcaBuy(rules, { ...state, price: "0" }),
      RangeError,
    );
  });

  it("waits for the first buy", () => {
    assert.deepEqual(
      planDcaBuy(rules, {
        ...state,
        now: new Date("2026-09-30T00:00:00.000Z"),
        previousBuy: undefined,
        protectedEntries: 0,
      }),
      { action: "wait", reason: "not_started", until: rules.startsAt },
    );
  });

  it("buys once per due buy and waits for the next", () => {
    assert.deepEqual(
      planDcaBuy(rules, {
        ...state,
        previousBuy: { index: 2, entryPrice: "60000" },
      }),
      { action: "wait", reason: "buy_made", until: "2026-10-04T09:00:00.000Z" },
    );
  });

  it("skips a buy the strategy cannot protect, without making it up later", () => {
    assert.deepEqual(planDcaBuy(rules, { ...state, protectedEntries: 5 }), {
      action: "wait",
      reason: "entry_limit",
      until: "2026-10-04T09:00:00.000Z",
    });
    // Two buys later, only the buy due then is made.
    const later = planDcaBuy(rules, {
      ...state,
      now: new Date("2026-10-05T09:00:00.000Z"),
    });
    assert.equal(later.action, "enter");
    if (later.action === "enter") assert.equal(later.intents[0].key, "buy:4");
  });

  it("makes the last buy and then finishes", () => {
    const last = { ...state, now: new Date("2026-10-10T09:00:00.000Z") };
    const plan = planDcaBuy(rules, last);

    assert.equal(plan.action, "enter");
    if (plan.action === "enter") {
      assert.equal(plan.intents[0].key, "buy:9");
      assert.equal(plan.intents[0].entryExpiresAt, "2026-10-11T09:00:00.000Z");
    }
    assert.deepEqual(
      planDcaBuy(rules, {
        ...last,
        previousBuy: { index: 9, entryPrice: "60000" },
      }),
      { action: "no_more_entries", reason: "schedule_complete" },
    );
    assert.deepEqual(
      planDcaBuy(rules, { ...last, now: new Date("2026-10-11T09:00:00.000Z") }),
      { action: "no_more_entries", reason: "schedule_complete" },
    );
  });

  it("waits rather than submit a stop that rounds onto the entry", () => {
    assert.deepEqual(
      planDcaBuy(
        { ...rules, stopLossPercent: "0.1" },
        {
          ...state,
          price: "100",
          steps: { tickSize: "1", quantityStep: "0.01" },
        },
      ),
      {
        action: "wait",
        reason: "unprotectable",
        until: "2026-10-04T09:00:00.000Z",
      },
    );
  });

  it("waits when the amount buys less than one step", () => {
    assert.deepEqual(
      planDcaBuy({ ...rules, amountPerBuy: "0.5", dip: undefined }, state),
      {
        action: "wait",
        reason: "unprotectable",
        until: "2026-10-04T09:00:00.000Z",
      },
    );
  });
});
