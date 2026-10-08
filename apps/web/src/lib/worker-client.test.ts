import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { z } from "zod";
import { callWorker, parseWorkerUrl } from "./worker-client";

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

const token = "web-test-token-at-least-32-characters";
const schema = z.object({ value: z.string() });

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = token;
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

function respond(response: () => Response | Promise<Response>) {
  return mock.method(globalThis, "fetch", async () => response());
}

test("sends an authorized, uncached GET to the worker and parses the response", async () => {
  const fetch = respond(() =>
    Response.json(
      { status: "connected", value: "ok", extra: 1 },
      { headers: { Date: "Thu, 08 Oct 2026 12:00:00 GMT" } },
    ),
  );
  const result = await callWorker({
    path: "/market/klines",
    query: {
      instrument: "BTC-USDT",
      interval: "1m",
      limit: 5,
      skip: undefined,
    },
    schema,
  });
  assert.deepEqual(result, {
    status: "connected",
    data: { value: "ok" },
    date: "Thu, 08 Oct 2026 12:00:00 GMT",
  });
  const [url, init] = fetch.mock.calls[0].arguments as [URL, RequestInit];
  assert.equal(
    String(url),
    "http://127.0.0.1:4001/market/klines?instrument=BTC-USDT&interval=1m&limit=5",
  );
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  assert.deepEqual(init.headers, { Authorization: `Bearer ${token}` });
});

test("sends a JSON body with other methods", async () => {
  const fetch = respond(() =>
    Response.json({ status: "connected", value: "" }),
  );
  await callWorker({
    method: "POST",
    path: "/orders",
    body: { quantity: "0.001" },
    schema,
  });
  const [, init] = fetch.mock.calls[0].arguments as [URL, RequestInit];
  assert.equal(init.method, "POST");
  assert.equal(init.body, '{"quantity":"0.001"}');
  assert.deepEqual(init.headers, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
});

test("the token never leaves the configured loopback origin", async () => {
  process.env.EXECUTION_API_URL = "http://[::1]:4002";
  const fetch = respond(() =>
    Response.json({ status: "connected", value: "" }),
  );
  await callWorker({ path: "//attacker.example/snapshot", schema });
  assert.equal(
    (fetch.mock.calls[0].arguments[0] as URL).origin,
    "http://[::1]:4002",
  );

  process.env.EXECUTION_API_URL = "http://attacker.example:4001";
  const rejected = await callWorker({ path: "/snapshot", schema });
  assert.ok(rejected.status !== "connected");
  assert.equal(rejected.status, "unavailable");
  assert.equal(rejected.reason, "invalid_url");

  delete process.env.EXECUTION_API_URL;
  delete process.env.EXECUTION_API_TOKEN;
  const missing = await callWorker({ path: "/snapshot", schema });
  assert.equal(missing.status, "not_configured");
  assert.equal(fetch.mock.callCount(), 1);
});

test("maps each failure to a user-facing state", async () => {
  const cases: [() => Response | Promise<Response>, string, string][] = [
    [
      () => Promise.reject(new TypeError("fetch failed")),
      "unavailable",
      "unreachable",
    ],
    [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      "unavailable",
      "timeout",
    ],
    [
      () => Response.json({ status: "unavailable" }, { status: 503 }),
      "unavailable",
      "rejected",
    ],
    [
      () => Response.json({ status: "unauthorized" }, { status: 401 }),
      "unavailable",
      "rejected",
    ],
    [
      () => Response.json({ status: "invalid_request" }, { status: 400 }),
      "unavailable",
      "invalid_request",
    ],
    [
      () => Response.json({ status: "not_configured", message: "x" }),
      "not_configured",
      "worker_not_configured",
    ],
    [() => new Response("<html>"), "unavailable", "invalid_response"],
    [
      () => Response.json({ status: "connected", value: 1 }),
      "unavailable",
      "invalid_response",
    ],
    [
      () => Response.json({ status: "pending", value: "ok" }),
      "unavailable",
      "invalid_response",
    ],
  ];
  for (const [response, status, reason] of cases) {
    respond(response);
    const result = await callWorker({ path: "/snapshot", schema });
    assert.equal(result.status, status, reason);
    assert.ok(result.status !== "connected");
    assert.equal(result.reason, reason);
    assert.ok(result.message.length > 0);
    mock.restoreAll();
  }
});
