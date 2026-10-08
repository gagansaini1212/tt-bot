import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestnetOrder } from "@crypto-trading/exchanges";
import {
  groupOpenOrders,
  newListClientOrderId,
  orderListSummary,
  orderPriceLabel,
  orderQuantityLabel,
  orderRole,
  orderStatusLabel,
  quantityForShare,
} from "./order-display";
import { listClientOrderIdSchema } from "@crypto-trading/exchanges/order-rules";

const order = (fields: Partial<TestnetOrder>): TestnetOrder => ({
  symbol: "BTCUSDT",
  orderId: 1,
  clientOrderId: "web_order",
  price: "60000.00000000",
  origQty: "0.00100000",
  executedQty: "0.00000000",
  cummulativeQuoteQty: "0",
  status: "NEW",
  type: "LIMIT",
  side: "BUY",
  orderListId: -1,
  ...fields,
});

test("each order gets a fresh ct_ list ID that Binance accepts", () => {
  const ids = new Set(Array.from({ length: 50 }, newListClientOrderId));
  assert.equal(ids.size, 50);
  for (const id of ids)
    assert.ok(listClientOrderIdSchema.safeParse(id).success, id);
});

test("percentage buttons spend a share of free USDT, rounded down to the lot step", () => {
  assert.equal(quantityForShare("1000", 0.25, "60000", "0.00001"), "0.00416");
  assert.equal(quantityForShare("1000", 1, "60000", "0.00001"), "0.01666");
  assert.equal(quantityForShare("0.1", 0.25, "60000", "0.00001"), undefined);
  assert.equal(quantityForShare("1000", 0.5, "", "0.00001"), undefined);
});

test("order lists are grouped with entry, take profit and stop loss in order", () => {
  const entry = order({
    orderId: 21,
    orderListId: 7,
    clientOrderId: "ct_list_en",
  });
  const stop = order({
    orderId: 23,
    orderListId: 7,
    clientOrderId: "ct_list_sl",
    side: "SELL",
    type: "STOP_LOSS",
    price: "0.00000000",
    stopPrice: "58000.00000000",
    origQty: "0.00000000",
    status: "PENDING_NEW",
  });
  const target = order({
    orderId: 22,
    orderListId: 7,
    clientOrderId: "ct_list_tp",
    side: "SELL",
    type: "LIMIT_MAKER",
    price: "63000.00000000",
    origQty: "0.00000000",
    status: "PENDING_NEW",
  });
  const standalone = order({ orderId: 5 });
  const groups = groupOpenOrders({
    orders: [standalone, entry],
    // A leg listed twice is shown once.
    pendingOrders: [stop, target, stop],
  });
  assert.deepEqual(
    groups.map((group) => [
      group.orderListId,
      group.orders.map((leg) => orderRole(leg) ?? "single"),
    ]),
    [
      [undefined, ["single"]],
      [7, ["Entry", "Take profit", "Stop loss"]],
    ],
  );
  assert.equal(orderPriceLabel(stop), "Stop 58000");
  assert.equal(orderQuantityLabel(stop), "Set on fill");
  assert.equal(orderStatusLabel(stop), "Waiting for entry");
  assert.equal(orderQuantityLabel(entry), "0 / 0.001");
});

test("legs of lists placed elsewhere are labelled from their type", () => {
  assert.equal(
    orderRole(order({ orderListId: 3, side: "SELL", type: "STOP_LOSS_LIMIT" })),
    "Stop loss",
  );
  assert.equal(
    orderRole(order({ orderListId: 3, side: "SELL", type: "LIMIT_MAKER" })),
    "Take profit",
  );
  assert.equal(orderRole(order({})), undefined);
});

test("list summaries flag a partly filled entry whose fill has no exits", () => {
  const entry = order({ orderListId: 7, clientOrderId: "ct_list_en" });
  const exit = (fields: Partial<TestnetOrder>) =>
    order({ orderListId: 7, side: "SELL", type: "LIMIT_MAKER", ...fields });
  const pending = [
    exit({ status: "PENDING_NEW", origQty: "0" }),
    exit({ status: "PENDING_NEW", origQty: "0", type: "STOP_LOSS" }),
  ];
  assert.deepEqual(orderListSummary([entry, ...pending]), {
    text: "Entry with exits. Binance cancels these 3 orders together.",
    warning: false,
  });
  const partial = orderListSummary([
    { ...entry, status: "PARTIALLY_FILLED", executedQty: "0.00040000" },
    ...pending,
  ]);
  assert.equal(partial.warning, true);
  assert.match(partial.text, /^0.0004 BTC bought so far has no exits/);
  assert.match(
    orderListSummary([
      exit({ origQty: "0.00099" }),
      exit({ origQty: "0.00099", type: "STOP_LOSS" }),
    ]).text,
    /^Exits for 0.00099 BTC\./,
  );
});
