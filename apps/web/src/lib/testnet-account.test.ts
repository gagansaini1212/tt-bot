import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { signInForTesting } from "./current-customer.testing";
import type * as TestnetAccount from "./testnet-account";

let getTestnetAccount: typeof TestnetAccount.getTestnetAccount;
let snapshotFreshness: typeof TestnetAccount.snapshotFreshness;

before(async () => {
  signInForTesting();
  ({ getTestnetAccount, snapshotFreshness } =
    await import("./testnet-account"));
});

const capturedAt = "2026-10-08T12:00:00.000Z";
const captured = Date.parse(capturedAt);
const workerDate = (offset: number) =>
  new Date(captured + offset).toUTCString();

test("snapshot freshness uses the worker's clock, so host clock skew does not matter", () => {
  for (const skew of [-10 * 60_000, -60_000, 60_000, 10 * 60_000])
    assert.equal(
      snapshotFreshness(capturedAt, workerDate(2_000), captured + skew),
      "fresh",
      `skew ${skew}`,
    );
  // The Date header drops milliseconds, so a just-captured snapshot can look slightly ahead.
  assert.equal(
    snapshotFreshness("2026-10-08T12:00:00.900Z", workerDate(0), captured),
    "fresh",
  );
});

test("snapshot freshness flags old and future-dated snapshots", () => {
  assert.equal(
    snapshotFreshness(capturedAt, workerDate(30_000), captured),
    "fresh",
  );
  assert.equal(
    snapshotFreshness(capturedAt, workerDate(31_000), captured),
    "stale",
  );
  assert.equal(
    snapshotFreshness(capturedAt, workerDate(-6_000), captured),
    "future",
  );
});

test("snapshot freshness falls back to this machine's clock without a usable Date header", () => {
  for (const header of [null, "not a date"]) {
    assert.equal(
      snapshotFreshness(capturedAt, header, captured + 10_000),
      "fresh",
    );
    assert.equal(
      snapshotFreshness(capturedAt, header, captured + 31_000),
      "stale",
    );
    assert.equal(
      snapshotFreshness(capturedAt, header, captured - 6_000),
      "future",
    );
  }
});

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

// Responds like the worker, whose clock is `skew` ms away from this machine's.
function mockWorker({ skew = 0, age = 2_000 } = {}) {
  return mock.method(globalThis, "fetch", async () => {
    const workerNow = Date.now() + skew;
    return Response.json(
      {
        status: "connected",
        snapshot: {
          venue: "binance-spot-testnet",
          capturedAt: new Date(workerNow - age).toISOString(),
          canTrade: true,
          balances: [],
          orders: [],
          fills: [],
        },
      },
      { headers: { Date: new Date(workerNow).toUTCString() } },
    );
  });
}

test("account stays connected when the worker's clock is a minute ahead or behind", async () => {
  for (const skew of [-60_000, 60_000]) {
    mockWorker({ skew });
    assert.equal((await getTestnetAccount()).status, "connected");
  }
});

test("a stale snapshot is reported differently from an unreachable worker", async () => {
  mockWorker({ age: 45_000 });
  const stale = await getTestnetAccount();
  assert.equal(stale.status, "unavailable");

  mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const unreachable = await getTestnetAccount();
  assert.equal(unreachable.status, "unavailable");

  assert.ok("message" in stale && "message" in unreachable);
  assert.match(stale.message, /worker is running/);
  assert.match(unreachable.message, /Start the execution worker/);
});

test("the token is sent to a localhost worker but never to another host", async () => {
  process.env.EXECUTION_API_URL = "http://localhost:4001";
  const fetch = mockWorker();
  assert.equal((await getTestnetAccount()).status, "connected");
  assert.equal(
    String(fetch.mock.calls[0].arguments[0]),
    "http://localhost:4001/snapshot",
  );

  process.env.EXECUTION_API_URL = "http://execution:4001";
  const rejected = await getTestnetAccount();
  assert.equal(rejected.status, "unavailable");
  assert.ok("message" in rejected);
  assert.match(rejected.message, /EXECUTION_API_URL/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("failures keep the account's wording", async () => {
  delete process.env.EXECUTION_API_TOKEN;
  const missing = await getTestnetAccount();
  assert.equal(missing.status, "not_configured");
  assert.ok("message" in missing);
  assert.match(missing.message, /virtual balances, orders, and fills/);

  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  for (const [response, pattern] of [
    [Response.json({ status: "unauthorized" }, { status: 401 }), /credentials/],
    [
      Response.json({ status: "invalid_request" }, { status: 400 }),
      /credentials/,
    ],
    [Response.json({ status: "not_configured" }), /restart it/],
    [Response.json({ status: "connected", snapshot: {} }), /Start the/],
  ] as const) {
    mock.method(globalThis, "fetch", async () => response);
    const state = await getTestnetAccount();
    assert.notEqual(state.status, "connected");
    assert.ok("message" in state);
    assert.match(state.message, pattern);
  }
});
