import {
  BinanceTestnetError,
  exchangeKeysRequestSchema,
  riskLimitsChangeRequestSchema,
  webhookRequestSchema,
  type ConnectionTest,
  type ExchangeKeyType,
  type ExchangeKeysChange,
  type ExchangeKeysStatus,
  type Notification,
  type RiskLimitsChange,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import {
  prepareKeys,
  type ExchangeCredentialStore,
  type ExchangeSource,
} from "../exchange-credentials";
import { accountHandler, customerHandler } from "../http";
import type { NotificationWebhooks } from "../notification-webhooks";
import {
  riskLimitIssues,
  riskLimitsState,
  type RiskLimitStore,
} from "../risk-limits";
import { MASTER_KEY_VARIABLE } from "../secret-box";

export type SettingsDependencies = {
  keys: Pick<ExchangeCredentialStore, "load" | "save" | "remove" | "canSave">;
  exchanges: ExchangeSource;
  // The worker's own keys from its .env file, if any, as Settings shows them.
  environmentKeys?: { keyType: ExchangeKeyType; apiKeyLast4: string };
  risk: RiskLimitStore;
  webhooks: Pick<
    NotificationWebhooks,
    "status" | "save" | "remove" | "sendTest"
  >;
  notifications: {
    list(customerId: string): Promise<Notification[]>;
    markRead(customerId: string): Promise<void>;
  };
};

const empty = z.strictObject({});
// Binance's codes for an API key, signature or permission it refuses.
const REFUSED_KEYS = new Set([-1022, -2008, -2014, -2015]);

/**
 * The Settings page: the exchange account's keys and risk limits, and the
 * customer's webhook and notifications. Keys and webhook URLs are accepted
 * here but never returned: answers carry only their last four characters.
 */
export function settings(
  dependencies: SettingsDependencies,
  // Called after an account's keys change.
  onKeysChange: () => void,
) {
  const { keys, exchanges, environmentKeys, risk, webhooks, notifications } =
    dependencies;
  async function keysStatus(
    account: AccountScope,
  ): Promise<ExchangeKeysStatus> {
    const saved = await keys.load(account);
    if (saved) {
      let problem: string | null = null;
      try {
        saved.open();
      } catch {
        problem = `The worker cannot open these keys. Set ${MASTER_KEY_VARIABLE} to the key that saved them, or save the keys again.`;
      }
      return {
        source: "saved",
        keyType: saved.keyType,
        apiKeyLast4: saved.apiKeyLast4,
        updatedAt: saved.updatedAt.toISOString(),
        canSave: keys.canSave,
        problem,
      };
    }
    const lookup = await exchanges.forAccount(account);
    const fromEnvironment =
      "exchange" in lookup && lookup.source === "environment";
    return {
      source: fromEnvironment ? "environment" : "none",
      keyType: fromEnvironment ? (environmentKeys?.keyType ?? null) : null,
      apiKeyLast4: fromEnvironment
        ? (environmentKeys?.apiKeyLast4 ?? null)
        : null,
      updatedAt: null,
      canSave: keys.canSave,
      problem: null,
    };
  }

  const keysChange = async (
    account: AccountScope,
    result: ExchangeKeysChange["result"],
    message: string,
  ) => ({
    status: "connected",
    change: { result, message, keys: await keysStatus(account) },
  });

  const limitsChange = async (
    account: AccountScope,
    result: RiskLimitsChange["result"],
    message: string,
  ) => ({
    status: "connected",
    change: {
      result,
      message,
      limits: riskLimitsState(await risk.current(account)),
    },
  });

  return {
    keys: accountHandler({
      query: empty,
      handle: async ({ account }) => ({
        status: "connected",
        keys: await keysStatus(account),
      }),
    }),
    saveKeys: accountHandler({
      query: empty,
      body: exchangeKeysRequestSchema,
      async handle({ account, body }) {
        if (!keys.canSave)
          return keysChange(
            account,
            "unavailable",
            `The execution worker cannot save keys until ${MASTER_KEY_VARIABLE} is set in apps/execution/.env. Set it and restart the worker.`,
          );
        const prepared = prepareKeys(body);
        if (!prepared.ok)
          return keysChange(account, "invalid", prepared.message);
        await keys.save(account, prepared.keyType, prepared.keys);
        exchanges.forget(account);
        onKeysChange();
        return keysChange(
          account,
          "saved",
          "Saved. The worker uses these keys for this account from now on. Test the connection to check them.",
        );
      },
    }),
    removeKeys: accountHandler({
      query: empty,
      async handle({ account }) {
        const removed = await keys.remove(account);
        exchanges.forget(account);
        onKeysChange();
        const status = await keysStatus(account);
        return keysChange(
          account,
          "removed",
          !removed
            ? "There were no saved keys to remove."
            : status.source === "environment"
              ? "Removed. The worker uses the keys in its .env file again."
              : "Removed. The worker has no keys for this account now.",
        );
      },
    }),
    testKeys: accountHandler({
      query: empty,
      handle: async ({ account }) => ({
        status: "connected",
        test: await testConnection(exchanges, account),
      }),
    }),
    riskLimits: accountHandler({
      query: empty,
      handle: async ({ account }) => ({
        status: "connected",
        limits: riskLimitsState(await risk.current(account)),
      }),
    }),
    changeRiskLimits: accountHandler({
      query: empty,
      body: riskLimitsChangeRequestSchema,
      async handle({ account, body }) {
        const { baseVersion, ...limits } = body;
        const issues = riskLimitIssues(limits);
        if (issues.length)
          return limitsChange(account, "invalid", issues.join(" "));
        const result = await risk.change(account, limits, baseVersion);
        return result.status === "saved"
          ? limitsChange(
              account,
              "saved",
              `Saved as version ${result.limits.version}. It applies to orders placed from now on. Open orders keep the limits they were placed under.`,
            )
          : limitsChange(
              account,
              "conflict",
              "These limits changed since you opened them. Review the current values, then save again.",
            );
      },
    }),
    webhook: customerHandler({
      query: empty,
      handle: async ({ customerId }) => ({
        status: "connected",
        webhook: await webhooks.status(customerId),
      }),
    }),
    saveWebhook: customerHandler({
      query: empty,
      body: webhookRequestSchema,
      handle: async ({ customerId, body }) => ({
        status: "connected",
        change: await webhooks.save(customerId, body.url),
      }),
    }),
    removeWebhook: customerHandler({
      query: empty,
      handle: async ({ customerId }) => ({
        status: "connected",
        change: await webhooks.remove(customerId),
      }),
    }),
    testWebhook: customerHandler({
      query: empty,
      handle: async ({ customerId }) => ({
        status: "connected",
        test: await webhooks.sendTest(customerId),
      }),
    }),
    notifications: customerHandler({
      query: empty,
      handle: async ({ customerId }) => ({
        status: "connected",
        notifications: await notifications.list(customerId),
      }),
    }),
    markNotificationsRead: customerHandler({
      query: empty,
      async handle({ customerId }) {
        await notifications.markRead(customerId);
        return { status: "connected" };
      },
    }),
  };
}

/** Reads the account from Binance with the keys the worker would trade with. */
export async function testConnection(
  exchanges: ExchangeSource,
  account: AccountScope,
): Promise<ConnectionTest> {
  const lookup = await exchanges.forAccount(account);
  if ("problem" in lookup)
    return lookup.problem === "credentials"
      ? {
          result: "failed",
          source: "saved",
          message: `The saved keys cannot be opened. Set ${MASTER_KEY_VARIABLE} to the key that saved them, or save the keys again.`,
        }
      : {
          result: "failed",
          source: "none",
          message:
            "There are no keys to test. Save your Binance Spot Testnet API keys first.",
        };
  try {
    const { canTrade } = await lookup.exchange.getAccount();
    return {
      result: "connected",
      source: lookup.source,
      canTrade,
      message: canTrade
        ? "Connected. Binance Spot Testnet accepts the keys and allows trading."
        : "Connected, but Binance does not let this account trade. Check the API key's permissions.",
    };
  } catch (error) {
    const failed = (message: string): ConnectionTest => ({
      result: "failed",
      source: lookup.source,
      message,
    });
    if (!(error instanceof BinanceTestnetError))
      return failed(
        "The connection test could not run. Check the execution worker's output.",
      );
    switch (error.kind) {
      case "rejected":
        return failed(
          error.code !== undefined && REFUSED_KEYS.has(error.code)
            ? `Binance refused these keys (code ${error.code}). Check the API key, the secret or private key, and that the key is a Spot Testnet key with account access.`
            : `Binance refused the request${error.code === undefined ? "" : ` (code ${error.code})`}.`,
        );
      case "rate_limited":
        return failed(
          `Binance is limiting requests. Try again in ${error.retryAfterSeconds ?? 60} seconds.`,
        );
      default:
        return failed(
          "Binance Spot Testnet could not be reached. Try again shortly.",
        );
    }
  }
}
