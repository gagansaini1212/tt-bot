import Decimal from "decimal.js";
import { z } from "zod";

import { positiveDecimalString } from "@crypto-trading/domain";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * One closed hourly candle: the first, highest, lowest and last traded price
 * in the hour from `openTime`, in milliseconds since the epoch, UTC.
 */
export const candleSchema = z
  .strictObject({
    openTime: z.int().nonnegative(),
    open: positiveDecimalString,
    high: positiveDecimalString,
    low: positiveDecimalString,
    close: positiveDecimalString,
  })
  .refine(
    (candle) =>
      candle.openTime % HOUR_MS === 0 &&
      new Decimal(candle.low).lessThanOrEqualTo(
        Decimal.min(candle.open, candle.close),
      ) &&
      new Decimal(candle.high).greaterThanOrEqualTo(
        Decimal.max(candle.open, candle.close),
      ),
    "A candle opens on the hour, and its low and high bound its open and close.",
  );

export type Candle = z.infer<typeof candleSchema>;

/** Hourly candles, oldest first, each opening after the one before. */
export const candleSeriesSchema = z
  .array(candleSchema)
  .min(1)
  .refine(
    (candles) =>
      candles.every(
        (candle, index) =>
          index === 0 || candle.openTime > candles[index - 1].openTime,
      ),
    "Candles must be in time order, without repeats.",
  );

/** The open times of the hours missing between the first and last candle. */
export function missingHours(candles: readonly Candle[]): number[] {
  const missing: number[] = [];
  for (let index = 1; index < candles.length; index++)
    for (
      let time = candles[index - 1].openTime + HOUR_MS;
      time < candles[index].openTime;
      time += HOUR_MS
    )
      missing.push(time);
  return missing;
}
