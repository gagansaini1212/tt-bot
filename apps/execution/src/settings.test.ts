import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, describe, test, type TestContext } from "node:test";
import { DEV_CUSTOMER_ID } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  seedDevelopment,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import { BinanceSpotTestnet } from "@crypto-trading/exchanges";
import { accountResolver } from "./accounts";
import {
  ExchangeCredentialStore,
  savedOrEnvironmentExchanges,
} from "./exchange-credentials";
import { MemoryOrderIntents } from "./fixtures/memory-order-intents";
import { createRequestListener } from "./http";
import {
  markNotificationsRead,
  notificationHistory,
  NotificationWebhooks,
} from "./notification-webhooks";
import { PostgresRiskLimits } from "./risk-limits";
import { createRoutes } from "./routes";
import { SecretBox } from "./secret-box";

const token = "settings-test-token-at-least-32-characters";
const savedKey = "SAVEDkeyE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14ySAVE";
const savedSecret = "SAVEDsecretdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqq";
const envKey =
  "ENVkeyZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju9ENV1";
const discord = `https://discord.com/api/webhooks/123456789012345678/${"T".repeat(64)}wxyz`;

/** A Binance fixture recording which API key signed each request. */
function binance() {
  const keys: string[] = [];
  let refuse = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get("X-MBX-APIKEY");
    if (key) keys.push(key);
    if (url.pathname === "/api/v3/time")
      return Response.json({ serverTime: Date.now() });
    if (refuse)
      return Response.json(
        { code: -2015, msg: "Invalid API-key, IP, or permissions for action." },
        { status: 401 },
      );
    if (url.pathname === "/api/v3/account")
      return Response.json({ canTrade: true, balances: [] });
    return Response.json([]);
  }) as typeof globalThis.fetch;
  return {
    keys,
    fetch,
    refuse: (value: boolean) => {
      refuse = value;
    },
  };
}

describe("Settings routes", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
    await seedDevelopment(database.admin);
  });
  after(() => database?.drop());

  async function serve(t: TestContext, { locked = false } = {}) {
    const box = locked ? undefined : new SecretBox(randomBytes(32));
    const fake = binance();
    const db = database.app;
    const keys = new ExchangeCredentialStore(db, box);
    const environment = new BinanceSpotTestnet({
      apiKey: envKey,
      apiSecret: "env-secret",
      fetch: fake.fetch,
    });
    const exchanges = savedOrEnvironmentExchanges({
      store: keys,
      environment,
      market: environment,
      create: (saved) =>
        new BinanceSpotTestnet({ ...saved, fetch: fake.fetch }),
    });
    const risk = new PostgresRiskLimits(db);
    const webhookCalls: string[] = [];
    const server = createServer(
      createRequestListener({
        token,
        exchanges,
        accounts: accountResolver(db),
        routes: createRoutes({
          intents: new MemoryOrderIntents(),
          risk,
          settings: {
            keys,
            exchanges,
            environmentKeys: { keyType: "hmac", apiKeyLast4: envKey.slice(-4) },
            risk,
            webhooks: new NotificationWebhooks({
              database: db,
              box,
              fetch: (async (input: string | URL | Request) => {
                webhookCalls.push(String(input));
                return new Response(null, { status: 204 });
              }) as typeof fetch,
            }),
            notifications: {
              list: (customerId) => notificationHistory(db, customerId),
              markRead: (customerId) => markNotificationsRead(db, customerId),
            },
          },
          env: {
            TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT",
            TESTNET_MANUAL_ALLOCATION_USDT: "300",
          },
        }),
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const responses: string[] = [];
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      customerId = DEV_CUSTOMER_ID,
    ) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Customer-Id": customerId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      responses.push(text);
      assert.equal(response.status, 200, `${method} ${path}: ${text}`);
      return JSON.parse(text);
    };
    return { call, fake, responses, webhookCalls };
  }

  test("keys are saved, used for every account request, tested, and removed, never returned", async (t) => {
    const { call, fake, responses } = await serve(t);
    const initial = await call("GET", "/settings/exchange-keys");
    assert.deepEqual(initial.keys, {
      source: "environment",
      keyType: "hmac",
      apiKeyLast4: "ENV1",
      updatedAt: null,
      canSave: true,
      problem: null,
    });

    const saved = await call("POST", "/settings/exchange-keys", {
      kind: "hmac",
      apiKey: savedKey,
      secretKey: savedSecret,
    });
    assert.equal(saved.change.result, "saved");
    assert.equal(saved.change.keys.source, "saved");
    assert.equal(saved.change.keys.apiKeyLast4, "SAVE");

    // The account's requests now carry the saved key.
    await call("GET", "/snapshot");
    assert.equal(fake.keys.at(-1), savedKey);
    const tested = await call("POST", "/settings/exchange-keys/test");
    assert.deepEqual(tested.test, {
      result: "connected",
      source: "saved",
      canTrade: true,
      message:
        "Connected. Binance Spot Testnet accepts the keys and allows trading.",
    });
    fake.refuse(true);
    const refused = await call("POST", "/settings/exchange-keys/test");
    assert.equal(refused.test.result, "failed");
    assert.match(refused.test.message, /refused these keys \(code -2015\)/);
    fake.refuse(false);

    const invalid = await call("POST", "/settings/exchange-keys", {
      kind: "private_key",
      apiKey: savedKey,
      privateKey: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`,
    });
    assert.equal(invalid.change.result, "invalid");
    assert.equal(invalid.change.keys.apiKeyLast4, "SAVE");

    const removed = await call("DELETE", "/settings/exchange-keys");
    assert.equal(removed.change.result, "removed");
    assert.match(removed.change.message, /\.env file again/);
    await call("GET", "/snapshot");
    assert.equal(fake.keys.at(-1), envKey);

    // No answer carried a key or secret beyond the last four characters.
    assert.doesNotMatch(
      responses.join("\n"),
      new RegExp(`${savedKey}|${savedSecret}|${envKey}|env-secret`),
    );
    const audit = await database.admin`
      select payload from audit_events where event_type like 'exchange_keys.%'
    `;
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(savedSecret));
  });

  test("without a master key, keys cannot be saved and the .env keys keep working", async (t) => {
    const { call, fake } = await serve(t, { locked: true });
    assert.equal(
      (await call("GET", "/settings/exchange-keys")).keys.canSave,
      false,
    );
    const refused = await call("POST", "/settings/exchange-keys", {
      kind: "hmac",
      apiKey: savedKey,
      secretKey: savedSecret,
    });
    assert.equal(refused.change.result, "unavailable");
    assert.match(refused.change.message, /CREDENTIALS_MASTER_KEY/);
    await call("GET", "/snapshot");
    assert.equal(fake.keys.at(-1), envKey);
  });

  test("risk limits change by version, within the platform maximums", async (t) => {
    const { call } = await serve(t);
    const ticketBefore = await call("GET", "/orders/ticket");
    assert.match(ticketBefore.disabled, /Risk limits/);
    const initial = await call("GET", "/settings/risk-limits");
    assert.equal(initial.limits.current, null);
    assert.deepEqual(initial.limits.platformMaximums, {
      maxOrderNotional: "1000",
      maxDailyRisk: "1000",
      defaultStopLossPercent: "50",
    });
    const limits = {
      maxOrderNotional: "150",
      maxDailyRisk: "25",
      defaultStopLossPercent: "1.5",
    };
    const over = await call("POST", "/settings/risk-limits", {
      ...limits,
      maxDailyRisk: "1500",
      baseVersion: 0,
    });
    assert.equal(over.change.result, "invalid");
    assert.match(over.change.message, /at most 1000 USDT/);
    const saved = await call("POST", "/settings/risk-limits", {
      ...limits,
      baseVersion: 0,
    });
    assert.equal(saved.change.result, "saved");
    assert.equal(saved.change.limits.current.version, 1);
    assert.match(saved.change.message, /applies to orders placed from now on/);
    const stale = await call("POST", "/settings/risk-limits", {
      ...limits,
      baseVersion: 0,
    });
    assert.equal(stale.change.result, "conflict");
    assert.deepEqual(
      (await call("GET", "/settings/risk-limits")).limits.current,
      {
        ...limits,
        version: 1,
        createdAt: saved.change.limits.current.createdAt,
      },
    );
  });

  test("the webhook is saved masked, tested, and the customer's notifications are listed", async (t) => {
    const { call, responses, webhookCalls } = await serve(t);
    const invalid = await call("POST", "/settings/webhook", {
      url: "http://discord.com/api/webhooks/1/2",
    });
    assert.equal(invalid.change.result, "invalid");
    const saved = await call("POST", "/settings/webhook", { url: discord });
    assert.equal(saved.change.result, "saved");
    assert.equal(saved.change.status.webhook.last4, "wxyz");
    assert.equal(
      (await call("GET", "/settings/webhook")).webhook.webhook.kind,
      "discord",
    );
    const tested = await call("POST", "/settings/webhook/test");
    assert.equal(tested.test.result, "delivered");
    assert.deepEqual(webhookCalls, [discord]);
    assert.doesNotMatch(responses.join("\n"), /TTTTTTTT/);

    await database.admin`
      insert into notifications (customer_id, kind, severity, title, body)
      values (${DEV_CUSTOMER_ID}, 'order_unknown', 'warning', 'Order outcome unknown', 'Check it.')
    `;
    const listed = await call("GET", "/notifications");
    assert.equal(listed.notifications[0].title, "Order outcome unknown");
    assert.equal(listed.notifications[0].readAt, null);
    await call("POST", "/notifications/read");
    assert.ok((await call("GET", "/notifications")).notifications[0].readAt);
    assert.equal(
      (await call("DELETE", "/settings/webhook")).change.status.webhook,
      null,
    );

    // Another customer sees none of it, and has no exchange account here.
    const stranger = randomUUID();
    await database.admin`insert into customers (id, display_name) values (${stranger}, 'Stranger')`;
    assert.deepEqual(
      (await call("GET", "/notifications", undefined, stranger)).notifications,
      [],
    );
    assert.equal(
      (await call("GET", "/settings/exchange-keys", undefined, stranger))
        .reason,
      "exchange_account",
    );
    assert.equal(
      (await call("GET", "/settings/risk-limits", undefined, stranger)).reason,
      "exchange_account",
    );
  });
});
