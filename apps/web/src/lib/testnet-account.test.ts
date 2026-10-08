import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { getTestnetAccount, parseWorkerUrl } from "./testnet-account";

test("worker URL accepts the loopback hosts", () => {
  for (const value of [
    "http://127.0.0.1:4001",
    "http://localhost:4001",
    "http://LOCALHOST:4001/",
    "http://[::1]:4001",
    "http://[0:0:0:0:0:0:0:1]:4001",
  ])
    assert.ok(parseWorkerUrl(value), value);
});

test("worker URL rejects other hosts and anything beyond an origin", () => {
  for (const value of [
    "http://execution:4001",
    "http://192.168.1.20:4001",
    "http://0.0.0.0:4001",
    "http://localhost.:4001",
    "http://localhost.example.com:4001",
    "http://localhost@example.com:4001",
    "http://[::ffff:127.0.0.1]:4001",
    "https://127.0.0.1:4001",
    "http://user:secret@127.0.0.1:4001",
    "http://127.0.0.1:4001/api",
    "http://127.0.0.1:4001/?debug=1",
    "http://127.0.0.1:4001/#snapshot",
    "127.0.0.1:4001",
    "",
  ])
    assert.equal(parseWorkerUrl(value), undefined, value);
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
          provider: "binance-spot-testnet",
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
