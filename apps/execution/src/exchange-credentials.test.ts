import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, mock, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import {
  BinanceSpotTestnet,
  binanceSpotTestnetVenue,
  ExchangeError,
  VENUES,
  VenueRegistry,
  type AccountReader,
  type KeyPermissions,
  type SigningCredentials,
  type Venue,
} from "@crypto-trading/exchanges";
import {
  accountVenue,
  TESTNET_EXCHANGE_ACCOUNT_ID,
  type AccountScope,
} from "./accounts";
import {
  checkKeyPermissions,
  ExchangeCredentialStore,
  KeysInUseError,
  NoAdapterError,
  prepareCredentials,
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

const binance = VENUES["binance-spot-testnet"];
// A venue whose keys come with a passphrase and may sign JWTs, and one the
// product only reads, made from Binance's descriptor for these tests.
const passphraseVenue: Venue = {
  ...binance,
  name: "Passphrase venue",
  credentials: { keyTypes: ["hmac", "es256"], passphrase: true },
};
const readOnlyVenue: Venue = {
  ...binance,
  name: "Read-only venue",
  capabilities: {
    ...binance.capabilities,
    access: "read_only",
    funds: "real",
    orderTypes: [],
    orderLists: [],
    attachedExits: null,
    stopOrders: "none",
  },
};
const es256 = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

test("new keys must suit their venue: its key types, and a passphrase only where it needs one", () => {
  const connected: ExchangeKeys[] = [];
  const connect = (_: string, keys: ExchangeKeys) => {
    connected.push(keys);
    return {} as AccountReader;
  };
  const refused = prepareCredentials(
    binance,
    { kind: "private_key", apiKey, privateKey: es256() },
    connect,
  );
  assert.ok(!refused.ok);
  assert.match(refused.message, /does not accept ES256 \(P-256\) keys/);
  const noPassphrase = prepareCredentials(
    passphraseVenue,
    { kind: "hmac", apiKey, secretKey },
    connect,
  );
  assert.ok(!noPassphrase.ok);
  assert.match(noPassphrase.message, /come with a passphrase/);
  const unwanted = prepareCredentials(
    binance,
    { kind: "hmac", apiKey, secretKey, passphrase: "secret phrase" },
    connect,
  );
  assert.ok(!unwanted.ok);
  assert.match(unwanted.message, /have no passphrase/);
  assert.equal(connected.length, 0);

  const jwt = prepareCredentials(
    passphraseVenue,
    {
      kind: "private_key",
      apiKey,
      privateKey: es256(),
      passphrase: " spaces kept ",
    },
    connect,
  );
  assert.ok(jwt.ok);
  assert.equal(jwt.keyType, "es256");
  assert.equal(jwt.keys.passphrase, " spaces kept ");
  assert.equal(connected.length, 1);
  // An adapter that cannot sign with the keys refuses them.
  const unsignable = prepareCredentials(
    binance,
    { kind: "hmac", apiKey, secretKey },
    () => {
      throw new Error("bad keys");
    },
  );
  assert.ok(!unsignable.ok);
  assert.doesNotMatch(unsignable.message, new RegExp(secretKey));
  const noAdapter = prepareCredentials(
    binance,
    { kind: "hmac", apiKey, secretKey },
    (venue) => {
      throw new NoAdapterError(venue);
    },
  );
  assert.ok(!noAdapter.ok);
  assert.match(noAdapter.message, /no Binance Spot Testnet adapter yet/);
});

test("keys that can do more than their account allows are refused", async () => {
  const reader = (report: () => Promise<KeyPermissions | null>) =>
    ({ getKeyPermissions: report }) as unknown as AccountReader;
  const answer = (permissions: KeyPermissions | null) =>
    reader(async () => permissions);

  // A read-only account's keys may neither trade nor withdraw.
  const trading = await checkKeyPermissions(
    readOnlyVenue,
    answer({ trade: true, withdraw: false }),
  );
  assert.equal(trading.result, "refused");
  assert.ok(trading.result === "refused");
  assert.match(
    trading.message,
    /can trade\. Read-only venue accounts are read only/,
  );
  assert.deepEqual(
    await checkKeyPermissions(
      readOnlyVenue,
      answer({ trade: false, withdraw: false }),
    ),
    { result: "allowed", verified: true },
  );
  // A venue that cannot report a key's permissions leaves them unverified.
  assert.deepEqual(await checkKeyPermissions(readOnlyVenue, answer(null)), {
    result: "allowed",
    verified: false,
  });
  assert.deepEqual(
    await checkKeyPermissions(readOnlyVenue, {} as AccountReader),
    { result: "allowed", verified: false },
  );

  // A trading account's keys may trade, but never withdraw.
  assert.deepEqual(
    await checkKeyPermissions(
      binance,
      answer({ trade: true, withdraw: false }),
    ),
    { result: "allowed", verified: true },
  );
  const withdrawing = await checkKeyPermissions(
    binance,
    answer({ trade: true, withdraw: true }),
  );
  assert.ok(withdrawing.result === "refused");
  assert.match(withdrawing.message, /can withdraw funds/);

  // Keys whose permissions cannot be read are not used.
  const rejected = await checkKeyPermissions(
    readOnlyVenue,
    reader(async () => {
      throw new ExchangeError("rejected", {
        venue: "binance-spot-testnet",
        code: 2002,
      });
    }),
  );
  assert.ok(rejected.result === "failed");
  assert.match(rejected.message, /refused these keys \(code 2002\)/);
  const unreachable = await checkKeyPermissions(
    readOnlyVenue,
    reader(async () => {
      throw new ExchangeError("unavailable", { venue: "binance-spot-testnet" });
    }),
  );
  assert.equal(unreachable.result, "failed");
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

    test("a passphrase and an ES256 key are sealed like the rest, and one API key belongs to one account", async () => {
      const store = new ExchangeCredentialStore(database.app, box);
      const mine = await customer();
      const pem = es256();
      const keys = {
        apiKey: `${apiKey}JWT`,
        privateKey: pem,
        passphrase: "correct horse battery",
      };
      const info = await store.save(mine, "es256", keys);
      assert.equal(info.hasPassphrase, true);
      const saved = await store.load(mine);
      assert.equal(saved?.keyType, "es256");
      assert.equal(saved?.hasPassphrase, true);
      assert.deepEqual(saved?.open(), keys);
      const [row] = await database.admin<
        {
          encrypted_passphrase: Buffer;
          encrypted_api_secret: Buffer;
          api_key_fingerprint: Buffer;
        }[]
      >`select * from exchange_credentials where exchange_account_id = ${mine.exchangeAccountId}`;
      assert.doesNotMatch(
        row.encrypted_passphrase.toString("latin1") +
          row.encrypted_api_secret.toString("latin1"),
        /correct horse|PRIVATE KEY/,
      );
      assert.equal(row.api_key_fingerprint.length, 32);

      // The same keys cannot be saved for another account, any customer's.
      const theirs = await customer();
      await assert.rejects(store.save(theirs, "es256", keys), KeysInUseError);
      assert.equal(await store.load(theirs), undefined);
      // The API key alone, with another secret, claims nothing.
      await store.save(theirs, "es256", { ...keys, privateKey: es256() });
      await store.remove(theirs);
      // Replacing an account's keys with the same key is no conflict.
      await store.save(mine, "es256", { ...keys, passphrase: "another one" });
      assert.equal((await store.load(mine))?.open().passphrase, "another one");

      // A passphrase copied onto another account does not open there.
      await store.save(theirs, "hmac", {
        apiKey: `${apiKey}OTHER`,
        apiSecret: secretKey,
        passphrase: "theirs",
      });
      await database.admin`
        update exchange_credentials set encrypted_passphrase = ${row.encrypted_passphrase}
        where exchange_account_id = ${theirs.exchangeAccountId}
      `;
      await assert.rejects(
        store.load(theirs).then((moved) => moved?.open()),
        /could not be opened/,
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
      const environment: SigningCredentials = {
        kind: "hmac",
        apiKey: "env-key",
        secret: "env-secret",
      };
      const binance = binanceSpotTestnetVenue();
      const created: SigningCredentials[] = [];
      // Each client built records what its venue supports.
      const refreshed: string[] = [];
      const registry = new VenueRegistry([
        {
          ...binance,
          connect: (credentials) => {
            created.push(credentials);
            return binance.connect(credentials);
          },
        },
      ]);
      const exchanges = savedOrEnvironmentExchanges({
        store,
        registry,
        // The dev account is on Binance Spot Testnet, like every account here.
        venueOf: async () => "binance-spot-testnet",
        environment,
        connected: async (account, venue) => {
          refreshed.push(`${account.exchangeAccountId}:${venue.id}`);
        },
      });
      const mine = await customer();
      const dev = { ...mine, exchangeAccountId: TESTNET_EXCHANGE_ACCOUNT_ID };
      // The dev account has no saved keys, so it falls back to the .env keys.
      const fallback = await exchanges.forAccount(dev);
      assert.ok("exchange" in fallback);
      assert.equal(fallback.source, "environment");
      assert.deepEqual(created, [environment]);
      const again = await exchanges.forAccount(dev);
      assert.ok("exchange" in again);
      assert.equal(again.exchange, fallback.exchange);
      assert.deepEqual(await exchanges.forAccount(mine), {
        problem: "exchange",
      });

      // Each API key belongs to one account, so this test has its own.
      const ownKey = `${apiKey}A`;
      await store.save(mine, "hmac", { apiKey: ownKey, apiSecret: secretKey });
      const first = await exchanges.forAccount(mine);
      const second = await exchanges.forAccount(mine);
      assert.ok("exchange" in first && "exchange" in second);
      assert.equal(first.source, "saved");
      // One client per set of keys.
      assert.equal(first.exchange, second.exchange);
      assert.equal(created.length, 2);
      await store.save(mine, "hmac", {
        apiKey: `${ownKey}2`,
        apiSecret: secretKey,
      });
      const replaced = await exchanges.forAccount(mine);
      assert.ok("exchange" in replaced);
      assert.notEqual(replaced.exchange, first.exchange);
      assert.equal(created.at(-1)?.apiKey, `${ownKey}2`);
      assert.equal(first.exchange.venue, "binance-spot-testnet");
      assert.equal(refreshed.length, created.length);
      assert.equal(
        refreshed.at(-1),
        `${mine.exchangeAccountId}:binance-spot-testnet`,
      );

      // Saved keys that cannot be opened never fall back to other keys.
      const error = mock.method(console, "error", () => {});
      try {
        const locked = savedOrEnvironmentExchanges({
          store: new ExchangeCredentialStore(
            database.app,
            new SecretBox(randomBytes(32)),
          ),
          registry,
          venueOf: accountVenue(database.app),
          environment,
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
