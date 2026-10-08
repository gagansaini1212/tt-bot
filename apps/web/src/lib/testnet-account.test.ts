import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  getTestnetAccount,
  parseWorkerUrl,
  snapshotFreshness,
} from "./testnet-account";

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
