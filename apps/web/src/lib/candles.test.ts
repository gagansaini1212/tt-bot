import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  TestnetFill,
  TestnetKline,
  TestnetOrder,
} from "@crypto-trading/exchanges";
import {
  candlePriceDigits,
  fillMarkers,
  orderLines,
  toCandles,
} from "./candles";

const HOUR = 3_600_000;
const start = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);

function kline(index: number, close = "60050.00000000"): TestnetKline {
  return {
    openTime: start + index * HOUR,
    open: "60000.00000000",
    high: "60100.50000000",
    low: "59900.00000000",
    close,
    volume: "1.50000000",
    closeTime: start + (index + 1) * HOUR - 1,
    quoteVolume: "90000.00000000",
    trades: 12,
  };
}
const klines = [kline(0), kline(1), kline(2)];

function fill(id: number, time: number, isBuyer: boolean): TestnetFill {
  return {
    symbol: "BTCUSDT",
    id,
    orderId: id,
    price: "60000.00000000",
    qty: "0.00100000",
    quoteQty: "60.00000000",
    commission: "0",
    commissionAsset: "BNB",
    time,
    isBuyer,
  };
}

test("candles are timed in UTC seconds and priced as numbers", () => {
  assert.deepEqual(toCandles([kline(0, "60050.25000000")]), [
    {
      time: start / 1000,
      open: 60000,
      high: 60100.5,
      low: 59900,
      close: 60050.25,
    },
  ]);
  assert.equal(candlePriceDigits(klines), 1);
  assert.equal(candlePriceDigits([kline(0, "60050.01000000")]), 2);
  assert.equal(candlePriceDigits([]), 0);
});

test("fills are grouped by candle and side", () => {
  const { markers, outside } = fillMarkers(
    [
      fill(1, start + 2 * HOUR + 5, false),
      fill(2, start + 10, true),
      fill(3, start + HOUR - 1, true),
      fill(4, start + 2 * HOUR, true),
      fill(5, start + 2 * HOUR + 7, false),
    ],
    klines,
  );
  assert.deepEqual(markers, [
    { time: start / 1000, side: "BUY", count: 2 },
    { time: (start + 2 * HOUR) / 1000, side: "BUY", count: 1 },
    { time: (start + 2 * HOUR) / 1000, side: "SELL", count: 2 },
  ]);
  assert.equal(outside, 0);
});

test("fills outside the candles are counted, not drawn", () => {
  const { markers, outside } = fillMarkers(
    [
      fill(1, start - 1, true),
      fill(2, start + 3 * HOUR, false),
      fill(3, start + HOUR, true),
    ],
    klines,
  );
  assert.deepEqual(markers, [
    { time: (start + HOUR) / 1000, side: "BUY", count: 1 },
  ]);
  assert.equal(outside, 2);
  assert.deepEqual(fillMarkers([fill(1, start, true)], []), {
    markers: [],
    outside: 1,
  });
});

test("open orders become levels with their unfilled quantity", () => {
  const order = (
    orderId: number,
    side: "BUY" | "SELL",
    price: string,
    executedQty: string,
  ): TestnetOrder => ({
    symbol: "BTCUSDT",
    orderId,
    clientOrderId: `ct_${orderId}`,
    price,
    origQty: "0.00300000",
    executedQty,
    cummulativeQuoteQty: "0",
    status: "NEW",
    type: "LIMIT",
    side,
  });
  assert.deepEqual(
    orderLines([
      order(1, "BUY", "59000.00000000", "0.00000000"),
      order(2, "SELL", "61000.10000000", "0.00100000"),
      order(3, "SELL", "0.00000000", "0.00000000"),
    ]),
    [
      { orderId: 1, side: "BUY", price: "59000.00000000", quantity: "0.003" },
      { orderId: 2, side: "SELL", price: "61000.10000000", quantity: "0.002" },
    ],
  );
});
