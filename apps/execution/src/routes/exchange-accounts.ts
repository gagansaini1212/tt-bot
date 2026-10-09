import { randomUUID } from "node:crypto";
import {
  accountModes,
  accountVenue,
  addExchangeAccountRequestSchema,
  canPlaceOrders,
  ExchangeError,
  exchangeAccountRequestSchema,
  relabelExchangeAccountRequestSchema,
  replaceExchangeKeysRequestSchema,
  venueFor,
  type AccountReader,
  type ConnectionTest,
  type ExchangeAccountChange,
  type ExchangeAccountSummary,
  type ExchangeKeyType,
  type ExchangeKeysRequest,
  type ExchangeKeysStatus,
  type Venue,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import type {
  ExchangeAccountRecord,
  ExchangeAccountStore,
  OpenWork,
} from "../exchange-accounts";
import {
  AccountRemovedError,
  checkKeyPermissions,
  KeysInUseError,
  prepareCredentials,
  type ExchangeCredentialStore,
  type ExchangeSource,
  type PermissionCheck,
  type PreparedKeys,
  type VenueConnector,
} from "../exchange-credentials";
import { customerHandler } from "../http";
import { MASTER_KEY_VARIABLE } from "../secret-box";

export type ExchangeAccountDependencies = {
  accounts: Pick<
    ExchangeAccountStore,
    "list" | "get" | "add" | "relabel" | "refreshFeatures" | "remove"
  >;
  keys: Pick<ExchangeCredentialStore, "load" | "save" | "seal" | "canSave">;
  exchanges: ExchangeSource;
  // Builds the venue's adapter for new keys, to check them before saving.
  connect: VenueConnector;
  // The worker's own keys from its .env file, if any, as Settings shows them.
  environmentKeys?: { keyType: ExchangeKeyType; apiKeyLast4: string };
};

const empty = z.strictObject({});
const MODE_NAMES = {
  simulation: "simulation (testnet)",
  live: "live, read only",
} as const;

const NO_SUCH_ACCOUNT =
  "There is no such exchange account. Refresh the page and try again.";

/**
 * Settings → Exchange accounts: the customer's accounts on every venue, each
 * with its own keys. Each route names the account by its ID and looks it up
 * in the customer's scope. Keys are accepted here but never returned:
 * answers carry only the API key's last four characters.
 */
export function exchangeAccounts(
  dependencies: ExchangeAccountDependencies,
  // Called after an account or its keys change.
  onChange: () => void,
) {
  const { accounts, keys, exchanges, connect, environmentKeys } = dependencies;

  async function keysStatus(scope: AccountScope): Promise<ExchangeKeysStatus> {
    const saved = await keys.load(scope);
    if (saved) {
      let problem: string | null = null;
      try {
        saved.open();
      } catch {
        problem = `The worker cannot open these keys. Set ${MASTER_KEY_VARIABLE} to the key that saved them, or replace the keys.`;
      }
      return {
        source: "saved",
        keyType: saved.keyType,
        apiKeyLast4: saved.apiKeyLast4,
        hasPassphrase: saved.hasPassphrase ?? false,
        updatedAt: saved.updatedAt.toISOString(),
        problem,
      };
    }
    const lookup = await exchanges.forAccount(scope);
    const fromEnvironment =
      "exchange" in lookup && lookup.source === "environment";
    return {
      source: fromEnvironment ? "environment" : "none",
      keyType: fromEnvironment ? (environmentKeys?.keyType ?? null) : null,
      apiKeyLast4: fromEnvironment
        ? (environmentKeys?.apiKeyLast4 ?? null)
        : null,
      hasPassphrase: false,
      updatedAt: null,
      problem: null,
    };
  }

  async function summary(
    customerId: string,
    account: ExchangeAccountRecord,
  ): Promise<ExchangeAccountSummary> {
    return {
      id: account.id,
      venue: account.venue,
      label: account.label,
      mode: account.mode,
      accountingCurrency: account.accountingCurrency,
      status: account.status,
      supportedFeatures: account.supportedFeatures,
      supportedFeaturesRefreshedAt:
        account.supportedFeaturesRefreshedAt?.toISOString() ?? null,
      keys: await keysStatus({ customerId, exchangeAccountId: account.id }),
      createdAt: account.createdAt.toISOString(),
    };
  }

  const change = (
    result: ExchangeAccountChange["result"],
    message: string,
  ) => ({ status: "connected", change: { result, message } });
  const missing = () => change("invalid", NO_SUCH_ACCOUNT);
  const labelTaken = (label: string) =>
    change(
      "conflict",
      `You already have an exchange account called ${label}. Choose another label.`,
    );
  const noMasterKey = () =>
    change(
      "unavailable",
      `The execution worker cannot save keys until ${MASTER_KEY_VARIABLE} is set in apps/execution/.env. Set it and restart the worker.`,
    );
  const keysInUse = () =>
    change(
      "conflict",
      "These keys are already connected to another exchange account. Each account needs keys of its own, so one venue account is never counted twice.",
    );

  /**
   * Checks new keys for `venue` and asks the venue what they may do, before
   * anything is saved. Returns the change to answer with if they are not
   * usable.
   */
  async function vet(
    venue: Venue,
    request: ExchangeKeysRequest,
  ): Promise<
    | { ok: false; refusal: ReturnType<typeof change> }
    | {
        ok: true;
        prepared: Extract<PreparedKeys, { ok: true }>;
        note: string;
      }
  > {
    const prepared = prepareCredentials(venue, request, connect);
    if (!prepared.ok)
      return { ok: false, refusal: change("invalid", prepared.message) };
    if (prepared.reader.venue !== venue.id)
      return {
        ok: false,
        refusal: change(
          "unavailable",
          `The execution worker has no ${venue.name} adapter yet.`,
        ),
      };
    const permissions = await checkKeyPermissions(venue, prepared.reader);
    if (permissions.result !== "allowed")
      return { ok: false, refusal: change("refused", permissions.message) };
    return { ok: true, prepared, note: permissionNote(venue, permissions) };
  }

  return {
    list: customerHandler({
      query: empty,
      handle: async ({ customerId }) => ({
        status: "connected",
        exchangeAccounts: {
          accounts: await Promise.all(
            (await accounts.list(customerId)).map((account) =>
              summary(customerId, account),
            ),
          ),
          canSave: keys.canSave,
        },
      }),
    }),
    add: customerHandler({
      query: empty,
      body: addExchangeAccountRequestSchema,
      async handle({ customerId, body }) {
        const venue = venueFor(body.venue);
        const modes = accountModes(venue);
        if (!modes.length)
          return change(
            "refused",
            `${venue.name} would trade real funds, and live trading is turned off.`,
          );
        if (!modes.includes(body.mode))
          return change(
            "invalid",
            `A ${venue.name} account can only be ${modes.map((mode) => MODE_NAMES[mode]).join(" or ")}.`,
          );
        if (!keys.canSave) return noMasterKey();
        const vetted = await vet(venue, body.credentials);
        if (!vetted.ok) return vetted.refusal;
        const scope = { customerId, exchangeAccountId: randomUUID() };
        let added;
        try {
          added = await accounts.add(
            scope,
            {
              venue: venueFor(vetted.prepared.reader.venue),
              label: body.label,
              mode: body.mode,
              accountingCurrency: body.accountingCurrency,
            },
            keys.seal(scope, vetted.prepared.keyType, vetted.prepared.keys),
          );
        } catch (error) {
          if (error instanceof KeysInUseError) return keysInUse();
          throw error;
        }
        if (added.result === "label_taken") return labelTaken(body.label);
        if (added.result === "limit_reached")
          return change(
            "refused",
            "You have the most exchange accounts allowed. Remove one before adding another.",
          );
        onChange();
        return change(
          "saved",
          `Added ${body.label}. ${vetted.note}Test the connection to check the keys.`,
        );
      },
    }),
    relabel: customerHandler({
      query: empty,
      body: relabelExchangeAccountRequestSchema,
      async handle({ customerId, body }) {
        const result = await accounts.relabel(
          { customerId, exchangeAccountId: body.exchangeAccountId },
          body.label,
        );
        if (result.result === "not_found") return missing();
        if (result.result === "label_taken") return labelTaken(body.label);
        onChange();
        return change("saved", `Renamed to ${body.label}.`);
      },
    }),
    replaceKeys: customerHandler({
      query: empty,
      body: replaceExchangeKeysRequestSchema,
      async handle({ customerId, body }) {
        const scope = { customerId, exchangeAccountId: body.exchangeAccountId };
        const account = await accounts.get(scope);
        if (!account) return missing();
        const venue = accountVenue(account.venue);
        if (!venue)
          return change(
            "unavailable",
            `The execution worker has no adapter for ${account.venue}.`,
          );
        if (!keys.canSave) return noMasterKey();
        const vetted = await vet(venue, body.credentials);
        if (!vetted.ok) return vetted.refusal;
        try {
          await keys.save(scope, vetted.prepared.keyType, vetted.prepared.keys);
        } catch (error) {
          if (error instanceof KeysInUseError) return keysInUse();
          // Removed while the venue was checking the keys.
          if (error instanceof AccountRemovedError) return missing();
          throw error;
        }
        await accounts.refreshFeatures(
          scope,
          venueFor(vetted.prepared.reader.venue).capabilities,
        );
        exchanges.forget(scope);
        onChange();
        return change(
          "saved",
          `Saved. The worker uses these keys for ${account.label} from now on. ${vetted.note}Test the connection to check them.`,
        );
      },
    }),
    test: customerHandler({
      query: empty,
      body: exchangeAccountRequestSchema,
      async handle({ customerId, body }) {
        const scope = { customerId, exchangeAccountId: body.exchangeAccountId };
        const account = await accounts.get(scope);
        const test: ConnectionTest = account
          ? await testConnection(scope, account)
          : { result: "failed", source: "none", message: NO_SUCH_ACCOUNT };
        return { status: "connected", test };
      },
    }),
    remove: customerHandler({
      query: empty,
      body: exchangeAccountRequestSchema,
      async handle({ customerId, body }) {
        const scope = { customerId, exchangeAccountId: body.exchangeAccountId };
        const account = await accounts.get(scope);
        if (!account) return missing();
        const result = await accounts.remove(scope);
        if (result.result === "not_found") return missing();
        if (result.result === "open")
          return change("refused", openWorkMessage(account.label, result.open));
        exchanges.forget(scope);
        onChange();
        return change(
          "removed",
          `Removed ${account.label}. Its keys are deleted, and the worker no longer reads or trades it. Its orders and fills stay in your history.`,
        );
      },
    }),
  };

  /**
   * Reads the account from its venue with the keys the worker would use,
   * checks what they may do, and records what the venue's adapter supports.
   */
  async function testConnection(
    scope: AccountScope,
    account: ExchangeAccountRecord,
  ): Promise<ConnectionTest> {
    const venue = accountVenue(account.venue);
    if (!venue)
      return {
        result: "failed",
        source: "none",
        message: `The execution worker has no adapter for ${account.venue}.`,
      };
    const lookup = await exchanges.forAccount(scope);
    if ("problem" in lookup)
      return lookup.problem === "credentials"
        ? {
            result: "failed",
            source: "saved",
            message: `The saved keys cannot be opened. Set ${MASTER_KEY_VARIABLE} to the key that saved them, or replace the keys.`,
          }
        : {
            result: "failed",
            source: "none",
            message: `There are no keys to test. Add your ${venue.name} API keys first.`,
          };
    const failed = (message: string): ConnectionTest => ({
      result: "failed",
      source: lookup.source,
      message,
    });
    const reader: AccountReader = lookup.exchange;
    if (reader.venue !== venue.id)
      return failed(`The execution worker has no ${venue.name} adapter yet.`);
    let canTrade: boolean;
    let permissions: PermissionCheck;
    try {
      ({ canTrade } = await reader.getAccount());
      permissions = await checkKeyPermissions(venue, reader);
    } catch (error) {
      if (!(error instanceof ExchangeError))
        return failed(
          "The connection test could not run. Check the execution worker's output.",
        );
      switch (error.kind) {
        case "rejected":
          return failed(
            `${venue.name} refused the request${error.code === undefined ? "" : ` (code ${error.code})`}. Check the API key, the secret or private key, and the key's permissions.`,
          );
        case "rate_limited":
          return failed(
            `${venue.name} is limiting requests. Try again in ${error.retryAfterSeconds ?? 60} seconds.`,
          );
        default:
          return failed(
            `${venue.name} could not be reached. Try again shortly.`,
          );
      }
    }
    if (permissions.result !== "allowed") return failed(permissions.message);
    await accounts.refreshFeatures(scope, venueFor(reader.venue).capabilities);
    const message = !canPlaceOrders(venue)
      ? `Connected. ${venue.name} accepts the keys. ${permissions.verified ? "They can neither trade nor withdraw." : permissionNote(venue, permissions)}`.trim()
      : canTrade
        ? `Connected. ${venue.name} accepts the keys and allows trading.`
        : `Connected, but ${venue.name} does not let this account trade. Check the API key's permissions.`;
    return { result: "connected", source: lookup.source, canTrade, message };
  }
}

/**
 * What the customer must still check for themselves: a read-only venue
 * that cannot report a key's permissions.
 */
function permissionNote(venue: Venue, permissions: PermissionCheck) {
  return permissions.result === "allowed" &&
    !permissions.verified &&
    !canPlaceOrders(venue)
    ? `${venue.name} cannot report these keys' permissions, so read only is not verified: make sure the key cannot trade or withdraw. `
    : "";
}

function openWorkMessage(label: string, open: OpenWork) {
  const count = (value: number, one: string, many: string) =>
    value ? [`${value} ${value === 1 ? one : many}`] : [];
  const parts = [
    ...count(open.strategies, "running strategy", "running strategies"),
    ...count(open.positions, "open position", "open positions"),
    ...count(open.orders, "open order", "open orders"),
  ];
  const listed =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
      : parts[0];
  return `${label} still has ${listed}. Pause its strategies and close what they hold, for example with the kill switch on Strategies, and let its open orders finish. Then remove it.`;
}
