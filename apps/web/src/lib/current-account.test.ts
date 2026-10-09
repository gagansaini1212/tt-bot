import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { DEV_EXCHANGE_ACCOUNT_ID } from "@crypto-trading/database/dev-seed";
import { z } from "zod";
import { DEV_ACCOUNT, DEV_CUSTOMER } from "./current-customer.testing";
import type * as WorkerClient from "./worker-client";

let callWorkerForAccount: typeof WorkerClient.callWorkerForAccount;

// The real account choice, for the dev customer.
before(async () => {
  mock.module(pathToFileURL(join(__dirname, "current-customer.ts")).href, {
    exports: { getCurrentCustomer: async () => DEV_CUSTOMER },
  });
  ({ callWorkerForAccount } = await import("./worker-client"));
});

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

const schema = z.object({ value: z.string() });
const htx = {
  ...DEV_ACCOUNT,
  id: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7aff",
  venueName: "HTX",
  readOnly: true,
};

/** A worker that lists `accounts` and answers every other route. */
function worker(accounts: object[]) {
  return mock.method(globalThis, "fetch", async (input: URL) =>
    Response.json(
      input.pathname === "/accounts"
        ? { status: "connected", accounts }
        : { status: "connected", value: "ok" },
    ),
  );
}

test("account calls act on the customer's oldest account that trades", async () => {
  const fetch = worker([htx, DEV_ACCOUNT]);
  const result = await callWorkerForAccount({ path: "/snapshot", schema });
  assert.equal(result.status, "connected");
  const [listed, called] = fetch.mock.calls.map(
    (call) => call.arguments as [URL, RequestInit],
  );
  assert.equal(listed[0].pathname, "/accounts");
  assert.equal(called[0].pathname, "/snapshot");
  assert.equal(
    (called[1].headers as Record<string, string>)["X-Exchange-Account-Id"],
    DEV_EXCHANGE_ACCOUNT_ID,
  );
});

test("a customer with only a read-only account acts on it, and one with none is told so", async () => {
  const readOnly = worker([htx]);
  await callWorkerForAccount({ path: "/snapshot", schema });
  assert.equal(
    (
      readOnly.mock.calls[1].arguments[1] as RequestInit & {
        headers: Record<string, string>;
      }
    ).headers["X-Exchange-Account-Id"],
    htx.id,
  );
  mock.restoreAll();

  const none = worker([]);
  const result = await callWorkerForAccount({ path: "/snapshot", schema });
  assert.ok(result.status === "not_configured");
  assert.equal(result.reason, "no_exchange_account");
  // Nothing is asked of an account that does not exist.
  assert.equal(none.mock.callCount(), 1);
});
