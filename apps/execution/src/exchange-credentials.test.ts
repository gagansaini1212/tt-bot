import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, mock, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import { BinanceSpotTestnet } from "@crypto-trading/exchanges";
import { TESTNET_EXCHANGE_ACCOUNT_ID, type AccountScope } from "./accounts";
import {
  ExchangeCredentialStore,
  prepareKeys,
  savedOrEnvironmentExchanges,
  type ExchangeKeys,
} from "./exchange-credentials";
import { SecretBox } from "./secret-box";

const apiKey = "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7JuWXYZ";
const secretKey =
  "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const pem = (type: "ed25519" | "rsa") =>
  generateKeyPairSync(type as "ed25519", {
    ...(type === "rsa" ? { modulusLength: 2048 } : {}),
  })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

test("new keys are checked and typed without contacting Binance", () => {
  const hmac = prepareKeys({ kind: "hmac", apiKey, secretKey });
  assert.ok(hmac.ok);
  assert.equal(hmac.keyType, "hmac");
  assert.deepEqual(hmac.keys, { apiKey, apiSecret: secretKey });
  for (const type of ["ed25519", "rsa"] as const) {
    const prepared = prepareKeys({
      kind: "private_key",
      apiKey,
      privateKey: `\n${pem(type)}\n\n`,
    });
    assert.ok(prepared.ok, type);
    assert.equal(prepared.keyType, type);
  }
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const refused = prepareKeys({ kind: "private_key", apiKey, privateKey: ec });
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok);
  assert.doesNotMatch(refused.message, /BEGIN|PRIVATE/);
});

describe(
  "exchange credentials in PostgreSQL",
  { skip: databaseTestsSkipped },
  () => {
    let database: MigratedTestDatabase;
    const box = new SecretBox(randomBytes(32));

    async function customer(): Promise<AccountScope> {
      const scope = {
        customerId: randomUUID(),
        exchangeAccountId: randomUUID(),
      };
      await withCustomerScope(database.app, scope.customerId, async (tx) => {
        await tx`insert into customers (id, display_name) values (${scope.customerId}, 'Test')`;
        await tx`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status)
        values (${scope.exchangeAccountId}, ${scope.customerId},
          'binance-spot-testnet', 'Testnet', 'simulation', 'USDT', 'connected')
      `;
      });
      return scope;
    }

    before(async () => {
      database = await createTestDatabase();
    });
    after(() => database?.drop());

    test("keys are sealed at rest, open for their own account only, and audited without them", async () => {
      const store = new ExchangeCredentialStore(database.app, box);
      const mine = await customer();
      const theirs = await customer();
      const info = await store.save(mine, "hmac", {
        apiKey,
        apiSecret: secretKey,
      });
      assert.deepEqual(
        { keyType: info.keyType, apiKeyLast4: info.apiKeyLast4 },
        { keyType: "hmac", apiKeyLast4: "WXYZ" },
      );
      const [row] = await database.admin<
        { encrypted_api_key: Buffer; encrypted_api_secret: Buffer }[]
      >`select * from exchange_credentials where exchange_account_id = ${mine.exchangeAccountId}`;
      const stored =
        JSON.stringify(row) +
        row.encrypted_api_key.toString("latin1") +
        row.encrypted_api_secret.toString("latin1");
      assert.doesNotMatch(stored, new RegExp(apiKey));
      assert.doesNotMatch(stored, new RegExp(secretKey));

      const saved = await store.load(mine);
      assert.deepEqual(saved?.open(), { apiKey, apiSecret: secretKey });
      assert.equal(await store.load(theirs), undefined);

      // Copied onto another account, the sealed keys do not open.
      await store.save(theirs, "hmac", {
        apiKey: "x".repeat(20),
        apiSecret: "y".repeat(20),
      });
      await database.admin`
      update exchange_credentials set
        encrypted_api_key = ${row.encrypted_api_key},
        encrypted_api_secret = ${row.encrypted_api_secret}
      where exchange_account_id = ${theirs.exchangeAccountId}
    `;
      const moved = await store.load(theirs);
      assert.throws(() => moved?.open(), /could not be opened/);

      // Another master key cannot open them either.
      const other = new ExchangeCredentialStore(
        database.app,
        new SecretBox(randomBytes(32)),
      );
      await assert.rejects(other.load(mine).then((keys) => keys?.open()));

      assert.equal(await store.remove(mine), true);
      assert.equal(await store.load(mine), undefined);
      assert.equal(await store.remove(mine), false);
      const events = await database.admin<
        { event_type: string; payload: unknown }[]
      >`
      select event_type, payload from audit_events
      where customer_id = ${mine.customerId} order by occurred_at
    `;
      assert.deepEqual(
        events.map((event) => event.event_type),
        ["exchange_keys.saved", "exchange_keys.removed"],
      );
      assert.doesNotMatch(
        JSON.stringify(events),
        new RegExp(`${apiKey}|${secretKey}`),
      );
    });

    test("without a master key, keys cannot be saved or opened", async () => {
      const mine = await customer();
      await new ExchangeCredentialStore(database.app, box).save(mine, "hmac", {
        apiKey,
        apiSecret: secretKey,
      });
      const locked = new ExchangeCredentialStore(database.app, undefined);
      assert.equal(locked.canSave, false);
      await assert.rejects(
        locked.save(mine, "hmac", { apiKey, apiSecret: secretKey }),
        /Set CREDENTIALS_MASTER_KEY/,
      );
      const saved = await locked.load(mine);
      assert.equal(saved?.apiKeyLast4, "WXYZ");
      assert.throws(() => saved?.open(), /Set CREDENTIALS_MASTER_KEY/);
    });

    test("an account uses its saved keys, else the worker's .env keys for the dev account only", async () => {
      const store = new ExchangeCredentialStore(database.app, box);
      const environment = new BinanceSpotTestnet({
        apiKey: "env-key",
        apiSecret: "env-secret",
      });
      const created: ExchangeKeys[] = [];
      const exchanges = savedOrEnvironmentExchanges({
        store,
        environment,
        market: undefined,
        create: (keys) => {
          created.push(keys);
          return new BinanceSpotTestnet(keys);
        },
      });
      const mine = await customer();
      const dev = { ...mine, exchangeAccountId: TESTNET_EXCHANGE_ACCOUNT_ID };
      // The dev account has no saved keys, so it falls back to the .env keys.
      const fallback = await exchanges.forAccount(dev);
      assert.ok("exchange" in fallback);
      assert.equal(fallback.exchange, environment);
      assert.equal(fallback.source, "environment");
      assert.deepEqual(await exchanges.forAccount(mine), {
        problem: "exchange",
      });

      await store.save(mine, "hmac", { apiKey, apiSecret: secretKey });
      const first = await exchanges.forAccount(mine);
      const second = await exchanges.forAccount(mine);
      assert.ok("exchange" in first && "exchange" in second);
      assert.equal(first.source, "saved");
      // One client per set of keys.
      assert.equal(first.exchange, second.exchange);
      assert.equal(created.length, 1);
      await store.save(mine, "hmac", {
        apiKey: `${apiKey}2`,
        apiSecret: secretKey,
      });
      const replaced = await exchanges.forAccount(mine);
      assert.ok("exchange" in replaced);
      assert.notEqual(replaced.exchange, first.exchange);
      assert.equal(created.at(-1)?.apiKey, `${apiKey}2`);

      // Saved keys that cannot be opened never fall back to other keys.
      const error = mock.method(console, "error", () => {});
      try {
        const locked = savedOrEnvironmentExchanges({
          store: new ExchangeCredentialStore(
            database.app,
            new SecretBox(randomBytes(32)),
          ),
          environment,
          market: undefined,
        });
        assert.deepEqual(await locked.forAccount(mine), {
          problem: "credentials",
        });
        assert.deepEqual(await locked.forAccount(mine), {
          problem: "credentials",
        });
        // Logged once, naming the account and never the keys.
        assert.equal(error.mock.callCount(), 1);
        const logged = String(error.mock.calls[0].arguments[0]);
        assert.match(logged, new RegExp(mine.exchangeAccountId));
        assert.doesNotMatch(logged, new RegExp(apiKey.slice(0, 20)));
      } finally {
        error.mock.restore();
      }
    });
  },
);
