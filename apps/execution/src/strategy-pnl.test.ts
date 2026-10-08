import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  dayStartInstruments,
  measureLossLimits,
  strategyPnl,
  UnmeasurableError,
  type MeasuredEntry,
  type MeasuredFill,
} from "./strategy-pnl";

const entry: MeasuredEntry = {
  orderIntentId: "entry-1",
  instrument: "BTC-USDT",
  holding: true,
  stepSize: "0.00001",
};
// 0.01 BTC at 60,000, with Binance's 0.1% fee taken from the BTC bought.
const buy = (at: string): MeasuredFill => ({
  orderIntentId: "entry-1",
  side: "buy",
  quantity: "0.01",
  price: "60000",
  fee: "0.00001",
  feeAsset: "BTC",
  at: new Date(at),
});
const marks = (price: string) => new Map([["BTC-USDT" as const, price]]);
const none = new Map();

describe("strategy results", () => {
  test("a take profit books its gain over the buy's price, and both fees", () => {
    const pnl = strategyPnl(
      [entry],
      [
        buy("2026-10-08T10:00:00Z"),
        {
          orderIntentId: "entry-1",
          side: "sell",
          quantity: "0.00999",
          price: "61000",
          fee: "0.06",
          feeAsset: "USDT",
          at: new Date("2026-10-08T12:00:00Z"),
        },
      ],
      {
        now: new Date("2026-10-08T13:00:00Z"),
        marks: none,
        dayStartMarks: none,
      },
    );
    assert.equal(pnl.realizedPnl, "9.99");
    // 0.00001 BTC at 60,000, and 0.06 USDT.
    assert.equal(pnl.fees, "0.66");
    assert.equal(pnl.unrealizedPnl, "0");
    assert.deepEqual(pnl.openEntries, []);
    // 609.39 received less 0.06, against 600 paid.
    const status = measureLossLimits(
      pnl,
      { daily: "10", total: "20" },
      new Date("2026-10-08T13:00:00Z"),
    );
    assert.equal(status.total.pnl, "9.33");
    assert.equal(status.daily.pnl, "9.33");
    assert.equal(status.breached, false);
  });

  test("an open entry is valued at the mark, net of the fee it paid in BTC", () => {
    const pnl = strategyPnl([entry], [buy("2026-10-08T10:00:00Z")], {
      now: new Date("2026-10-08T13:00:00Z"),
      marks: marks("59000"),
      dayStartMarks: none,
    });
    assert.equal(pnl.unrealizedPnl, "-9.99");
    assert.deepEqual(pnl.openEntries, [
      {
        direction: "long",
        quantity: "0.00999",
        entryPrice: "60000",
        markPrice: "59000",
      },
    ]);
    const status = measureLossLimits(
      pnl,
      { daily: "20", total: "20" },
      new Date("2026-10-08T13:00:00Z"),
    );
    assert.equal(status.total.loss, "10.59");
  });

  test("the daily limit counts only the change since midnight UTC", () => {
    const fills = [buy("2026-10-07T22:00:00Z")];
    const now = new Date("2026-10-08T01:00:00Z");
    assert.deepEqual(
      [...dayStartInstruments([entry], fills, now)],
      ["BTC-USDT"],
    );
    const pnl = strategyPnl([entry], fills, {
      now,
      marks: marks("59000"),
      dayStartMarks: marks("59500"),
    });
    // Held 0.00999 BTC at midnight, worth -4.995 against its cost then.
    assert.equal(pnl.dayStartUnrealizedPnl, "-4.995");
    const status = measureLossLimits(pnl, { daily: "4.995", total: "20" }, now);
    // Yesterday's fall and fee are not counted again today.
    assert.equal(status.daily.pnl, "-4.995");
    assert.equal(status.daily.reached, true);
    assert.equal(status.total.loss, "10.59");
    assert.equal(status.dayStartsAt, "2026-10-08T00:00:00.000Z");
  });

  test("the last millisecond before midnight still belongs to that day", () => {
    const fills = [buy("2026-10-07T23:59:59.999Z")];
    const before = new Date("2026-10-07T23:59:59.999Z");
    assert.deepEqual([...dayStartInstruments([entry], fills, before)], []);
    const pnl = strategyPnl([entry], fills, {
      now: before,
      marks: marks("59000"),
      dayStartMarks: none,
    });
    // The fee and the fall both count on the 7th.
    const status = measureLossLimits(
      pnl,
      { daily: "10.59", total: "20" },
      before,
    );
    assert.equal(status.daily.loss, "10.59");
    assert.equal(status.daily.reached, true);
    // At midnight the day starts again from the entry's value then.
    const after = new Date("2026-10-08T00:00:00.000Z");
    assert.deepEqual(
      [...dayStartInstruments([entry], fills, after)],
      ["BTC-USDT"],
    );
    const next = measureLossLimits(
      strategyPnl([entry], fills, {
        now: after,
        marks: marks("59000"),
        dayStartMarks: marks("59000"),
      }),
      { daily: "10.59", total: "20" },
      after,
    );
    assert.equal(next.daily.loss, "0");
    assert.equal(next.daily.reached, false);
    assert.equal(next.total.loss, "10.59");
  });

  test("less than one lot step left after an exit is not valued", () => {
    const pnl = strategyPnl(
      [entry],
      [
        buy("2026-10-08T10:00:00Z"),
        {
          orderIntentId: "entry-1",
          side: "sell",
          quantity: "0.009985",
          price: "61000",
          fee: "0",
          feeAsset: "USDT",
          at: new Date("2026-10-08T12:00:00Z"),
        },
      ],
      {
        now: new Date("2026-10-08T13:00:00Z"),
        marks: none,
        dayStartMarks: none,
      },
    );
    // The 0.00001 BTC fee and 0.009985 sold leave half a step.
    assert.equal(pnl.unrealizedPnl, "0");
    assert.equal(pnl.openEntries.length, 0);
  });

  test("an entry handed over to the customer is no longer valued", () => {
    const pnl = strategyPnl(
      [{ ...entry, holding: false }],
      [buy("2026-10-08T10:00:00Z")],
      {
        now: new Date("2026-10-08T13:00:00Z"),
        marks: none,
        dayStartMarks: none,
      },
    );
    assert.equal(pnl.unrealizedPnl, "0");
    assert.equal(pnl.fees, "0.6");
  });

  test("a fee in another asset, or a missing price, cannot be measured", () => {
    assert.throws(
      () =>
        strategyPnl(
          [entry],
          [{ ...buy("2026-10-08T10:00:00Z"), feeAsset: "BNB" }],
          {
            now: new Date("2026-10-08T13:00:00Z"),
            marks: marks("60000"),
            dayStartMarks: none,
          },
        ),
      UnmeasurableError,
    );
    assert.throws(
      () =>
        strategyPnl([entry], [buy("2026-10-08T10:00:00Z")], {
          now: new Date("2026-10-08T13:00:00Z"),
          marks: none,
          dayStartMarks: none,
        }),
      UnmeasurableError,
    );
  });
});
