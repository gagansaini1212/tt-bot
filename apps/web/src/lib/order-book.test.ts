import assert from "node:assert/strict";
import { test } from "node:test";
import { orderBook } from "./order-book";

test("totals are exact running sums from the best price", () => {
  const book = orderBook({
    lastUpdateId: 1,
    bids: [
      { price: "82384.00000000", quantity: "0.10000000" },
      { price: "82383.99000000", quantity: "0.20000000" },
      { price: "82380.00000000", quantity: "38.42589000" },
    ],
    asks: [
      { price: "82384.01000000", quantity: "0.22140000" },
      { price: "82390.50000000", quantity: "1000.00000000" },
    ],
  });
  // 0.1 + 0.2 is not 0.3 in floating point.
  assert.deepEqual(book.bids, [
    { price: "82,384.00", quantity: "0.10000", total: "0.10000" },
    { price: "82,383.99", quantity: "0.20000", total: "0.30000" },
    { price: "82,380.00", quantity: "38.42589", total: "38.72589" },
  ]);
  assert.deepEqual(book.asks, [
    { price: "82,384.01", quantity: "0.22140", total: "0.22140" },
    { price: "82,390.50", quantity: "1,000.00000", total: "1,000.22140" },
  ]);
  assert.deepEqual(book.curve, {
    bids: [
      { price: 82384, total: 0.1 },
      { price: 82383.99, total: 0.3 },
      { price: 82380, total: 38.72589 },
    ],
    asks: [
      { price: 82384.01, total: 0.2214 },
      { price: 82390.5, total: 1000.2214 },
    ],
  });
  assert.deepEqual(book.spread, {
    value: "0.01",
    percent: "0.000012",
    mid: "82,384.005",
  });
  assert.equal(book.priceDigits, 2);
  assert.equal(book.quantityDigits, 5);
});

test("the spread needs both sides", () => {
  const book = orderBook({
    lastUpdateId: 1,
    bids: [{ price: "2533.87000000", quantity: "1.00000000" }],
    asks: [],
  });
  assert.equal(book.spread, null);
  assert.deepEqual(book.asks, []);
  assert.deepEqual(book.curve.asks, []);
  assert.deepEqual(orderBook({ lastUpdateId: 1, bids: [], asks: [] }), {
    bids: [],
    asks: [],
    curve: { bids: [], asks: [] },
    spread: null,
    priceDigits: 0,
    quantityDigits: 0,
  });
});
