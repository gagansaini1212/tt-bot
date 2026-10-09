import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, describe, test, type TestContext } from "node:test";
import {
  DEV_CUSTOMER_ID,
  DEV_EXCHANGE_ACCOUNT_ID,
} from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  seedDevelopment,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import {
  BinanceSpotTestnet,
  binanceSpotTestnetVenue,
  VenueRegistry,
  type KeyPermissions,
} from "@crypto-trading/exchanges";
import { accountResolver, accountVenue } from "./accounts";
import { ExchangeAccountStore } from "./exchange-accounts";
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

  async function serve(
    t: TestContext,
    {
      locked = false,
      permissions,
    }: {
      locked?: boolean;
      // What new keys may do, as the venue would report it.
      permissions?: () => Promise<KeyPermissions | null>;
    } = {},
  ) {
    const box = locked ? undefined : new SecretBox(randomBytes(32));
    const fake = binance();
    const db = database.app;
    const keys = new ExchangeCredentialStore(db, box);
    const exchanges = savedOrEnvironmentExchanges({
      store: keys,
      registry: new VenueRegistry([
        binanceSpotTestnetVenue({ fetch: fake.fetch }),
      ]),
      venueOf: accountVenue(db),
      environment: { kind: "hmac", apiKey: envKey, secret: "env-secret" },
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
          exchangeAccounts: {
            accounts: new ExchangeAccountStore(db),
            keys,
            exchanges,
            connect: (_, saved) =>
              Object.assign(
                new BinanceSpotTestnet({ ...saved, fetch: fake.fetch }),
                permissions ? { getKeyPermissions: permissions } : {},
              ),
            environmentKeys: { keyType: "hmac", apiKeyLast4: envKey.slice(-4) },
          },
          settings: {
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
          "X-Exchange-Account-Id": DEV_EXCHANGE_ACCOUNT_ID,
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

  const DEV_ACCOUNT = DEV_EXCHANGE_ACCOUNT_ID;
  const hmac = (apiKey = savedKey, secretKey = savedSecret) => ({
    kind: "hmac",
    apiKey,
    secretKey,
  });

  test("keys are replaced, used for every account request, tested, never returned", async (t) => {
    const { call, fake, responses } = await serve(t);
    const initial = await call("GET", "/exchange-accounts");
    assert.equal(initial.exchangeAccounts.canSave, true);
    assert.equal(initial.exchangeAccounts.accounts.length, 1);
    const [dev] = initial.exchangeAccounts.accounts;
    assert.equal(dev.id, DEV_ACCOUNT);
    assert.equal(dev.venue, "binance-spot-testnet");
    assert.equal(dev.mode, "simulation");
    assert.deepEqual(dev.keys, {
      source: "environment",
      keyType: "hmac",
      apiKeyLast4: "ENV1",
      hasPassphrase: false,
      updatedAt: null,
      problem: null,
    });

    const saved = await call("POST", "/exchange-accounts/keys", {
      exchangeAccountId: DEV_ACCOUNT,
      credentials: hmac(),
    });
    assert.equal(saved.change.result, "saved");
    const [replaced] = (await call("GET", "/exchange-accounts"))
      .exchangeAccounts.accounts;
    assert.equal(replaced.keys.source, "saved");
    assert.equal(replaced.keys.apiKeyLast4, "SAVE");
    // Saving keys connects the account, which records what its venue supports.
    assert.equal(replaced.supportedFeatures.access, "trade");
    assert.ok(replaced.supportedFeaturesRefreshedAt);

    // The account's requests now carry the saved key.
    await call("GET", "/snapshot");
    assert.equal(fake.keys.at(-1), savedKey);
    const tested = await call("POST", "/exchange-accounts/test", {
      exchangeAccountId: DEV_ACCOUNT,
    });
    assert.deepEqual(tested.test, {
      result: "connected",
      source: "saved",
      canTrade: true,
      message:
        "Connected. Binance Spot Testnet accepts the keys and allows trading.",
    });
    fake.refuse(true);
    const refused = await call("POST", "/exchange-accounts/test", {
      exchangeAccountId: DEV_ACCOUNT,
    });
    assert.equal(refused.test.result, "failed");
    assert.match(refused.test.message, /refused the request \(code -2015\)/);
    fake.refuse(false);

    const invalid = await call("POST", "/exchange-accounts/keys", {
      exchangeAccountId: DEV_ACCOUNT,
      credentials: {
        kind: "private_key",
        apiKey: savedKey,
        privateKey: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`,
      },
    });
    assert.equal(invalid.change.result, "invalid");
    // Binance takes no passphrase.
    const passphrase = await call("POST", "/exchange-accounts/keys", {
      exchangeAccountId: DEV_ACCOUNT,
      credentials: { ...hmac(), passphrase: "correct horse" },
    });
    assert.equal(passphrase.change.result, "invalid");
    assert.match(passphrase.change.message, /no passphrase/);
    const [kept] = (await call("GET", "/exchange-accounts")).exchangeAccounts
      .accounts;
    assert.equal(kept.keys.apiKeyLast4, "SAVE");

    // No answer carried a key or secret beyond the last four characters.
    assert.doesNotMatch(
      responses.join("\n"),
      new RegExp(`${savedKey}|${savedSecret}|${envKey}|env-secret`),
    );
    const audit = await database.admin`
      select payload from audit_events where event_type like 'exchange_keys.%'
    `;
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(savedSecret));
    // The next test's worker has another master key.
    await database.admin`
      delete from exchange_credentials where exchange_account_id = ${DEV_ACCOUNT}
    `;
  });

  test("without a master key, keys cannot be saved and the .env keys keep working", async (t) => {
    const { call, fake } = await serve(t, { locked: true });
    assert.equal(
      (await call("GET", "/exchange-accounts")).exchangeAccounts.canSave,
      false,
    );
    const refused = await call("POST", "/exchange-accounts/keys", {
      exchangeAccountId: DEV_ACCOUNT,
      credentials: hmac(),
    });
    assert.equal(refused.change.result, "unavailable");
    assert.match(refused.change.message, /CREDENTIALS_MASTER_KEY/);
    await call("GET", "/snapshot");
    assert.equal(fake.keys.at(-1), envKey);
  });

  test("a customer adds, labels and removes accounts of their own", async (t) => {
    const { call, responses } = await serve(t);
    const customerId = randomUUID();
    await database.admin`insert into customers (id, display_name) values (${customerId}, 'Accounts')`;
    const as = (method: string, path: string, body?: unknown) =>
      call(method, path, body, customerId);
    const account = {
      venue: "binance-spot-testnet",
      label: "Testnet main",
      mode: "simulation",
      accountingCurrency: "USDT",
      credentials: hmac(`${"M".repeat(40)}MAIN`, "m".repeat(40)),
    };
    // Binance Spot Testnet has virtual funds, so its accounts simulate.
    const live = await as("POST", "/exchange-accounts", {
      ...account,
      mode: "live",
    });
    assert.equal(live.change.result, "invalid");
    assert.match(live.change.message, /only be simulation \(testnet\)/);

    const added = await as("POST", "/exchange-accounts", account);
    assert.equal(added.change.result, "saved");
    assert.match(added.change.message, /^Added Testnet main\./);
    // Another account with the same label, or the same keys, is refused.
    const sameLabel = await as("POST", "/exchange-accounts", {
      ...account,
      label: " testnet MAIN ",
      credentials: hmac(`${"N".repeat(40)}NEXT`, "n".repeat(40)),
    });
    assert.equal(sameLabel.change.result, "conflict");
    const sameKeys = await as("POST", "/exchange-accounts", {
      ...account,
      label: "Testnet copy",
    });
    assert.equal(sameKeys.change.result, "conflict");
    assert.match(sameKeys.change.message, /already connected/);
    // Nor may the dev customer save them for their account.
    const theirs = await call("POST", "/exchange-accounts/keys", {
      exchangeAccountId: DEV_ACCOUNT,
      credentials: account.credentials,
    });
    assert.equal(theirs.change.result, "conflict");

    const second = await as("POST", "/exchange-accounts", {
      ...account,
      label: "Testnet second",
      credentials: hmac(`${"S".repeat(40)}SCND`, "s".repeat(40)),
    });
    assert.equal(second.change.result, "saved");
    const listed = (await as("GET", "/exchange-accounts")).exchangeAccounts
      .accounts;
    assert.deepEqual(
      listed.map((item: { label: string; keys: { apiKeyLast4: string } }) => [
        item.label,
        item.keys.apiKeyLast4,
      ]),
      [
        ["Testnet main", "MAIN"],
        ["Testnet second", "SCND"],
      ],
    );
    const [main, other] = listed;
    assert.equal(main.status, "connected");
    assert.equal(main.supportedFeatures.funds, "virtual");

    const renamed = await as("POST", "/exchange-accounts/label", {
      exchangeAccountId: main.id,
      label: "Testnet primary",
    });
    assert.equal(renamed.change.result, "saved");
    const clash = await as("POST", "/exchange-accounts/label", {
      exchangeAccountId: other.id,
      label: "testnet primary",
    });
    assert.equal(clash.change.result, "conflict");

    // The dev customer cannot see, test, rename or remove them.
    assert.equal(
      (await call("GET", "/exchange-accounts")).exchangeAccounts.accounts
        .length,
      1,
    );
    for (const [path, body] of [
      ["/exchange-accounts/label", { exchangeAccountId: main.id, label: "x" }],
      ["/exchange-accounts/remove", { exchangeAccountId: main.id }],
      [
        "/exchange-accounts/keys",
        { exchangeAccountId: main.id, credentials: hmac() },
      ],
    ] as const)
      assert.equal((await call("POST", path, body)).change.result, "invalid");
    assert.equal(
      (
        await call("POST", "/exchange-accounts/test", {
          exchangeAccountId: main.id,
        })
      ).test.result,
      "failed",
    );

    const removed = await as("POST", "/exchange-accounts/remove", {
      exchangeAccountId: main.id,
    });
    assert.equal(removed.change.result, "removed");
    assert.deepEqual(
      (await as("GET", "/exchange-accounts")).exchangeAccounts.accounts.map(
        (item: { id: string }) => item.id,
      ),
      [other.id],
    );
    // Its keys are deleted, so they can connect another account.
    const [{ count }] = await database.admin<{ count: string }[]>`
      select count(*) from exchange_credentials where exchange_account_id = ${main.id}
    `;
    assert.equal(count, "0");
    const again = await as("POST", "/exchange-accounts", {
      ...account,
      label: "Testnet primary",
    });
    assert.equal(again.change.result, "saved");
    assert.doesNotMatch(
      responses.join("\n"),
      /m{40}|MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMAIN/,
    );
  });

  test("keys with more permission than the account allows are refused before they are saved", async (t) => {
    let report: KeyPermissions | null = { trade: true, withdraw: true };
    const { call } = await serve(t, { permissions: async () => report });
    const customerId = randomUUID();
    await database.admin`insert into customers (id, display_name) values (${customerId}, 'Permissions')`;
    const add = () =>
      call(
        "POST",
        "/exchange-accounts",
        {
          venue: "binance-spot-testnet",
          label: "Checked",
          mode: "simulation",
          accountingCurrency: "USDT",
          credentials: hmac(`${"P".repeat(40)}PERM`, "p".repeat(40)),
        },
        customerId,
      );
    const refused = await add();
    assert.equal(refused.change.result, "refused");
    assert.match(refused.change.message, /can withdraw funds/);
    assert.deepEqual(
      (await call("GET", "/exchange-accounts", undefined, customerId))
        .exchangeAccounts.accounts,
      [],
    );
    report = { trade: true, withdraw: false };
    assert.equal((await add()).change.result, "saved");
  });

  test("an account the product still manages things on is not removed", async (t) => {
    const { call } = await serve(t);
    const customerId = randomUUID();
    await database.admin`insert into customers (id, display_name) values (${customerId}, 'Busy')`;
    await call(
      "POST",
      "/exchange-accounts",
      {
        venue: "binance-spot-testnet",
        label: "Busy",
        mode: "simulation",
        accountingCurrency: "USDT",
        credentials: hmac(`${"B".repeat(40)}BUSY`, "b".repeat(40)),
      },
      customerId,
    );
    const [busy] = (
      await call("GET", "/exchange-accounts", undefined, customerId)
    ).exchangeAccounts.accounts;
    await database.admin`
      insert into strategies
        (customer_id, exchange_account_id, name, status, current_version)
      values (${customerId}, ${busy.id}, 'Grid', 'simulation', 1)
    `;
    const refused = await call(
      "POST",
      "/exchange-accounts/remove",
      { exchangeAccountId: busy.id },
      customerId,
    );
    assert.equal(refused.change.result, "refused");
    assert.match(
      refused.change.message,
      /^Busy still has 1 running strategy\./,
    );
    assert.equal(
      (await call("GET", "/exchange-accounts", undefined, customerId))
        .exchangeAccounts.accounts[0].keys.source,
      "saved",
    );
  });

  test("a removed account is no longer served", async (t) => {
    const { call } = await serve(t);
    const customerId = randomUUID();
    const accountId = randomUUID();
    await database.admin`insert into customers (id, display_name) values (${customerId}, 'Removed')`;
    await database.admin`
      insert into exchange_accounts
        (id, customer_id, exchange, label, mode, accounting_currency, status, disconnected_at)
      values (${accountId}, ${customerId}, 'binance-spot-testnet', 'Old', 'simulation', 'USDT', 'disconnected', now())
    `;
    assert.deepEqual(
      (await call("GET", "/exchange-accounts", undefined, customerId))
        .exchangeAccounts.accounts,
      [],
    );
    assert.equal(
      (
        await call(
          "POST",
          "/exchange-accounts/test",
          { exchangeAccountId: accountId },
          customerId,
        )
      ).test.result,
      "failed",
    );
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
    assert.deepEqual(
      (await call("GET", "/exchange-accounts", undefined, stranger))
        .exchangeAccounts.accounts,
      [],
    );
    assert.equal(
      (await call("GET", "/settings/risk-limits", undefined, stranger)).reason,
      "exchange_account",
    );
  });
});
