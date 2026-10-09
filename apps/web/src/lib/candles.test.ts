import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExchangeFill,
  Kline,
  ExchangeOrder,
} from "@crypto-trading/exchanges";
import {
  candlePriceDigits,
  fillMarkers,
  orderLines,
  toCandles,
} from "./candles";

const HOUR = 3_600_000;
const start = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);

function kline(index: number, close = "60050.00000000"): Kline {
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

function fill(id: number, time: number, isBuyer: boolean): ExchangeFill {
  return {
    instrument: "BTC-USDT",
    id: String(id),
    orderId: String(id),
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

const order = (fields: Partial<ExchangeOrder>): ExchangeOrder => ({
  instrument: "BTC-USDT",
  orderId: "1",
  clientOrderId: "web_order",
  price: "59000.00000000",
  origQty: "0.00300000",
  executedQty: "0.00000000",
  cumulativeQuoteQty: "0",
  status: "NEW",
  type: "LIMIT",
  side: "BUY",
  orderListId: null,
  ...fields,
});

test("standalone orders are levels at their limit price with the unfilled quantity", () => {
  const groups = orderLines(
    {
      orders: [
        order({ orderId: "1" }),
        order({
          orderId: "2",
          side: "SELL",
          price: "61000.10000000",
          executedQty: "0.00100000",
          status: "PARTIALLY_FILLED",
        }),
        // No price and no stop: nothing to draw.
        order({ orderId: "3", side: "SELL", price: "0.00000000" }),
        order({ orderId: "4", instrument: "ETH-USDT", price: "2500.00000000" }),
      ],
      pendingOrders: [],
    },
    "BTC-USDT",
  );
  assert.deepEqual(groups, [
    {
      key: "BTC-USDT:1",
      orderListId: undefined,
      lines: [
        {
          side: "BUY",
          label: "Buy",
          price: "59000.00000000",
          stop: false,
          quantity: "0.003",
          pending: false,
        },
      ],
    },
    {
      key: "BTC-USDT:2",
      orderListId: undefined,
      lines: [
        {
          side: "SELL",
          label: "Sell",
          price: "61000.10000000",
          stop: false,
          quantity: "0.002",
          pending: false,
        },
      ],
    },
  ]);
});

test("an OPOCO list's legs stay together, with the stop loss at its trigger", () => {
  // The dashboard's protected entry: Binance holds the take profit and the
  // stop loss back, without a quantity, until the entry fills.
  const entry = order({
    orderId: "10",
    clientOrderId: "ct_abc_en",
    orderListId: "7",
    price: "81000.00000000",
    origQty: "0.00200000",
  });
  const takeProfit = order({
    orderId: "11",
    clientOrderId: "ct_abc_tp",
    orderListId: "7",
    type: "LIMIT_MAKER",
    side: "SELL",
    price: "83000.00000000",
    origQty: "0",
    status: "PENDING_NEW",
  });
  const stopLoss = order({
    orderId: "12",
    clientOrderId: "ct_abc_sl",
    orderListId: "7",
    type: "STOP_LOSS",
    side: "SELL",
    price: "0.00000000",
    stopPrice: "80000.00000000",
    origQty: "0",
    status: "PENDING_NEW",
  });
  const groups = orderLines(
    // Listed out of order, and the entry also among the held-back legs.
    { orders: [entry], pendingOrders: [stopLoss, entry, takeProfit] },
    "BTC-USDT",
  );
  assert.deepEqual(groups, [
    {
      key: "BTC-USDT:list:7",
      orderListId: "7",
      lines: [
        {
          side: "BUY",
          label: "Entry",
          price: "81000.00000000",
          stop: false,
          quantity: "0.002",
          pending: false,
        },
        {
          side: "SELL",
          label: "Take profit",
          price: "83000.00000000",
          stop: false,
          quantity: undefined,
          pending: true,
        },
        {
          side: "SELL",
          label: "Stop loss",
          price: "80000.00000000",
          stop: true,
          quantity: undefined,
          pending: true,
        },
      ],
    },
  ]);
  assert.deepEqual(
    orderLines({ orders: [entry], pendingOrders: [] }, "ETH-USDT"),
    [],
  );
});

test("legs of a list placed elsewhere get their role from the order type", () => {
  const groups = orderLines(
    {
      orders: [
        // An OCO exit: a limit-maker take profit and a stop-limit stop loss.
        order({
          orderId: "20",
          orderListId: "9",
          type: "LIMIT_MAKER",
          side: "SELL",
          price: "84000.00000000",
        }),
        order({
          orderId: "21",
          orderListId: "9",
          type: "STOP_LOSS_LIMIT",
          side: "SELL",
          price: "79500.00000000",
          stopPrice: "79600.00000000",
        }),
      ],
      pendingOrders: [],
    },
    "BTC-USDT",
  );
  assert.deepEqual(
    groups[0].lines.map(({ label, price, stop }) => [label, price, stop]),
    [
      ["Take profit", "84000.00000000", false],
      ["Stop loss", "79600.00000000", true],
    ],
  );
  // A stop price of 0 is no trigger: the limit price is used.
  assert.deepEqual(
    orderLines(
      {
        orders: [order({ stopPrice: "0.00000000" })],
        pendingOrders: [],
      },
      "BTC-USDT",
    )[0].lines[0],
    {
      side: "BUY",
      label: "Buy",
      price: "59000.00000000",
      stop: false,
      quantity: "0.003",
      pending: false,
    },
  );
});
