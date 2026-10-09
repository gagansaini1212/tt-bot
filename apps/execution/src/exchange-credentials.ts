import { createPrivateKey } from "node:crypto";
import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  BinanceSpotTestnet,
  ExchangeError,
  excessKeyPermissions,
  VENUES,
  type AccountReader,
  type ExchangeKeyType,
  type ExchangeKeysRequest,
  type Venue,
  type VenueId,
} from "@crypto-trading/exchanges";
import { TESTNET_EXCHANGE_ACCOUNT_ID, type AccountScope } from "./accounts";
import { MASTER_KEY_VARIABLE, type SecretBox } from "./secret-box";

/**
 * Keys as venue adapters take them: an API key with an HMAC secret
 * (`apiSecret`) or a PEM private key (`privateKey`), and a passphrase where
 * the venue needs one. Never log or return them.
 */
export type ExchangeKeys = {
  apiKey: string;
  apiSecret?: string;
  privateKey?: string;
  passphrase?: string;
};

/** What the Settings page may see of saved keys. */
export type SavedKeysInfo = {
  keyType: ExchangeKeyType;
  apiKeyLast4: string;
  hasPassphrase: boolean;
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
 * Builds a venue's adapter for an account's keys, without contacting the
 * venue. Throws for keys the adapter cannot sign with.
 */
export type VenueConnector = (
  venue: VenueId,
  keys: ExchangeKeys,
) => AccountReader;

const KEY_TYPE_NAMES: Record<ExchangeKeyType, string> = {
  hmac: "HMAC secret",
  ed25519: "Ed25519",
  rsa: "RSA",
  es256: "ES256 (P-256)",
};

export type PreparedKeys =
  | {
      ok: true;
      keyType: ExchangeKeyType;
      keys: ExchangeKeys;
      // The venue's adapter for the keys, to ask what they may do.
      reader: AccountReader;
    }
  | { ok: false; message: string };

/**
 * Checks new keys against `venue` and says what kind they are, without
 * contacting it: a key type the venue accepts, a passphrase exactly when it
 * needs one, and keys its adapter can sign with. Messages never repeat the
 * keys.
 */
export function prepareCredentials(
  venue: Venue,
  request: ExchangeKeysRequest,
  connect: VenueConnector,
): PreparedKeys {
  const invalid = (message: string) => ({ ok: false as const, message });
  const accepted = venue.credentials.keyTypes;
  const privateKeyHelp = `The private key must be an unencrypted ${accepted
    .filter((type) => type !== "hmac")
    .map((type) => KEY_TYPE_NAMES[type])
    .join(" or ")} PEM key, and RSA keys must have at least 2048 bits.`;
  let keyType: ExchangeKeyType;
  try {
    keyType =
      request.kind === "hmac" ? "hmac" : privateKeyType(request.privateKey);
  } catch {
    return invalid(privateKeyHelp);
  }
  if (!accepted.includes(keyType))
    return invalid(
      `${venue.name} does not accept ${KEY_TYPE_NAMES[keyType]} keys. Use ${accepted.map((type) => KEY_TYPE_NAMES[type]).join(", ")}.`,
    );
  if (venue.credentials.passphrase && !request.passphrase)
    return invalid(
      `${venue.name} keys come with a passphrase. Enter it with the key.`,
    );
  if (!venue.credentials.passphrase && request.passphrase !== undefined)
    return invalid(`${venue.name} keys have no passphrase. Leave it empty.`);
  const keys: ExchangeKeys =
    request.kind === "hmac"
      ? { apiKey: request.apiKey, apiSecret: request.secretKey }
      : {
          apiKey: request.apiKey,
          privateKey: request.privateKey.trim() + "\n",
        };
  if (request.passphrase !== undefined) keys.passphrase = request.passphrase;
  try {
    // The adapter refuses keys it cannot sign with.
    return { ok: true, keyType, keys, reader: connect(venue.id, keys) };
  } catch {
    return invalid(
      request.kind === "hmac"
        ? "Check the API key and secret key."
        : privateKeyHelp,
    );
  }
}

/**
 * Checks new Binance Spot Testnet keys and says what kind they are, without
 * contacting Binance. Messages never repeat the keys.
 */
export function prepareKeys(
  request: ExchangeKeysRequest,
):
  | { ok: true; keyType: ExchangeKeyType; keys: ExchangeKeys }
  | { ok: false; message: string } {
  const prepared = prepareCredentials(
    VENUES["binance-spot-testnet"],
    request,
    (_, keys) => new BinanceSpotTestnet(keys),
  );
  if (!prepared.ok) return prepared;
  const { keyType, keys } = prepared;
  return { ok: true, keyType, keys };
}

/**
 * The key type of a PEM private key: Ed25519, RSA, or P-256 for ES256.
 * Throws for anything else.
 */
export function privateKeyType(pem: string): "ed25519" | "rsa" | "es256" {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType === "ed25519") return "ed25519";
  if (key.asymmetricKeyType === "rsa") return "rsa";
  if (
    key.asymmetricKeyType === "ec" &&
    key.asymmetricKeyDetails?.namedCurve === "prime256v1"
  )
    return "es256";
  throw new Error("Unsupported private key type.");
}

/**
 * What the venue says new or saved keys may do:
 * - allowed: within what the account allows. `verified` is false when the
 *   venue cannot say, such as for a venue without a permission report.
 * - refused: the keys can do more than the account allows (ADR 0009 §4).
 * - failed: the venue could not be asked, so the keys are not used.
 */
export type PermissionCheck =
  | { result: "allowed"; verified: boolean }
  | { result: "refused" | "failed"; message: string };

/** Asks the venue what the keys may do, where its adapter can. */
export async function checkKeyPermissions(
  venue: Venue,
  reader: AccountReader,
): Promise<PermissionCheck> {
  if (!reader.getKeyPermissions) return { result: "allowed", verified: false };
  let permissions;
  try {
    permissions = await reader.getKeyPermissions();
  } catch (error) {
    return {
      result: "failed",
      message:
        error instanceof ExchangeError && error.kind === "rejected"
          ? `${venue.name} refused these keys${error.code === undefined ? "" : ` (code ${error.code})`}. Check the API key, its secret and any IP restriction on the key.`
          : `${venue.name} could not be asked what these keys may do. Try again shortly.`,
    };
  }
  if (!permissions) return { result: "allowed", verified: false };
  const excess = excessKeyPermissions(venue, permissions);
  if (!excess.length) return { result: "allowed", verified: true };
  return {
    result: "refused",
    message: excess.includes("trade")
      ? `These keys can ${excess.join(" and ")}. ${venue.name} accounts are read only here: create a key with read permission only, then try again.`
      : "These keys can withdraw funds. Create a key without withdraw permission, then try again.",
  };
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
// API keys are fingerprinted without their account, so one key cannot be
// saved for two accounts.
const FINGERPRINT_CONTEXT = ["exchange_credentials", "api_key"];

/** Keys sealed for one account, ready to write with `writeSealedKeys`. */
export type SealedKeys = {
  keyType: ExchangeKeyType;
  apiKey: Buffer;
  secret: Buffer;
  passphrase: Buffer | null;
  fingerprint: Buffer;
  apiKeyLast4: string;
};

type Row = {
  id: string;
  key_type: ExchangeKeyType;
  encrypted_api_key: Buffer;
  encrypted_api_secret: Buffer;
  encrypted_passphrase: Buffer | null;
  api_key_last4: string;
  updated_at: Date;
};

/**
 * Exchange accounts' API keys in PostgreSQL, sealed with the master key:
 * the API key, the secret or private key, and the passphrase if there is
 * one. Only the last four characters of the API key are stored in the
 * clear, with a keyed fingerprint of it. Changes are audited without the
 * keys.
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
          encrypted_passphrase, api_key_last4, updated_at
        from exchange_credentials
        where exchange_account_id = ${scope.exchangeAccountId}
      `,
    );
    if (!row) return undefined;
    const box = this.#box;
    return {
      keyType: row.key_type,
      apiKeyLast4: row.api_key_last4,
      hasPassphrase: row.encrypted_passphrase !== null,
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
        const keys: ExchangeKeys =
          row.key_type === "hmac"
            ? { apiKey, apiSecret: secret }
            : { apiKey, privateKey: secret };
        if (row.encrypted_passphrase)
          keys.passphrase = box.open(
            row.encrypted_passphrase,
            context(scope, "passphrase"),
          );
        return keys;
      },
    };
  }

  /**
   * Seals keys for the account, each part with a fresh nonce, to be written
   * with `writeSealedKeys`. Requires a master key.
   */
  seal(
    scope: AccountScope,
    keyType: ExchangeKeyType,
    keys: ExchangeKeys,
  ): SealedKeys {
    const box = this.#box;
    if (!box)
      throw new Error(`Set ${MASTER_KEY_VARIABLE} to save exchange keys.`);
    const secret = keyType === "hmac" ? keys.apiSecret : keys.privateKey;
    if (!secret)
      throw new Error(
        keyType === "hmac"
          ? "HMAC keys need a secret."
          : "Exchange keys of this type need a private key.",
      );
    return {
      keyType,
      apiKey: box.seal(keys.apiKey, context(scope, "api_key")),
      secret: box.seal(secret, context(scope, "api_secret")),
      passphrase:
        keys.passphrase === undefined
          ? null
          : box.seal(keys.passphrase, context(scope, "passphrase")),
      fingerprint: box.fingerprint(keys.apiKey, FINGERPRINT_CONTEXT),
      apiKeyLast4: keys.apiKey.slice(-4),
    };
  }

  /**
   * Replaces the account's keys. Requires a master key. Throws
   * `KeysInUseError` if another exchange account holds the same API key.
   */
  async save(
    scope: AccountScope,
    keyType: ExchangeKeyType,
    keys: ExchangeKeys,
  ): Promise<SavedKeysInfo> {
    const sealed = this.seal(scope, keyType, keys);
    return this.#scoped(scope, (tx) => writeSealedKeys(tx, scope, sealed));
  }

  /** Deletes the account's keys. Resolves false if there were none. */
  remove(scope: AccountScope): Promise<boolean> {
    return this.#scoped(scope, (tx) => deleteSavedKeys(tx, scope));
  }
}

/** Another exchange account already holds this API key. */
export class KeysInUseError extends Error {
  constructor() {
    super("These keys are already saved for another exchange account.");
    this.name = "KeysInUseError";
  }
}

/**
 * Writes sealed keys in `tx`, replacing the account's, and audits it
 * without the keys. Throws `KeysInUseError` if another exchange account
 * holds the same API key; the transaction is then unusable.
 */
export async function writeSealedKeys(
  tx: Transaction,
  scope: AccountScope,
  sealed: SealedKeys,
): Promise<SavedKeysInfo> {
  let row: { id: string; updated_at: Date };
  try {
    [row] = await tx<{ id: string; updated_at: Date }[]>`
      insert into exchange_credentials (
        customer_id, exchange_account_id, key_type, encrypted_api_key,
        encrypted_api_secret, encrypted_passphrase, api_key_last4,
        api_key_fingerprint
      )
      values (
        ${scope.customerId}, ${scope.exchangeAccountId}, ${sealed.keyType},
        ${sealed.apiKey}, ${sealed.secret}, ${sealed.passphrase},
        ${sealed.apiKeyLast4}, ${sealed.fingerprint}
      )
      on conflict (exchange_account_id) do update set
        key_type = excluded.key_type,
        encrypted_api_key = excluded.encrypted_api_key,
        encrypted_api_secret = excluded.encrypted_api_secret,
        encrypted_passphrase = excluded.encrypted_passphrase,
        api_key_last4 = excluded.api_key_last4,
        api_key_fingerprint = excluded.api_key_fingerprint,
        updated_at = now()
      returning id, updated_at
    `;
  } catch (error) {
    if (
      (error as { constraint_name?: string }).constraint_name ===
      "exchange_credentials_api_key_fingerprint_key"
    )
      throw new KeysInUseError();
    throw error;
  }
  const hasPassphrase = sealed.passphrase !== null;
  await audit(tx, scope, row.id, "exchange_keys.saved", {
    keyType: sealed.keyType,
    apiKeyLast4: sealed.apiKeyLast4,
    hasPassphrase,
  });
  return {
    keyType: sealed.keyType,
    apiKeyLast4: sealed.apiKeyLast4,
    hasPassphrase,
    updatedAt: row.updated_at,
  };
}

/**
 * Deletes the account's keys in `tx`, ciphertext and all, and audits it.
 * Resolves false if there were none.
 */
export async function deleteSavedKeys(
  tx: Transaction,
  scope: AccountScope,
): Promise<boolean> {
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
}

function audit(
  tx: Transaction,
  scope: AccountScope,
  subjectId: string,
  eventType: string,
  payload: Record<string, string | boolean>,
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
