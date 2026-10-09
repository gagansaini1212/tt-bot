import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import {
  DEV_EXCHANGE_ACCOUNT_ID,
  migrate,
  withCustomerScope,
} from "@crypto-trading/database";
import {
  createEmptyDatabase,
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import { MAX_EXCHANGE_ACCOUNTS, VENUES } from "@crypto-trading/exchanges";
import { accountResolver, type AccountScope } from "./accounts";
import { ExchangeAccountStore } from "./exchange-accounts";
import { ExchangeCredentialStore } from "./exchange-credentials";
import { SecretBox } from "./secret-box";

const MIGRATIONS = fileURLToPath(
  new URL("../../../packages/database/migrations/", import.meta.url),
);
const VAULT_MIGRATION = "20261009005214_exchange_account_vault.sql";
const binance = VENUES["binance-spot-testnet"];

describe("exchange accounts", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  const box = new SecretBox(randomBytes(32));
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  async function customer() {
    const customerId = randomUUID();
    await database.admin`insert into customers (id, display_name) values (${customerId}, 'Test')`;
    return customerId;
  }

  function add(
    scope: AccountScope,
    label: string,
    apiKey = `${randomUUID()}${randomUUID()}`,
  ) {
    const keys = new ExchangeCredentialStore(database.app, box);
    return new ExchangeAccountStore(database.app).add(
      scope,
      { venue: binance, label, mode: "simulation", accountingCurrency: "USDT" },
      keys.seal(scope, "hmac", { apiKey, apiSecret: "s".repeat(32) }),
    );
  }

  test("keys saved before several accounts per customer keep opening, migrated in place", async () => {
    // A database as it was before this change, with keys saved by #50.
    const directory = await mkdtemp(join(tmpdir(), "ct-migrations-"));
    const old = await createEmptyDatabase();
    try {
      for (const name of await readdir(MIGRATIONS))
        if (name.endsWith(".sql") && name !== VAULT_MIGRATION)
          await copyFile(join(MIGRATIONS, name), join(directory, name));
      await migrate(old.admin, directory);
      const scope = {
        customerId: randomUUID(),
        exchangeAccountId: randomUUID(),
      };
      const privateKey = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const context = (column: string) => [
        "exchange_credentials",
        scope.customerId,
        scope.exchangeAccountId,
        column,
      ];
      await old.admin`insert into customers (id, display_name) values (${scope.customerId}, 'Before')`;
      await old.admin`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status)
        values (${scope.exchangeAccountId}, ${scope.customerId},
          'binance-spot-testnet', 'Binance Spot Testnet', 'simulation', 'USDT', 'connected')
      `;
      await old.admin`
        insert into exchange_credentials (
          customer_id, exchange_account_id, key_type, encrypted_api_key,
          encrypted_api_secret, api_key_last4
        )
        values (
          ${scope.customerId}, ${scope.exchangeAccountId}, 'ed25519',
          ${box.seal("OLDKEY-1234", context("api_key"))},
          ${box.seal(privateKey, context("api_secret"))}, '1234'
        )
      `;

      const { applied } = await migrate(old.admin);
      assert.deepEqual(applied, [VAULT_MIGRATION]);
      const saved = await new ExchangeCredentialStore(old.admin, box).load(
        scope,
      );
      assert.equal(saved?.keyType, "ed25519");
      assert.equal(saved?.hasPassphrase, false);
      assert.deepEqual(saved?.open(), { apiKey: "OLDKEY-1234", privateKey });
      const [account] = await new ExchangeAccountStore(old.admin).list(
        scope.customerId,
      );
      assert.equal(account.label, "Binance Spot Testnet");
      assert.equal(account.status, "connected");
      assert.equal(account.supportedFeatures, null);
    } finally {
      await old.drop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an account records its venue's features, and only a read-only one may be live", async () => {
    const customerId = await customer();
    const scope = { customerId, exchangeAccountId: randomUUID() };
    assert.deepEqual(await add(scope, "Main"), { result: "added" });
    const store = new ExchangeAccountStore(database.app);
    const account = await store.get(scope);
    assert.deepEqual(account?.supportedFeatures, binance.capabilities);
    assert.ok(account?.supportedFeaturesRefreshedAt);
    const [event] = await database.admin<{ payload: unknown }[]>`
      select payload from audit_events
      where subject_id = ${scope.exchangeAccountId}
        and event_type = 'exchange_account.added'
    `;
    assert.deepEqual(event.payload, {
      venue: "binance-spot-testnet",
      label: "Main",
      mode: "simulation",
      accountingCurrency: "USDT",
    });

    const insert = (mode: string, features: object | null, label: string) =>
      withCustomerScope(
        database.app,
        customerId,
        (tx) => tx`
          insert into exchange_accounts
            (customer_id, exchange, label, mode, accounting_currency, status, supported_features)
          values (${customerId}, 'htx', ${label}, ${mode}, 'USDT', 'connected',
            ${features === null ? null : tx.json(features as never)})
        `,
      );
    // Live trading stays disabled, so a live account must be read only.
    await assert.rejects(
      insert("live", binance.capabilities, "Live trading"),
      /exchange_accounts_live_read_only/,
    );
    await assert.rejects(
      insert("live", null, "Live unknown"),
      /exchange_accounts_live_read_only/,
    );
    await insert(
      "live",
      { ...binance.capabilities, access: "read_only", funds: "real" },
      "Read only",
    );
    await assert.rejects(
      insert("simulation", null, " Untrimmed"),
      /exchange_accounts_label_check/,
    );
  });

  test("labels are unique per customer among accounts they have not removed", async () => {
    const customerId = await customer();
    const first = { customerId, exchangeAccountId: randomUUID() };
    assert.deepEqual(await add(first, "Spot"), { result: "added" });
    assert.deepEqual(
      await add({ customerId, exchangeAccountId: randomUUID() }, "SPOT"),
      { result: "label_taken" },
    );
    // Another customer may use the same label.
    assert.deepEqual(
      await add(
        { customerId: await customer(), exchangeAccountId: randomUUID() },
        "Spot",
      ),
      { result: "added" },
    );
    const store = new ExchangeAccountStore(database.app);
    assert.deepEqual(await store.remove(first), { result: "removed" });
    assert.equal(await store.get(first), undefined);
    assert.deepEqual(await store.relabel(first, "Gone"), {
      result: "not_found",
    });
    assert.deepEqual(await store.remove(first), { result: "not_found" });
    // A removed account's label is free again; its row stays.
    assert.deepEqual(
      await add({ customerId, exchangeAccountId: randomUUID() }, "Spot"),
      { result: "added" },
    );
    const [removed] = await database.admin<
      { status: string; disconnected_at: Date | null }[]
    >`select status, disconnected_at from exchange_accounts where id = ${first.exchangeAccountId}`;
    assert.equal(removed.status, "disconnected");
    assert.ok(removed.disconnected_at);
  });

  test(`a customer has at most ${MAX_EXCHANGE_ACCOUNTS} accounts`, async () => {
    const customerId = await customer();
    const results = await Promise.all(
      Array.from({ length: MAX_EXCHANGE_ACCOUNTS + 2 }, (_, index) =>
        add(
          { customerId, exchangeAccountId: randomUUID() },
          `Account ${index}`,
        ),
      ),
    );
    assert.equal(
      results.filter((result) => result.result === "added").length,
      MAX_EXCHANGE_ACCOUNTS,
    );
    assert.equal(
      results.filter((result) => result.result === "limit_reached").length,
      2,
    );
  });

  test("the worker stops serving an account once it is removed", async () => {
    const customerId = await customer();
    const scope = { customerId, exchangeAccountId: DEV_EXCHANGE_ACCOUNT_ID };
    await add(scope, "Testnet");
    const resolve = accountResolver(database.app);
    assert.deepEqual(await resolve(customerId), scope);
    assert.deepEqual(
      await new ExchangeAccountStore(database.app).remove(scope),
      {
        result: "removed",
      },
    );
    assert.equal(await resolve(customerId), undefined);
  });

  test("an account is not removed while the product still manages something on it", async () => {
    const customerId = await customer();
    const scope = { customerId, exchangeAccountId: randomUUID() };
    await add(scope, "Busy");
    const store = new ExchangeAccountStore(database.app);
    const accountId = scope.exchangeAccountId;
    const strategyId = randomUUID();
    await database.admin`
      insert into strategies
        (id, customer_id, exchange_account_id, name, status, current_version)
      values (${strategyId}, ${customerId}, ${accountId}, 'Grid', 'simulation', 1)
    `;
    await database.admin`
      insert into strategy_versions (customer_id, strategy_id, version, rules)
      values (${customerId}, ${strategyId}, 1, '{}')
    `;
    const intent = async (status: string, state?: string) => {
      const [{ id }] = await database.admin<{ id: string }[]>`
        insert into order_intents
          (customer_id, exchange_account_id, idempotency_key, status, manual_order)
        values (${customerId}, ${accountId}, ${`ct_${randomUUID().slice(0, 12)}`},
          ${status}, '{"kind": "protected_entry"}')
        returning id
      `;
      if (state)
        await database.admin`
          insert into entry_reconciliations (customer_id, order_intent_id, state)
          values (${customerId}, ${id}, ${state})
        `;
    };
    await intent("pending");
    await intent("unknown");
    await intent("acknowledged", "protected");
    await intent("acknowledged");
    // Finished entries and refused orders leave nothing open.
    await intent("acknowledged", "closed");
    await intent("rejected");
    await intent("cancelled");
    const [position] = await database.admin<{ id: string }[]>`
      insert into position_ownership
        (customer_id, exchange_account_id, strategy_id, strategy_version,
          instrument, status, first_fill_at)
      values (${customerId}, ${accountId}, ${strategyId}, 1, 'BTC-USDT', 'open', now())
      returning id
    `;
    assert.deepEqual(await store.remove(scope), {
      result: "open",
      open: { strategies: 1, positions: 1, orders: 4 },
    });

    await database.admin`update strategies set status = 'paused' where id = ${strategyId}`;
    await database.admin`update position_ownership set status = 'closed' where id = ${position.id}`;
    await database.admin`
      update order_intents set status = 'cancelled'
      where exchange_account_id = ${accountId} and status in ('pending', 'unknown')
    `;
    await database.admin`
      update entry_reconciliations set state = 'closed'
      where customer_id = ${customerId}
    `;
    assert.deepEqual(await store.remove(scope), {
      result: "open",
      open: { strategies: 0, positions: 0, orders: 1 },
    });
    await database.admin`
      insert into entry_reconciliations (customer_id, order_intent_id, state)
      select customer_id, id, 'not_filled' from order_intents i
      where exchange_account_id = ${accountId}
        and not exists (select from entry_reconciliations r where r.order_intent_id = i.id)
    `;
    // A paused strategy that holds nothing does not keep the account.
    assert.deepEqual(await store.remove(scope), { result: "removed" });
    assert.equal(
      await new ExchangeCredentialStore(database.app, box).load(scope),
      undefined,
    );
  });
});
