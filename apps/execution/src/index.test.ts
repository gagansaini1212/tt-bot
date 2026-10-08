import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { DEV_CUSTOMER_ID } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  seedDevelopment,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const preload = fileURLToPath(
  new URL("./fixtures/binance-fetch.mjs", import.meta.url),
);
const clock = fileURLToPath(new URL("./fixtures/clock.mjs", import.meta.url));
const token = "execution-test-token-at-least-32-characters";
// Nothing listens here: PostgreSQL is configured but unreachable.
const UNREACHABLE_DATABASE = "postgresql://nobody:nothing@127.0.0.1:1/none";
async function fixture(databaseUrl = UNREACHABLE_DATABASE) {
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
    DATABASE_URL: databaseUrl,
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
    journal: env.TESTNET_ORDER_JOURNAL_DIR,
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

/** Runs `serve` on a free port until `stop`. */
async function startWorker(env: NodeJS.ProcessEnv) {
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
      env: { ...env, EXECUTION_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stop = async () => {
    const exited = once(worker, "exit");
    worker.kill("SIGTERM");
    await exited;
  };
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
  } catch (error) {
    if (worker.exitCode === null) await stop();
    throw error;
  }
  return { port, ipv6, worker, stop };
}

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

describe("with PostgreSQL", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
    await seedDevelopment(database.admin);
  });
  after(() => database?.drop());

  test("manual order validates, submits once, survives restart and can be queried/cancelled", async () => {
    const f = await fixture(database.appUrl);
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
      const [intent] = await database.admin`
        select status from order_intents where idempotency_key = 'ct_dev'
      `;
      assert.equal(intent.status, "acknowledged");
      const [placed] = await database.admin`
        select exchange_order_id, status, requested_quantity from exchange_orders
        where client_order_id = 'ct_dev'
      `;
      assert.deepEqual(
        { ...placed },
        {
          exchange_order_id: "123",
          status: "NEW",
          requested_quantity: "0.001000000000000000",
        },
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
    const f = await fixture(database.appUrl);
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
      const [intent] = await database.admin`
        select i.status, j.completed_at, j.last_error
        from order_intents i
        join outbox_jobs j on j.payload ->> 'orderIntentId' = i.id::text
        where i.idempotency_key = 'ct_unknown'
      `;
      // Left for reconciliation, which looks it up and never resubmits.
      assert.equal(intent.status, "unknown");
      assert.equal(intent.completed_at, null);
      assert.ok(intent.last_error);
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

  test("a leftover order journal blocks orders until it is imported", async () => {
    const f = await fixture(database.appUrl);
    try {
      await mkdir(f.journal, { recursive: true });
      const entry = {
        instrument: "BTC-USDT",
        quantity: "0.001",
        price: "60000",
        timeInForce: "GTC",
        takeProfitPrice: "63000",
        stopLossPrice: "58000",
        listClientOrderId: "ct_old_list",
      };
      await writeFile(
        join(f.journal, "ct_old_list.json"),
        JSON.stringify({
          kind: "protected_entry",
          entry,
          status: "submission_pending",
          createdAt: "2026-09-01T10:00:00.000Z",
        }),
      );
      // The CLI's journal dropped createdAt once Binance acknowledged.
      await writeFile(
        join(f.journal, "ct_old_cli.json"),
        JSON.stringify({
          order: {
            instrument: "BTC-USDT",
            side: "BUY",
            quantity: "0.001",
            price: "60000",
            clientOrderId: "ct_old_cli",
          },
          status: "acknowledged",
          result: {},
        }),
      );
      const reuse = ["place-order", "BTC-USDT", "BUY", "0.001", "60000"];
      const blocked = f.run([...reuse, "ct_new_cli"]);
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /pnpm exchange import-journal/);
      const serve = f.run(["serve"]);
      assert.equal(serve.status, 1);
      assert.match(serve.stderr, /pnpm exchange import-journal/);

      const imported = f.run(["import-journal"]);
      assert.equal(imported.status, 0, imported.stderr);
      assert.match(imported.stdout, /Imported 2 of the 2 order intents/);
      assert.match(
        f.run(["import-journal"]).stdout,
        /Imported 0 of the 2 order intents/,
      );
      const intents = await database.admin`
        select idempotency_key, status, created_at from order_intents
        where idempotency_key like 'ct_old_%' order by idempotency_key
      `;
      assert.deepEqual(
        intents.map(({ idempotency_key, status }) => [idempotency_key, status]),
        [
          ["ct_old_cli", "acknowledged"],
          // Its outcome was never confirmed, so it stays unknown.
          ["ct_old_list", "unknown"],
        ],
      );
      assert.equal(
        intents[1].created_at.toISOString(),
        "2026-09-01T10:00:00.000Z",
      );

      await rm(f.journal, { recursive: true });
      const reused = f.run([...reuse, "ct_old_cli"]);
      assert.equal(reused.status, 1);
      assert.match(reused.stderr, /query it/);
      assert.equal(
        (await f.requests()).filter(
          (r) => r.path === "/api/v3/order" && r.method === "POST",
        ).length,
        0,
      );
    } finally {
      await f.cleanup();
    }
  });

  test("worker HTTP requires a token, rejects browser origins and writes, caches account snapshots, serves market data", async () => {
    const f = await fixture(database.appUrl);
    const { port, ipv6, worker, stop } = await startWorker(f.env);
    try {
      const url = `http://127.0.0.1:${port}/snapshot`;
      const headers = {
        Authorization: `Bearer ${token}`,
        "X-Customer-Id": DEV_CUSTOMER_ID,
      };
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
      // Another customer cannot read the dev customer's account.
      const stranger = await fetch(url, {
        headers: { ...headers, "X-Customer-Id": randomUUID() },
      });
      assert.equal((await stranger.json()).reason, "exchange_account");
    } finally {
      await stop();
      await f.cleanup();
    }
  });
});

test("without its database the worker still serves market data, and says why account data is missing", async () => {
  const f = await fixture();
  const { port, stop } = await startWorker(f.env);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Customer-Id": DEV_CUSTOMER_ID,
    };
    const snapshot = await fetch(`http://127.0.0.1:${port}/snapshot`, {
      headers,
    });
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).reason, "database");
    const market = await fetch(
      `http://127.0.0.1:${port}/market/tickers?symbols=BTCUSDT`,
      { headers },
    );
    assert.equal((await market.json()).status, "connected");
    for (const args of [
      ["serve"],
      ["place-order", "BTC-USDT", "BUY", "0.001", "60000", "ct_no_database"],
    ]) {
      const result = f.run(args, { DATABASE_URL: "" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Set DATABASE_URL/);
    }
  } finally {
    await stop();
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
