import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { z } from "zod";
import { signInForTesting } from "./current-customer.testing";
import type * as Orders from "./orders";
import type * as WorkerClient from "./worker-client";

let callWorkerForCustomer: typeof WorkerClient.callWorkerForCustomer;
let submitOrder: typeof Orders.submitOrder;
let cancelOrder: typeof Orders.cancelOrder;

before(async () => {
  signInForTesting(null);
  ({ callWorkerForCustomer } = await import("./worker-client"));
  ({ submitOrder, cancelOrder } = await import("./orders"));
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
});

test("without a signed-in customer, nothing reaches the worker", async () => {
  const fetch = mock.method(globalThis, "fetch", async () =>
    Response.json({ status: "connected" }),
  );
  const read = await callWorkerForCustomer({
    path: "/snapshot",
    schema: z.object({}),
  });
  assert.equal(read.status, "not_configured");
  assert.equal(read.reason, "signed_out");

  const order = await submitOrder({
    type: "limit",
    instrument: "BTC-USDT",
    quantity: "0.001",
    price: "60000",
    takeProfitPrice: "63000",
    stopLossPrice: "58000",
    listClientOrderId: "ct_signed_out_001",
  });
  assert.equal(order.status, "rejected");
  const cancel = await cancelOrder({
    instrument: "BTC-USDT",
    orderId: 1,
    acceptUnprotected: false,
  });
  assert.equal(cancel.status, "rejected");
  assert.equal(fetch.mock.callCount(), 0);
});
