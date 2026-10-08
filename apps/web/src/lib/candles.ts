import Decimal from "decimal.js";
import type {
  TestnetFill,
  TestnetKline,
  TestnetOrder,
} from "@crypto-trading/exchanges";

import { fractionDigits } from "./decimals";

/** A candle as the chart draws it, timed by its open in UTC seconds. */
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** The customer's fills of one side within one candle. */
export type FillMarker = { time: number; side: "BUY" | "SELL"; count: number };

/** An open order's price level and unfilled quantity. */
export type OrderLine = {
  orderId: number;
  side: "BUY" | "SELL";
  price: string;
  quantity: string;
};

export function toCandles(klines: readonly TestnetKline[]): Candle[] {
  return klines.map((kline) => ({
    time: Math.floor(kline.openTime / 1000),
    open: Number(kline.open),
    high: Number(kline.high),
    low: Number(kline.low),
    close: Number(kline.close),
  }));
}

/** Decimal places the candles' prices use, such as 2 for "82384.01000000". */
export function candlePriceDigits(klines: readonly TestnetKline[]): number {
  return fractionDigits(
    klines.flatMap(({ open, high, low, close }) => [open, high, low, close]),
  );
}

// Klines are oldest first and do not overlap.
function candleAt(klines: readonly TestnetKline[], time: number) {
  let low = 0;
  let high = klines.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const kline = klines[middle];
    if (time < kline.openTime) high = middle - 1;
    else if (time > kline.closeTime) low = middle + 1;
    else return kline;
  }
  return undefined;
}

/**
 * Groups one market's fills by the candle they happened in and by side, so a
 * busy candle gets one buy and one sell marker. Fills outside the candles'
 * time range are counted in `outside`.
 */
export function fillMarkers(
  fills: readonly TestnetFill[],
  klines: readonly TestnetKline[],
): { markers: FillMarker[]; outside: number } {
  const groups = new Map<string, FillMarker>();
  let outside = 0;
  for (const fill of fills) {
    const kline = candleAt(klines, fill.time);
    if (!kline) {
      outside += 1;
      continue;
    }
    const side = fill.isBuyer ? "BUY" : "SELL";
    const key = `${kline.openTime} ${side}`;
    const marker = groups.get(key);
    if (marker) marker.count += 1;
    else
      groups.set(key, {
        time: Math.floor(kline.openTime / 1000),
        side,
        count: 1,
      });
  }
  const markers = [...groups.values()].sort(
    (a, b) => a.time - b.time || a.side.localeCompare(b.side),
  );
  return { markers, outside };
}

/** One market's open orders as price levels; orders without a price are left out. */
export function orderLines(orders: readonly TestnetOrder[]): OrderLine[] {
  return orders
    .filter(({ price }) => new Decimal(price).gt(0))
    .map(({ orderId, side, price, origQty, executedQty }) => ({
      orderId,
      side,
      price,
      quantity: new Decimal(origQty).minus(executedQty).toFixed(),
    }));
}
