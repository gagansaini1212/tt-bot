import {
  riskLimitsChangeRequestSchema,
  webhookRequestSchema,
  type Notification,
  type RiskLimitsChange,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import { accountHandler, customerHandler } from "../http";
import type { NotificationWebhooks } from "../notification-webhooks";
import {
  riskLimitIssues,
  riskLimitsState,
  type RiskLimitStore,
} from "../risk-limits";

export type SettingsDependencies = {
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

/**
 * The Settings page: the exchange account's risk limits, and the customer's
 * webhook and notifications. Webhook URLs are accepted here but never
 * returned: answers carry only their last four characters. Exchange accounts
 * and their keys are in exchange-accounts.ts.
 */
export function settings(dependencies: SettingsDependencies) {
  const { risk, webhooks, notifications } = dependencies;
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
