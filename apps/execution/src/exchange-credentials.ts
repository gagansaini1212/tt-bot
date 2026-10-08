import { createPrivateKey } from "node:crypto";
import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  BinanceSpotTestnet,
  type ExchangeKeyType,
  type ExchangeKeysRequest,
} from "@crypto-trading/exchanges";
import { TESTNET_EXCHANGE_ACCOUNT_ID, type AccountScope } from "./accounts";
import { MASTER_KEY_VARIABLE, type SecretBox } from "./secret-box";

/** Keys as the Binance adapter takes them. Never log or return them. */
export type ExchangeKeys = {
  apiKey: string;
  apiSecret?: string;
  privateKey?: string;
};

/** What the Settings page may see of saved keys. */
export type SavedKeysInfo = {
  keyType: ExchangeKeyType;
  apiKeyLast4: string;
  updatedAt: Date;
};

/**
 * Saved keys for one exchange account. `open` decrypts them and throws if
 * they cannot be opened, such as without the master key that sealed them.
 * `version` changes whenever the keys do.
 */
export type SavedKeys = SavedKeysInfo & {
  version: string;
  open(): ExchangeKeys;
};

/**
 * Checks new keys and says what kind they are, without contacting Binance.
 * Messages never repeat the keys.
 */
export function prepareKeys(
  request: ExchangeKeysRequest,
):
  | { ok: true; keyType: ExchangeKeyType; keys: ExchangeKeys }
  | { ok: false; message: string } {
  const keys: ExchangeKeys =
    request.kind === "hmac"
      ? { apiKey: request.apiKey, apiSecret: request.secretKey }
      : {
          apiKey: request.apiKey,
          privateKey: request.privateKey.trim() + "\n",
        };
  try {
    // The adapter refuses keys it cannot sign with.
    new BinanceSpotTestnet(keys);
  } catch {
    return {
      ok: false,
      message:
        request.kind === "hmac"
          ? "Check the API key and secret key."
          : "The private key must be an unencrypted Ed25519 or RSA PEM key, and RSA keys must have at least 2048 bits.",
    };
  }
  if (request.kind === "hmac") return { ok: true, keyType: "hmac", keys };
  return { ok: true, keyType: privateKeyType(keys.privateKey!), keys };
}

/** The key type of a PEM private key the Binance adapter accepted. */
export function privateKeyType(pem: string): "ed25519" | "rsa" {
  return createPrivateKey(pem).asymmetricKeyType === "rsa" ? "rsa" : "ed25519";
}

// The associated data binding each sealed column to its account.
function context(scope: AccountScope, column: string) {
  return [
    "exchange_credentials",
    scope.customerId,
    scope.exchangeAccountId,
    column,
  ];
}

type Row = {
  id: string;
  key_type: ExchangeKeyType;
  encrypted_api_key: Buffer;
  encrypted_api_secret: Buffer;
  api_key_last4: string;
  updated_at: Date;
};

/**
 * Exchange accounts' API keys in PostgreSQL, sealed with the master key. Only
 * the last four characters of the API key are stored in the clear. Changes
 * are audited without the keys.
 */
export class ExchangeCredentialStore {
  readonly #database: Database;
  readonly #box: SecretBox | undefined;

  constructor(database: Database, box: SecretBox | undefined) {
    this.#database = database;
    this.#box = box;
  }

  /** False without a master key: keys can then be neither saved nor read. */
  get canSave() {
    return this.#box !== undefined;
  }

  #scoped<T>(scope: AccountScope, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, scope.customerId, work);
  }

  async load(scope: AccountScope): Promise<SavedKeys | undefined> {
    const [row] = await this.#scoped(
      scope,
      (tx) => tx<Row[]>`
        select id, key_type, encrypted_api_key, encrypted_api_secret,
          api_key_last4, updated_at
        from exchange_credentials
        where exchange_account_id = ${scope.exchangeAccountId}
      `,
    );
    if (!row) return undefined;
    const box = this.#box;
    return {
      keyType: row.key_type,
      apiKeyLast4: row.api_key_last4,
      updatedAt: row.updated_at,
      version: `${row.id}:${row.updated_at.toISOString()}`,
      open: () => {
        if (!box)
          throw new Error(
            `Set ${MASTER_KEY_VARIABLE} to open saved exchange keys.`,
          );
        const apiKey = box.open(
          row.encrypted_api_key,
          context(scope, "api_key"),
        );
        const secret = box.open(
          row.encrypted_api_secret,
          context(scope, "api_secret"),
        );
        return row.key_type === "hmac"
          ? { apiKey, apiSecret: secret }
          : { apiKey, privateKey: secret };
      },
    };
  }

  /** Replaces the account's keys. Requires a master key. */
  async save(
    scope: AccountScope,
    keyType: ExchangeKeyType,
    keys: ExchangeKeys,
  ): Promise<SavedKeysInfo> {
    const box = this.#box;
    if (!box)
      throw new Error(`Set ${MASTER_KEY_VARIABLE} to save exchange keys.`);
    const secret = keys.apiSecret ?? keys.privateKey;
    if (!secret) throw new Error("Exchange keys need a secret or private key.");
    const sealedKey = box.seal(keys.apiKey, context(scope, "api_key"));
    const sealedSecret = box.seal(secret, context(scope, "api_secret"));
    const last4 = keys.apiKey.slice(-4);
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<{ id: string; updated_at: Date }[]>`
        insert into exchange_credentials (
          customer_id, exchange_account_id, key_type, encrypted_api_key,
          encrypted_api_secret, api_key_last4
        )
        values (
          ${scope.customerId}, ${scope.exchangeAccountId}, ${keyType},
          ${sealedKey}, ${sealedSecret}, ${last4}
        )
        on conflict (exchange_account_id) do update set
          key_type = excluded.key_type,
          encrypted_api_key = excluded.encrypted_api_key,
          encrypted_api_secret = excluded.encrypted_api_secret,
          encrypted_passphrase = null,
          api_key_last4 = excluded.api_key_last4,
          updated_at = now()
        returning id, updated_at
      `;
      await audit(tx, scope, row.id, "exchange_keys.saved", {
        keyType,
        apiKeyLast4: last4,
      });
      return { keyType, apiKeyLast4: last4, updatedAt: row.updated_at };
    });
  }

  /** Deletes the account's keys. Resolves false if there were none. */
  remove(scope: AccountScope): Promise<boolean> {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<
        { id: string; api_key_last4: string; key_type: string }[]
      >`
        delete from exchange_credentials
        where exchange_account_id = ${scope.exchangeAccountId}
        returning id, api_key_last4, key_type
      `;
      if (!row) return false;
      await audit(tx, scope, row.id, "exchange_keys.removed", {
        keyType: row.key_type,
        apiKeyLast4: row.api_key_last4,
      });
      return true;
    });
  }
}

function audit(
  tx: Transaction,
  scope: AccountScope,
  subjectId: string,
  eventType: string,
  payload: Record<string, string>,
) {
  return tx`
    insert into audit_events
      (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
    values (
      ${scope.customerId}, 'customer', ${scope.customerId}, ${eventType},
      'exchange_credentials', ${subjectId},
      ${tx.json({ exchangeAccountId: scope.exchangeAccountId, ...payload })}
    )
  `;
}

/**
 * The exchange client for an account, or why there is none:
 * - exchange: the account has no keys, saved or in the worker's .env.
 * - credentials: it has saved keys the worker cannot open.
 */
export type ExchangeLookup =
  | { exchange: BinanceSpotTestnet; source: "saved" | "environment" }
  | { problem: "exchange" | "credentials" };

/** Which Binance client serves each request. */
export interface ExchangeSource {
  /** For public market data, which needs no customer or keys. */
  market(): BinanceSpotTestnet | undefined;
  /** Throws if the database cannot answer. */
  forAccount(account: AccountScope): Promise<ExchangeLookup>;
  /** Drops what is cached for `account`, after its keys change. */
  forget(account: AccountScope): void;
}

/**
 * Serves each account with its saved keys. An account without saved keys
 * falls back to the worker's .env keys, which belong to the dev customer's
 * testnet account only. Saved keys that cannot be opened never fall back:
 * the worker would trade with keys the customer did not choose.
 */
export function savedOrEnvironmentExchanges({
  store,
  environment,
  market,
  create = (keys) => new BinanceSpotTestnet(keys),
}: {
  store: Pick<ExchangeCredentialStore, "load">;
  environment: BinanceSpotTestnet | undefined;
  market: BinanceSpotTestnet | undefined;
  create?: (keys: ExchangeKeys) => BinanceSpotTestnet;
}): ExchangeSource {
  // One client per set of keys, so its clock sync and rate-limit state last.
  const clients = new Map<
    string,
    { version: string; exchange: BinanceSpotTestnet }
  >();
  let lastLogged: string | undefined;
  return {
    market: () => market,
    async forAccount(account) {
      const saved = await store.load(account);
      if (!saved) {
        clients.delete(account.exchangeAccountId);
        return environment &&
          account.exchangeAccountId === TESTNET_EXCHANGE_ACCOUNT_ID
          ? { exchange: environment, source: "environment" }
          : { problem: "exchange" };
      }
      const cached = clients.get(account.exchangeAccountId);
      if (cached?.version === saved.version)
        return { exchange: cached.exchange, source: "saved" };
      try {
        const exchange = create(saved.open());
        clients.set(account.exchangeAccountId, {
          version: saved.version,
          exchange,
        });
        lastLogged = undefined;
        return { exchange, source: "saved" };
      } catch {
        // Says which account, never anything about the keys.
        const message = `The saved exchange keys of account ${account.exchangeAccountId} cannot be opened. Check ${MASTER_KEY_VARIABLE}.`;
        if (message !== lastLogged) console.error(message);
        lastLogged = message;
        return { problem: "credentials" };
      }
    },
    forget(account) {
      clients.delete(account.exchangeAccountId);
    },
  };
}
