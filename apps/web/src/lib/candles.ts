import type { Instrument } from "@crypto-trading/domain";
import Decimal from "decimal.js";
import type {
  ExchangeFill,
  Kline,
  ExchangeOrder,
  AccountSnapshot,
} from "@crypto-trading/exchanges";

import { fractionDigits } from "./decimals";
import { groupOpenOrders, orderRole, type OrderRole } from "./order-display";

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

/** An open order's level on the chart. */
export type OrderLine = {
  side: ExchangeOrder["side"];
  /** The leg's role, as the Open orders table badges it, or the side of a standalone order. */
  label: OrderRole | "Buy" | "Sell";
  /** Where the order acts: a stop order's trigger, otherwise its limit price. */
  price: string;
  stop: boolean;
  /** Unfilled quantity; undefined while Binance holds an exit back until its entry fills. */
  quantity?: string;
  /** An exit Binance places once its list's entry fills. */
  pending: boolean;
};

/** A standalone order, or one order list's legs: entry, take profit, stop loss. */
export type OrderLineGroup = {
  /** Unique per group, from groupOpenOrders. */
  key: string;
  orderListId?: string;
  lines: OrderLine[];
};

export function toCandles(klines: readonly Kline[]): Candle[] {
  return klines.map((kline) => ({
    time: Math.floor(kline.openTime / 1000),
    open: Number(kline.open),
    high: Number(kline.high),
    low: Number(kline.low),
    close: Number(kline.close),
  }));
}

/** Decimal places the candles' prices use, such as 2 for "82384.01000000". */
export function candlePriceDigits(klines: readonly Kline[]): number {
  return fractionDigits(
    klines.flatMap(({ open, high, low, close }) => [open, high, low, close]),
  );
}

// Klines are oldest first and do not overlap.
function candleAt(klines: readonly Kline[], time: number) {
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
  fills: readonly ExchangeFill[],
  klines: readonly Kline[],
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

/**
 * One market's open orders, grouped like the Open orders table, including the
 * exits Binance holds back until their entry fills. Orders with neither a
 * stop nor a limit price are left out.
 */
export function orderLines(
  snapshot: Pick<AccountSnapshot, "orders" | "pendingOrders">,
  instrument: Instrument,
): OrderLineGroup[] {
  return groupOpenOrders(snapshot)
    .filter(({ orders }) => orders[0]?.instrument === instrument)
    .map(({ key, orderListId, orders }) => ({
      key,
      orderListId,
      lines: orders.flatMap((order) => orderLine(order) ?? []),
    }))
    .filter(({ lines }) => lines.length > 0);
}

function orderLine(order: ExchangeOrder): OrderLine | undefined {
  // A stop-market order's price is 0; it acts at its stopPrice.
  const stop =
    order.stopPrice !== undefined && new Decimal(order.stopPrice).gt(0);
  const price = stop ? order.stopPrice! : order.price;
  if (!new Decimal(price).gt(0)) return undefined;
  const unfilled = new Decimal(order.origQty).minus(order.executedQty);
  return {
    side: order.side,
    label: orderRole(order) ?? (order.side === "BUY" ? "Buy" : "Sell"),
    price,
    stop,
    quantity: unfilled.gt(0) ? unfilled.toFixed() : undefined,
    pending: order.status === "PENDING_NEW",
  };
}
