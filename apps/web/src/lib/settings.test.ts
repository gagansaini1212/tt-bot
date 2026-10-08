import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { DEV_CUSTOMER_ID } from "@crypto-trading/database/dev-seed";
import { signInForTesting } from "./current-customer.testing";
import type * as Settings from "./settings";

let getExchangeKeys: typeof Settings.getExchangeKeys;
let getNotifications: typeof Settings.getNotifications;
let saveExchangeKeys: typeof Settings.saveExchangeKeys;
let saveRiskLimits: typeof Settings.saveRiskLimits;

before(async () => {
  signInForTesting();
  ({ getExchangeKeys, getNotifications, saveExchangeKeys, saveRiskLimits } =
    await import("./settings"));
});

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

function respond(response: () => Response | Promise<Response>) {
  return mock.method(globalThis, "fetch", async () => response());
}

const keys = {
  source: "saved",
  keyType: "hmac",
  apiKeyLast4: "WXYZ",
  updatedAt: "2026-10-08T12:00:00.000Z",
  canSave: true,
  problem: null,
};

test("new keys go to the worker for the current customer, and only its answer comes back", async () => {
  const fetch = respond(() =>
    Response.json({
      status: "connected",
      change: { result: "saved", message: "Saved.", keys },
    }),
  );
  const request = {
    kind: "hmac" as const,
    apiKey: "k".repeat(64),
    secretKey: "s".repeat(64),
  };
  assert.deepEqual(await saveExchangeKeys(request), {
    result: "saved",
    message: "Saved.",
  });
  const [url, init] = fetch.mock.calls[0].arguments as [URL, RequestInit];
  assert.equal(url.pathname, "/settings/exchange-keys");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(String(init.body)), request);
  assert.equal(new Headers(init.headers).get("X-Customer-Id"), DEV_CUSTOMER_ID);
});

test("a status carrying anything beyond the masked key is refused", async () => {
  respond(() => Response.json({ status: "connected", keys }));
  const state = await getExchangeKeys();
  assert.equal(state.status, "connected");
  respond(() =>
    Response.json({
      status: "connected",
      keys: { ...keys, apiKeyLast4: "a-whole-api-key" },
    }),
  );
  assert.equal((await getExchangeKeys()).status, "unavailable");
});

test("a change the worker may have made without confirming it says so", async () => {
  const limits = {
    maxOrderNotional: "100",
    maxDailyRisk: "20",
    defaultStopLossPercent: "2",
    baseVersion: 0,
  };
  respond(() => Promise.reject(new TypeError("fetch failed")));
  const unconfirmed = await saveRiskLimits(limits);
  assert.equal(unconfirmed.result, "unconfirmed");
  assert.match(unconfirmed.message, /may or may not have been made/);
  mock.restoreAll();
  // The worker said it did nothing.
  respond(() =>
    Response.json({ status: "not_configured", reason: "database" }),
  );
  assert.equal((await saveRiskLimits(limits)).result, "unavailable");
  mock.restoreAll();
  // Nothing was sent.
  delete process.env.EXECUTION_API_TOKEN;
  assert.equal((await saveRiskLimits(limits)).result, "unavailable");
});

test("notifications are read from the worker", async () => {
  respond(() =>
    Response.json({
      status: "connected",
      notifications: [
        {
          id: "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a01",
          kind: "order_unknown",
          severity: "warning",
          title: "Order outcome unknown",
          body: "Check it.",
          createdAt: "2026-10-08T12:00:00.000Z",
          readAt: null,
        },
      ],
    }),
  );
  const state = await getNotifications();
  assert.equal(
    state.status === "connected" && state.notifications[0].title,
    "Order outcome unknown",
  );
});
