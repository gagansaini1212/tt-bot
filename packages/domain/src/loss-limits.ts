import Decimal from "decimal.js";

import type { LossLimits } from "./strategy-rules";
import type { TradeDirection } from "./trading";

/**
 * A result booked to the strategy, in the accounting currency, at the time it
 * was booked. Deposits and withdrawals are not bookings.
 *
 * - `realized`: profit, or loss as a negative amount, on quantity that
 *   closed, before fees.
 * - `fee`: a trading fee paid, as a non-negative cost.
 * - `funding`: a perpetual funding payment, negative when paid.
 */
export type PnlBooking = {
  at: string;
  kind: "realized" | "fee" | "funding";
  amount: string;
};

/** An open entry's filled quantity, valued at the current mark price. */
export type OpenEntryValuation = {
  direction: TradeDirection;
  quantity: string;
  entryPrice: string;
  markPrice: string;
};

export type LossLimitInput = {
  now: Date;
  limits: LossLimits;
  // Every booking since the strategy first traded.
  bookings: PnlBooking[];
  openEntries: OpenEntryValuation[];
  // The unrealized result, at the latest midnight UTC, of the entries open
  // then, whether or not they are still open. "0" if none were.
  dayStartUnrealizedPnl: string;
};

export type LossMeasure = {
  // Profit, or loss as a negative amount, over the period.
  pnl: string;
  loss: string;
  limit: string;
  reached: boolean;
};

export type LossLimitStatus = {
  dayStartsAt: string;
  nextDayStartsAt: string;
  daily: LossMeasure;
  total: LossMeasure;
  // Either limit reached: stop new entries, cancel pending entries, try to
  // close the strategy's open entries, and pause it until the customer acts.
  breached: boolean;
};

/** The latest midnight UTC at or before `now`, where the daily limit resets. */
export function utcDayStart(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** What an open entry would make, or lose as a negative amount, at its mark. */
export function unrealizedPnl(entry: OpenEntryValuation) {
  const move = new Decimal(entry.markPrice).minus(entry.entryPrice);
  return (entry.direction === "long" ? move : move.negated()).times(
    entry.quantity,
  );
}

function bookedPnl(booking: PnlBooking) {
  const amount = new Decimal(booking.amount);
  if (booking.kind !== "fee") return amount;
  if (amount.lessThan(0))
    throw new RangeError(
      `A fee is a non-negative cost, not ${booking.amount}.`,
    );
  return amount.negated();
}

function measure(pnl: Decimal, limit: string): LossMeasure {
  const loss = Decimal.max(pnl.negated(), 0);
  return {
    pnl: pnl.toFixed(),
    loss: loss.toFixed(),
    limit: new Decimal(limit).toFixed(),
    reached: loss.greaterThanOrEqualTo(limit),
  };
}

/**
 * Measures a strategy against its daily and total loss limits. Both count
 * realized results, fees and funding, and the unrealized results of open
 * entries. The total runs from the strategy's first trade. The daily measure
 * is the change since midnight UTC: bookings from then on, plus the change in
 * unrealized results since then. A limit is reached when the loss equals it.
 */
export function lossLimitStatus(input: LossLimitInput): LossLimitStatus {
  const dayStart = utcDayStart(input.now);
  const unrealized = input.openEntries.reduce(
    (total, entry) => total.plus(unrealizedPnl(entry)),
    new Decimal(0),
  );
  let booked = new Decimal(0);
  let bookedToday = new Decimal(0);
  for (const booking of input.bookings) {
    const at = Date.parse(booking.at);
    if (Number.isNaN(at))
      throw new RangeError(`A booking has an invalid time: ${booking.at}.`);
    const pnl = bookedPnl(booking);
    booked = booked.plus(pnl);
    if (at >= dayStart.getTime()) bookedToday = bookedToday.plus(pnl);
  }

  const daily = measure(
    bookedToday.plus(unrealized).minus(input.dayStartUnrealizedPnl),
    input.limits.daily,
  );
  const total = measure(booked.plus(unrealized), input.limits.total);
  return {
    dayStartsAt: dayStart.toISOString(),
    nextDayStartsAt: new Date(
      dayStart.getTime() + 24 * 60 * 60 * 1000,
    ).toISOString(),
    daily,
    total,
    breached: daily.reached || total.reached,
  };
}
