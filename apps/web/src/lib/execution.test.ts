import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { DEV_CUSTOMER, signInForTesting } from "./current-customer.testing";
import type * as Execution from "./execution";
import type * as Orders from "./orders";

let getExecutionState: typeof Execution.getExecutionState;
let cancelTrigger: typeof Orders.cancelTrigger;

before(async () => {
  signInForTesting();
  ({ getExecutionState } = await import("./execution"));
  ({ cancelTrigger } = await import("./orders"));
});

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

const state = {
  checkedAt: "2026-10-08T12:00:05.000Z",
  alerts: [
    {
      listClientOrderId: "ct_web_alert",
      instrument: "BTC-USDT",
      state: "unprotected",
      heldQuantity: "0.00099",
      exitReason: "protection_failed",
      detail: "The worker is selling it at market.",
      closeBlocked: false,
      overdueSince: null,
      since: "2026-10-08T12:00:00.000Z",
    },
  ],
  triggers: [],
  notifications: [],
};

function respond(body: unknown) {
  return mock.method(globalThis, "fetch", async () => Response.json(body));
}

test("the loop's state is read for the signed-in customer", async () => {
  const fetch = respond({ status: "connected", execution: state });
  assert.deepEqual(await getExecutionState(), {
    status: "connected",
    execution: state,
  });
  const [url, init] = fetch.mock.calls[0].arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/execution");
  assert.equal(
    (init.headers as Record<string, string>)["X-Customer-Id"],
    DEV_CUSTOMER.id,
  );
});

test("a malformed or failed read is reported, not shown as no alerts", async () => {
  respond({
    status: "connected",
    execution: { ...state, alerts: [{ listClientOrderId: "x" }] },
  });
  assert.equal((await getExecutionState()).status, "unavailable");
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () =>
    Promise.reject(new TypeError("fetch failed")),
  );
  assert.equal((await getExecutionState()).status, "unavailable");
});

test("cancelling a held stop-limit entry posts its ID for the signed-in customer", async () => {
  const fetch = respond({
    status: "connected",
    outcome: { status: "cancelled", message: "Cancelled." },
  });
  assert.equal((await cancelTrigger("ct_web_stop")).status, "cancelled");
  const [url, init] = fetch.mock.calls[0].arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/orders/triggers/cancel");
  assert.equal(init.method, "POST");
  assert.equal(
    (init.headers as Record<string, string>)["X-Customer-Id"],
    DEV_CUSTOMER.id,
  );
  assert.deepEqual(JSON.parse(String(init.body)), {
    listClientOrderId: "ct_web_stop",
  });
});
