import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import type { ManualOrderRequest } from "@crypto-trading/exchanges/manual-order";
import { signInForTesting } from "./current-customer.testing";
import type * as Orders from "./orders";

let cancelOrder: typeof Orders.cancelOrder;
let getOrderTicket: typeof Orders.getOrderTicket;
let submitOrder: typeof Orders.submitOrder;

before(async () => {
  signInForTesting();
  ({ cancelOrder, getOrderTicket, submitOrder } = await import("./orders"));
});

const request: ManualOrderRequest = {
  type: "limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  price: "60000",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: "ct_web_001",
};

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

function respond(response: () => Response | Promise<Response>) {
  return mock.method(globalThis, "fetch", async () => response());
}

test("an order is POSTed to the worker as JSON and its outcome returned", async () => {
  const fetch = respond(() =>
    Response.json({
      status: "connected",
      outcome: { status: "working", message: "On the book." },
    }),
  );
  assert.deepEqual(await submitOrder(request), {
    status: "working",
    message: "On the book.",
  });
  const [url, init] = fetch.mock.calls[0].arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/orders");
  assert.equal(init.method, "POST");
  assert.match(
    (init.headers as Record<string, string>)["X-Customer-Id"],
    /^[0-9a-f-]{36}$/,
  );
  assert.deepEqual(JSON.parse(String(init.body)), request);
});

test("when the worker may have received an order, its outcome is unknown and keeps the ID", async () => {
  for (const response of [
    () => Promise.reject(new TypeError("fetch failed")),
    () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      return Promise.reject(error);
    },
    () => new Response("not json"),
    () => Response.json({ status: "unavailable" }, { status: 503 }),
  ]) {
    respond(response);
    const outcome = await submitOrder(request);
    assert.equal(outcome.status, "unknown");
    assert.equal(outcome.listClientOrderId, "ct_web_001");
    assert.match(outcome.message, /Check its status/);
    mock.restoreAll();
  }
});

test("when the request was never sent, the order is reported as not placed", async () => {
  respond(() => Response.json({ status: "invalid_request" }, { status: 400 }));
  assert.equal((await submitOrder(request)).status, "rejected");
  mock.restoreAll();
  // The worker could not act for this customer, so it sent nothing.
  for (const reason of ["database", "exchange_account"]) {
    respond(() => Response.json({ status: "not_configured", reason }));
    assert.equal((await submitOrder(request)).status, "rejected", reason);
    mock.restoreAll();
  }
  delete process.env.EXECUTION_API_TOKEN;
  const fetch = respond(() => Response.json({}));
  assert.equal((await submitOrder(request)).status, "rejected");
  assert.equal(fetch.mock.callCount(), 0);
});

test("the ticket reports the worker's reason when dashboard orders are off", async () => {
  respond(() =>
    Response.json({
      status: "connected",
      disabled: "Set TESTNET_MANUAL_ALLOCATION_USDT.",
    }),
  );
  assert.deepEqual(await getOrderTicket(), {
    status: "unavailable",
    message: "Set TESTNET_MANUAL_ALLOCATION_USDT.",
  });
});

test("an unconfirmed cancel asks for a refresh rather than claiming success", async () => {
  respond(() => Promise.reject(new TypeError("fetch failed")));
  const outcome = await cancelOrder({
    instrument: "BTC-USDT",
    orderId: 7,
    acceptUnprotected: false,
  });
  assert.equal(outcome.status, "unknown");
  assert.match(outcome.message, /Refresh/);
});
