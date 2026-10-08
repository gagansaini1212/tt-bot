import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const preload = fileURLToPath(
  new URL("./fixtures/binance-fetch.mjs", import.meta.url),
);
const clock = fileURLToPath(new URL("./fixtures/clock.mjs", import.meta.url));
const token = "execution-test-token-at-least-32-characters";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "binance-execution-"));
  const log = join(directory, "requests.jsonl");
  const env = {
    ...process.env,
    EXCHANGE_PROVIDER: "binance-spot-testnet",
    LIVE_TRADING_ENABLED: "false",
    BINANCE_TESTNET_API_KEY: "test-key",
    BINANCE_TESTNET_API_SECRET: "test-secret",
    TESTNET_MAX_ORDER_NOTIONAL_USDT: "100",
    TESTNET_ORDER_JOURNAL_DIR: join(directory, "journal"),
    FIXTURE_REQUEST_LOG: log,
    EXECUTION_API_TOKEN: token,
  };
  const run = (args: string[], overrides = {}) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", preload, entry, ...args],
      // The timeout stops a `serve` that starts unexpectedly from hanging the test.
      { env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000 },
    );
  const requests = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; path: string });
  return {
    env,
    run,
    requests,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
// Hosts without IPv6 loopback cannot bind [::1].
function canListenOnIpv6(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = createServer().once("error", () => resolve(false));
    probe.listen(port, "::1", () => probe.close(() => resolve(true)));
  });
}

test("manual order validates, submits once, survives restart and can be queried/cancelled", async () => {
  const f = await fixture();
  try {
    assert.equal(f.run(["check"]).status, 0);
    assert.equal(
      f.run(["test-order", "BTC-USDT", "BUY", "0.001", "60000", "ct_dev"])
        .status,
      0,
    );
    assert.equal(
      (await f.requests()).filter((r) => r.path === "/api/v3/order").length,
      0,
    );
    assert.equal(
      f.run(["place-order", "BTC-USDT", "BUY", "0.001", "60000", "ct_dev"])
        .status,
      0,
    );
    const repeated = f.run([
      "place-order",
      "BTC-USDT",
      "BUY",
      "0.001",
      "60000",
      "ct_dev",
    ]);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /query it/);
    assert.equal(
      (await f.requests()).filter(
        (r) => r.path === "/api/v3/order" && r.method === "POST",
      ).length,
      1,
    );
    assert.equal(f.run(["order", "BTC-USDT", "ct_dev"]).status, 0);
    assert.match(f.run(["cancel", "BTC-USDT", "ct_dev"]).stdout, /CANCELED/);
    assert.equal(
      f.run([
        "place-order",
        "BTC-USDT",
        "BUY",
        "0.002",
        "60000",
        "ct_too_large",
      ]).status,
      1,
    );
    assert.equal(
      (await f.requests()).filter(
        (r) => r.path === "/api/v3/order" && r.method === "POST",
      ).length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("unknown submission outcome remains blocked after a command restart", async () => {
  const f = await fixture();
  try {
    const args = [
      "place-order",
      "BTC-USDT",
      "BUY",
      "0.001",
      "60000",
      "ct_unknown",
    ];
    const first = f.run(args, { FIXTURE_UNKNOWN_OUTCOME: "true" });
    assert.equal(first.status, 1);
    assert.match(first.stderr, /outcome is unknown/);
    assert.equal(f.run(args).status, 1);
    assert.equal(
      (await f.requests()).filter(
        (r) => r.path === "/api/v3/order" && r.method === "POST",
      ).length,
      1,
    );
    assert.equal(f.run(["order", "BTC-USDT", "ct_unknown"]).status, 0);
  } finally {
    await f.cleanup();
  }
});

test("production mode and unsupported providers cannot start", async () => {
  const f = await fixture();
  try {
    assert.equal(f.run(["check"], { LIVE_TRADING_ENABLED: "true" }).status, 1);
    assert.equal(f.run(["check"], { EXCHANGE_PROVIDER: "binance" }).status, 1);
    assert.equal(
      f.run(["check"], { BINANCE_TESTNET_API_SECRET: "" }).status,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("worker HTTP requires a token, rejects browser origins and writes, caches account snapshots, serves market data", async () => {
  const f = await fixture();
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const ipv6 = await canListenOnIpv6(port);
  const worker = spawn(
    process.execPath,
    ["--import", "tsx", "--import", preload, "--import", clock, entry, "serve"],
    {
      env: { ...f.env, EXECUTION_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await Promise.race([
      once(worker.stdout, "data"),
      once(worker, "exit").then(() => {
        throw new Error("Worker exited before starting");
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Worker startup timed out")),
          5000,
        );
        timer.unref();
      }),
    ]);
    const url = `http://127.0.0.1:${port}/snapshot`;
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (
        await fetch(url, {
          headers: { ...headers, Origin: "http://localhost" },
        })
      ).status,
      401,
    );
    assert.equal((await fetch(url, { method: "POST", headers })).status, 405);
    const first = await fetch(url, { headers });
    assert.equal(first.headers.get("cache-control"), "no-store");
    const data = await first.json();
    assert.equal(data.status, "connected");
    assert.equal(data.snapshot.balances[0].free, "10000.12345678");
    assert.doesNotMatch(JSON.stringify(data), /test-key|test-secret/);
    await fetch(url, { headers });
    if (ipv6)
      assert.equal(
        (await fetch(`http://[::1]:${port}/snapshot`, { headers })).status,
        200,
      );
    assert.equal(
      (await f.requests()).filter((r) => r.path === "/api/v3/account").length,
      1,
    );
    const stepped = once(worker.stdout, "data");
    worker.kill("SIGUSR2");
    await stepped;
    await fetch(url, { headers });
    assert.equal(
      (await f.requests()).filter((r) => r.path === "/api/v3/account").length,
      2,
      "a snapshot dated in the future is refetched, not served from cache",
    );
    const market = await fetch(
      `http://127.0.0.1:${port}/market/tickers?symbols=BTCUSDT`,
      { headers },
    );
    assert.equal((await market.json()).tickers[0].lastPrice, "60000.01");
  } finally {
    const exited = once(worker, "exit");
    worker.kill("SIGTERM");
    await exited;
    await f.cleanup();
  }
});

test("worker refuses to start while another process holds its [::1] port", async (t) => {
  const f = await fixture();
  const squatter = createServer();
  try {
    const listening = await new Promise<boolean>((resolve) => {
      squatter.once("error", () => resolve(false));
      squatter.listen(0, "::1", () => resolve(true));
    });
    if (!listening) return t.skip("This host has no IPv6 loopback.");
    const address = squatter.address();
    assert.ok(address && typeof address !== "string");
    const result = f.run(["serve"], { EXECUTION_PORT: String(address.port) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /address already in use ::1:/);
  } finally {
    squatter.close();
    await f.cleanup();
  }
});
