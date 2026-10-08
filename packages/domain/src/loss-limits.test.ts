import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  lossLimitStatus,
  unrealizedPnl,
  utcDayStart,
  type LossLimitInput,
} from "./loss-limits";

const input: LossLimitInput = {
  now: new Date("2026-10-08T15:30:00.000Z"),
  limits: { daily: "50", total: "150" },
  bookings: [],
  openEntries: [],
  dayStartUnrealizedPnl: "0",
};

describe("utcDayStart", () => {
  it("resets at midnight UTC", () => {
    assert.equal(
      utcDayStart(new Date("2026-10-08T23:59:59.999Z")).toISOString(),
      "2026-10-08T00:00:00.000Z",
    );
    assert.equal(
      utcDayStart(new Date("2026-10-09T00:00:00.000Z")).toISOString(),
      "2026-10-09T00:00:00.000Z",
    );
  });
});

describe("unrealizedPnl", () => {
  it("values longs and shorts at the mark", () => {
    const entry = { quantity: "0.5", entryPrice: "2000", markPrice: "1900" };
    assert.equal(
      unrealizedPnl({ ...entry, direction: "long" }).toFixed(),
      "-50",
    );
    assert.equal(
      unrealizedPnl({ ...entry, direction: "short" }).toFixed(),
      "50",
    );
  });
});

describe("lossLimitStatus", () => {
  it("is within both limits with no trading", () => {
    assert.deepEqual(lossLimitStatus(input), {
      dayStartsAt: "2026-10-08T00:00:00.000Z",
      nextDayStartsAt: "2026-10-09T00:00:00.000Z",
      daily: { pnl: "0", loss: "0", limit: "50", reached: false },
      total: { pnl: "0", loss: "0", limit: "150", reached: false },
      breached: false,
    });
  });

  it("counts realized results, fees, funding and unrealized results", () => {
    const status = lossLimitStatus({
      ...input,
      bookings: [
        { at: "2026-10-08T01:00:00.000Z", kind: "realized", amount: "-20" },
        { at: "2026-10-08T01:00:00.000Z", kind: "fee", amount: "0.6" },
        { at: "2026-10-08T08:00:00.000Z", kind: "funding", amount: "-1.4" },
        { at: "2026-10-08T09:00:00.000Z", kind: "realized", amount: "12" },
      ],
      openEntries: [
        {
          direction: "long",
          quantity: "0.001",
          entryPrice: "60000",
          markPrice: "59000",
        },
      ],
    });

    // -20 - 0.6 - 1.4 + 12 - 1
    assert.equal(status.daily.pnl, "-11");
    assert.equal(status.daily.loss, "11");
    assert.equal(status.total.pnl, "-11");
    assert.equal(status.breached, false);
  });

  it("is reached when the loss equals the limit", () => {
    const at = (amount: string) =>
      lossLimitStatus({
        ...input,
        bookings: [
          { at: "2026-10-08T10:00:00.000Z", kind: "realized", amount },
        ],
      });

    assert.equal(at("-49.99").daily.reached, false);
    assert.equal(at("-50").daily.reached, true);
    assert.equal(at("-50").breached, true);
    assert.equal(at("-50").total.reached, false);
  });

  it("counts only today's bookings towards the daily limit", () => {
    const status = lossLimitStatus({
      ...input,
      bookings: [
        { at: "2026-10-07T23:59:59.999Z", kind: "realized", amount: "-100" },
        { at: "2026-10-08T00:00:00.000Z", kind: "realized", amount: "-10" },
      ],
    });

    assert.equal(status.daily.pnl, "-10");
    assert.equal(status.total.pnl, "-110");
    assert.equal(status.breached, false);
  });

  it("does not count yesterday's unrealized loss again today", () => {
    // Open since yesterday at 60000; the mark was 58000 at midnight and is
    // 57000 now. Today's move is -1000 × 0.01.
    const status = lossLimitStatus({
      ...input,
      openEntries: [
        {
          direction: "long",
          quantity: "0.01",
          entryPrice: "60000",
          markPrice: "57000",
        },
      ],
      dayStartUnrealizedPnl: "-20",
    });

    assert.equal(status.daily.pnl, "-10");
    assert.equal(status.total.pnl, "-30");
  });

  it("counts today's part of an entry that was open at midnight and closed today", () => {
    // Bought at 60000, 58000 at midnight, sold at 57000 today.
    const status = lossLimitStatus({
      ...input,
      bookings: [
        { at: "2026-10-08T10:00:00.000Z", kind: "realized", amount: "-30" },
      ],
      dayStartUnrealizedPnl: "-20",
    });

    assert.equal(status.daily.pnl, "-10");
  });

  it("counts giving back a gain held at midnight as a daily loss", () => {
    const status = lossLimitStatus({
      ...input,
      openEntries: [
        {
          direction: "long",
          quantity: "0.01",
          entryPrice: "60000",
          markPrice: "60000",
        },
      ],
      dayStartUnrealizedPnl: "60",
    });

    assert.equal(status.daily.loss, "60");
    assert.equal(status.daily.reached, true);
    assert.equal(status.total.loss, "0");
  });

  it("reaches the total limit across days", () => {
    const status = lossLimitStatus({
      ...input,
      bookings: [
        { at: "2026-10-06T10:00:00.000Z", kind: "realized", amount: "-80" },
        { at: "2026-10-07T10:00:00.000Z", kind: "realized", amount: "-60" },
        { at: "2026-10-08T10:00:00.000Z", kind: "fee", amount: "10" },
      ],
    });

    assert.equal(status.daily.reached, false);
    assert.equal(status.total.loss, "150");
    assert.equal(status.total.reached, true);
    assert.equal(status.breached, true);
  });

  it("rejects a negative fee and an invalid booking time", () => {
    assert.throws(
      () =>
        lossLimitStatus({
          ...input,
          bookings: [
            { at: input.now.toISOString(), kind: "fee", amount: "-1" },
          ],
        }),
      RangeError,
    );
    assert.throws(
      () =>
        lossLimitStatus({
          ...input,
          bookings: [{ at: "yesterday", kind: "realized", amount: "-1" }],
        }),
      RangeError,
    );
  });
});
