import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  planStandingEntries,
  standingEntryIntent,
  type StandingInstructionState,
} from "./standing-instruction";
import type { StandingPriceInstructionRules } from "./strategy-rules";

const rules: StandingPriceInstructionRules = {
  kind: "standing_price_instruction",
  instrument: "ETH-USDT",
  marketKind: "spot",
  direction: "long",
  leverage: 1,
  entries: [
    {
      quantity: "0.1",
      entryPrice: "2400",
      stopLossPrice: "2300",
      takeProfitPrice: "2600",
    },
    {
      quantity: "0.2",
      entryPrice: "2300",
      stopLossPrice: "2200",
      takeProfitPrice: "2500",
    },
    {
      quantity: "0.3",
      entryPrice: "2200",
      stopLossPrice: "2100",
      takeProfitPrice: "2400",
    },
  ],
  entryExpiresAt: "2026-10-15T00:00:00Z",
  holdingPeriodSeconds: 3 * 24 * 60 * 60,
  lossLimits: { daily: "20", total: "60" },
};

const state: StandingInstructionState = {
  now: new Date("2026-10-08T12:00:00.000Z"),
  entries: [],
  maxProtectedEntries: 5,
};

const keys = (plan: ReturnType<typeof planStandingEntries>) =>
  plan.action === "enter" ? plan.intents.map((intent) => intent.key) : plan;

describe("standingEntryIntent", () => {
  it("submits the entry exactly as the customer wrote it", () => {
    assert.deepEqual(standingEntryIntent(rules, 1), {
      key: "entry:1",
      instrument: "ETH-USDT",
      marketKind: "spot",
      direction: "long",
      leverage: 1,
      quantity: "0.2",
      entryPrice: "2300",
      stopLossPrice: "2200",
      takeProfitPrice: "2500",
      entryExpiresAt: "2026-10-15T00:00:00.000Z",
      holdingPeriodSeconds: 3 * 24 * 60 * 60,
    });
    assert.throws(() => standingEntryIntent(rules, 3), RangeError);
  });
});

describe("planStandingEntries", () => {
  it("submits every entry in order", () => {
    assert.deepEqual(keys(planStandingEntries(rules, state)), [
      "entry:0",
      "entry:1",
      "entry:2",
    ]);
  });

  it("submits only as many entries as the strategy may hold", () => {
    assert.deepEqual(
      keys(
        planStandingEntries(rules, {
          ...state,
          entries: [{ index: 0, filledQuantity: "0", closed: false }],
          maxProtectedEntries: 2,
        }),
      ),
      ["entry:1"],
    );
    assert.deepEqual(
      planStandingEntries(rules, {
        ...state,
        entries: [{ index: 0, filledQuantity: "0", closed: false }],
        maxProtectedEntries: 1,
      }),
      { action: "wait", reason: "entry_limit" },
    );
  });

  it("never submits an entry again once it filled any quantity", () => {
    assert.deepEqual(
      keys(
        planStandingEntries(rules, {
          ...state,
          entries: [
            { index: 0, filledQuantity: "0.04", closed: true },
            { index: 1, filledQuantity: "0", closed: false },
          ],
        }),
      ),
      ["entry:2"],
    );
  });

  it("submits an entry again after it closed unfilled", () => {
    assert.deepEqual(
      keys(
        planStandingEntries(rules, {
          ...state,
          entries: [
            { index: 0, filledQuantity: "0", closed: true },
            { index: 1, filledQuantity: "0", closed: false },
            { index: 2, filledQuantity: "0.3", closed: false },
          ],
        }),
      ),
      ["entry:0"],
    );
  });

  it("waits while every remaining entry is pending", () => {
    assert.deepEqual(
      planStandingEntries(rules, {
        ...state,
        entries: [
          { index: 0, filledQuantity: "0.1", closed: true },
          { index: 1, filledQuantity: "0", closed: false },
          { index: 2, filledQuantity: "0", closed: false },
        ],
      }),
      { action: "wait", reason: "entries_pending" },
    );
  });

  it("finishes when every entry has filled, or at the expiry", () => {
    assert.deepEqual(
      planStandingEntries(rules, {
        ...state,
        entries: [0, 1, 2].map((index) => ({
          index,
          filledQuantity: "0.01",
          closed: false,
        })),
      }),
      { action: "no_more_entries", reason: "all_entries_filled" },
    );
    assert.deepEqual(
      planStandingEntries(rules, {
        ...state,
        now: new Date("2026-10-15T00:00:00.000Z"),
      }),
      { action: "no_more_entries", reason: "expired" },
    );
    assert.equal(
      planStandingEntries(rules, {
        ...state,
        now: new Date("2026-10-14T23:59:59.999Z"),
      }).action,
      "enter",
    );
  });
});
