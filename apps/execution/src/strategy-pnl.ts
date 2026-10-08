// Books a strategy's fills as the domain's loss-limit inputs. Pure, so every
// case is tested without an exchange or a database.
import Decimal from "decimal.js";
import {
  lossLimitStatus,
  unrealizedPnl,
  utcDayStart,
  type LossLimits,
  type LossLimitStatus,
  type OpenEntryValuation,
  type PnlBooking,
} from "@crypto-trading/domain";
import type { TestnetInstrument } from "@crypto-trading/exchanges";

/** One of a strategy's protected entries. */
export type MeasuredEntry = {
  orderIntentId: string;
  instrument: TestnetInstrument;
  // Whether the strategy still holds what the entry bought. An entry handed
  // over to the customer, or that Binance no longer knows, holds nothing
  // the strategy answers for.
  holding: boolean;
  // Binance's lot step. Less than one step cannot be sold or protected, so
  // the entry counts as holding nothing, as the execution loop counts it.
  stepSize: string;
};

/**
 * A fill of an entry's own order (a buy) or of one of its exits, a take
 * profit, a stop loss or a market sell by the worker (a sell).
 */
export type MeasuredFill = {
  orderIntentId: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string;
  at: Date;
};

export type StrategyPnl = {
  bookings: PnlBooking[];
  openEntries: OpenEntryValuation[];
  dayStartUnrealizedPnl: string;
  // Before fees.
  realizedPnl: string;
  fees: string;
  unrealizedPnl: string;
};

/** The strategy's results cannot be measured, so it opens no entries. */
export class UnmeasurableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnmeasurableError";
  }
}

/** BTC-USDT → ["BTC", "USDT"] */
function assets(instrument: TestnetInstrument) {
  const [base, quote] = instrument.split("-");
  return { base, quote };
}

/**
 * A strategy's results in the quote currency, from its fills. Each entry's
 * buys set its cost: their average price. Each sell books its quantity times
 * the gap between its price and that cost, at the sell's time. Fees are
 * costs at their fill's time: Binance takes a buy's fee from the asset
 * bought, worth its quantity at the fill price, which the entry then no
 * longer holds. What an entry still holds is valued at `marks`, and, for the
 * daily limit, at `dayStartMarks` for what it held at the latest midnight
 * UTC.
 *
 * Throws UnmeasurableError on a fee in an asset other than the pair's, or a
 * missing price, rather than guess.
 */
export function strategyPnl(
  entries: MeasuredEntry[],
  fills: MeasuredFill[],
  {
    now,
    marks,
    dayStartMarks,
  }: {
    now: Date;
    marks: ReadonlyMap<TestnetInstrument, string>;
    dayStartMarks: ReadonlyMap<TestnetInstrument, string>;
  },
): StrategyPnl {
  const dayStart = utcDayStart(now).getTime();
  const bookings: PnlBooking[] = [];
  const openEntries: OpenEntryValuation[] = [];
  let realized = new Decimal(0);
  let fees = new Decimal(0);
  let unrealized = new Decimal(0);
  let dayStartUnrealized = new Decimal(0);
  for (const entry of entries) {
    const { base, quote } = assets(entry.instrument);
    const own = fills
      .filter((fill) => fill.orderIntentId === entry.orderIntentId)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const buys = own.filter((fill) => fill.side === "buy");
    if (!buys.length) continue;
    const bought = buys.reduce(
      (total, fill) => total.plus(fill.quantity),
      new Decimal(0),
    );
    const cost = buys
      .reduce(
        (total, fill) =>
          total.plus(new Decimal(fill.quantity).times(fill.price)),
        new Decimal(0),
      )
      .dividedBy(bought);
    // What the entry held after each fill, and at the latest midnight.
    let held = new Decimal(0);
    let heldAtDayStart = new Decimal(0);
    for (const fill of own) {
      const at = fill.at.toISOString();
      const fee = new Decimal(fill.fee);
      let feeCost = new Decimal(0);
      let feeInBase = new Decimal(0);
      if (fee.gt(0)) {
        if (fill.feeAsset === quote) feeCost = fee;
        else if (fill.feeAsset === base) {
          feeCost = fee.times(fill.price);
          feeInBase = fee;
        } else
          throw new UnmeasurableError(
            `Binance charged a fee in ${fill.feeAsset}, which the worker cannot value in ${quote}.`,
          );
      }
      if (fill.side === "buy") held = held.plus(fill.quantity);
      else {
        held = held.minus(fill.quantity);
        const result = new Decimal(fill.quantity).times(
          new Decimal(fill.price).minus(cost),
        );
        realized = realized.plus(result);
        bookings.push({ at, kind: "realized", amount: result.toFixed() });
      }
      held = held.minus(feeInBase);
      if (feeCost.gt(0)) {
        fees = fees.plus(feeCost);
        bookings.push({ at, kind: "fee", amount: feeCost.toFixed() });
      }
      if (fill.at.getTime() < dayStart) heldAtDayStart = held;
    }
    if (held.lt(entry.stepSize)) held = new Decimal(0);
    if (heldAtDayStart.lt(entry.stepSize)) heldAtDayStart = new Decimal(0);
    if (entry.holding && held.gt(0)) {
      const mark = marks.get(entry.instrument);
      if (!mark)
        throw new UnmeasurableError(
          `There is no current price for ${entry.instrument.replace("-", "/")}.`,
        );
      const open: OpenEntryValuation = {
        direction: "long",
        quantity: held.toFixed(),
        entryPrice: cost.toFixed(),
        markPrice: mark,
      };
      openEntries.push(open);
      unrealized = unrealized.plus(unrealizedPnl(open));
    }
    if (heldAtDayStart.gt(0)) {
      const mark = dayStartMarks.get(entry.instrument);
      if (!mark)
        throw new UnmeasurableError(
          `There is no ${entry.instrument.replace("-", "/")} price for midnight UTC.`,
        );
      dayStartUnrealized = dayStartUnrealized.plus(
        unrealizedPnl({
          direction: "long",
          quantity: heldAtDayStart.toFixed(),
          entryPrice: cost.toFixed(),
          markPrice: mark,
        }),
      );
    }
  }
  return {
    bookings,
    openEntries,
    dayStartUnrealizedPnl: dayStartUnrealized.toFixed(),
    realizedPnl: realized.toFixed(),
    fees: fees.toFixed(),
    unrealizedPnl: unrealized.toFixed(),
  };
}

/**
 * Instruments whose price at the latest midnight UTC the daily limit needs:
 * those of entries that held quantity then.
 */
export function dayStartInstruments(
  entries: MeasuredEntry[],
  fills: MeasuredFill[],
  now: Date,
): Set<TestnetInstrument> {
  const dayStart = utcDayStart(now).getTime();
  const needed = new Set<TestnetInstrument>();
  for (const entry of entries) {
    const held = fills
      .filter(
        (fill) =>
          fill.orderIntentId === entry.orderIntentId &&
          fill.at.getTime() < dayStart,
      )
      .reduce((total, fill) => {
        const quantity = new Decimal(fill.quantity);
        const fee =
          fill.feeAsset === assets(entry.instrument).base
            ? new Decimal(fill.fee)
            : new Decimal(0);
        return (
          fill.side === "buy" ? total.plus(quantity) : total.minus(quantity)
        ).minus(fee);
      }, new Decimal(0));
    if (held.gte(entry.stepSize)) needed.add(entry.instrument);
  }
  return needed;
}

/** The strategy's loss limits, measured from its results. */
export function measureLossLimits(
  pnl: StrategyPnl,
  limits: LossLimits,
  now: Date,
): LossLimitStatus {
  return lossLimitStatus({
    now,
    limits,
    bookings: pnl.bookings,
    openEntries: pnl.openEntries,
    dayStartUnrealizedPnl: pnl.dayStartUnrealizedPnl,
  });
}
