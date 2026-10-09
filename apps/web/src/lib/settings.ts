import "server-only";
import {
  exchangeAccountChangeSchema,
  exchangeAccountsStateSchema,
  type AddExchangeAccountRequest,
  type ExchangeAccountsState,
  type RelabelExchangeAccountRequest,
  type ReplaceExchangeKeysRequest,
} from "@crypto-trading/exchanges/exchange-accounts";
import {
  MAX_NOTIFICATIONS,
  connectionTestSchema,
  riskLimitsChangeSchema,
  riskLimitsStateSchema,
  webhookChangeSchema,
  webhookStatusSchema,
  webhookTestSchema,
  type RiskLimitsChangeRequest,
  type RiskLimitsState,
  type WebhookStatus,
} from "@crypto-trading/exchanges/settings";
import {
  notificationSchema,
  type Notification,
} from "@crypto-trading/exchanges/execution";
import { z } from "zod";
import {
  callWorkerForAccount,
  callWorkerForCustomer,
  type WorkerFailureReason,
  type WorkerRequest,
  type WorkerState,
} from "./worker-client";

/**
 * What a Settings action did, in words for the page. `refused`, `invalid`
 * and `unavailable` mean nothing changed. After `unconfirmed`, the change
 * reached the worker or not: the refreshed page shows which.
 */
export type SettingsActionResult = {
  result:
    | "saved"
    | "removed"
    | "connected"
    | "delivered"
    | "done"
    | "invalid"
    | "conflict"
    | "failed"
    | "refused"
    | "unavailable"
    | "unconfirmed";
  message: string;
};

// The worker did nothing, or the request never left this server.
const NOT_SENT = new Set<WorkerFailureReason>([
  "missing_token",
  "invalid_url",
  "signed_out",
  "worker_not_configured",
  "exchange_keys_unusable",
  "no_exchange_account",
  "database_unavailable",
  "invalid_request",
]);

// Risk limits belong to the current exchange account. The exchange accounts
// themselves, the webhook and notifications are the customer's own.
type Scope = { account: boolean };
const customer: Scope = { account: false };
const call = <T>(
  request: Omit<WorkerRequest<T>, "customerId" | "exchangeAccountId">,
  { account }: Scope,
) => (account ? callWorkerForAccount(request) : callWorkerForCustomer(request));

async function read<T extends object>(
  request: Omit<
    WorkerRequest<T>,
    "customerId" | "exchangeAccountId" | "method"
  >,
  scope: Scope = { account: true },
): Promise<WorkerState<T>> {
  const result = await call(request, scope);
  return result.status === "connected"
    ? { status: "connected", ...result.data }
    : { status: result.status, message: result.message };
}

/**
 * Sends a change and returns the worker's answer, or why it did not answer.
 * A change the worker may have made without confirming it says so: settings
 * are safe to save again once the refreshed page shows what happened.
 */
async function write<T>(
  request: Omit<WorkerRequest<T>, "customerId" | "exchangeAccountId">,
  answer: (data: T) => SettingsActionResult,
  // False for checks, such as a connection test, that change nothing.
  changes = true,
  scope: Scope = { account: true },
): Promise<SettingsActionResult> {
  const result = await call(request, scope);
  if (result.status === "connected") return answer(result.data);
  return !changes || NOT_SENT.has(result.reason)
    ? { result: "unavailable", message: result.message }
    : {
        result: "unconfirmed",
        message: `${result.message} The change may or may not have been made: check this page after it refreshes before trying again.`,
      };
}

// Most changes answer with the worker's own result and message.
const changeResult = ({ change }: { change: SettingsActionResult }) => ({
  result: change.result,
  message: change.message,
});

export function getExchangeAccounts(): Promise<
  WorkerState<{ exchangeAccounts: ExchangeAccountsState }>
> {
  return read(
    {
      path: "/exchange-accounts",
      schema: z.object({ exchangeAccounts: exchangeAccountsStateSchema }),
    },
    customer,
  );
}

const accountChange = {
  method: "POST",
  schema: z.object({ change: exchangeAccountChangeSchema }),
} as const;

export function addExchangeAccount(request: AddExchangeAccountRequest) {
  return write(
    { ...accountChange, path: "/exchange-accounts", body: request },
    changeResult,
    true,
    customer,
  );
}

export function relabelExchangeAccount(request: RelabelExchangeAccountRequest) {
  return write(
    { ...accountChange, path: "/exchange-accounts/label", body: request },
    changeResult,
    true,
    customer,
  );
}

export function replaceExchangeKeys(request: ReplaceExchangeKeysRequest) {
  return write(
    { ...accountChange, path: "/exchange-accounts/keys", body: request },
    changeResult,
    true,
    customer,
  );
}

export function removeExchangeAccount(exchangeAccountId: string) {
  return write(
    {
      ...accountChange,
      path: "/exchange-accounts/remove",
      body: { exchangeAccountId },
    },
    changeResult,
    true,
    customer,
  );
}

export function testExchangeAccount(exchangeAccountId: string) {
  return write(
    {
      method: "POST",
      path: "/exchange-accounts/test",
      body: { exchangeAccountId },
      schema: z.object({ test: connectionTestSchema }),
    },
    ({ test }) => ({ result: test.result, message: test.message }),
    false,
    customer,
  );
}

export function getRiskLimits(): Promise<
  WorkerState<{ limits: RiskLimitsState }>
> {
  return read({
    path: "/settings/risk-limits",
    schema: z.object({ limits: riskLimitsStateSchema }),
  });
}

export function saveRiskLimits(request: RiskLimitsChangeRequest) {
  return write(
    {
      method: "POST",
      path: "/settings/risk-limits",
      body: request,
      schema: z.object({ change: riskLimitsChangeSchema }),
    },
    changeResult,
  );
}

export function getWebhook(): Promise<WorkerState<{ webhook: WebhookStatus }>> {
  return read(
    {
      path: "/settings/webhook",
      schema: z.object({ webhook: webhookStatusSchema }),
    },
    customer,
  );
}

export function saveWebhook(url: string) {
  return write(
    {
      method: "POST",
      path: "/settings/webhook",
      body: { url },
      schema: z.object({ change: webhookChangeSchema }),
    },
    changeResult,
    true,
    customer,
  );
}

export function removeWebhook() {
  return write(
    {
      method: "DELETE",
      path: "/settings/webhook",
      schema: z.object({ change: webhookChangeSchema }),
    },
    changeResult,
    true,
    customer,
  );
}

export function sendTestWebhook() {
  return write(
    {
      method: "POST",
      path: "/settings/webhook/test",
      schema: z.object({ test: webhookTestSchema }),
    },
    ({ test }) => ({ result: test.result, message: test.message }),
    false,
    customer,
  );
}

export function getNotifications(): Promise<
  WorkerState<{ notifications: Notification[] }>
> {
  return read(
    {
      path: "/notifications",
      schema: z.object({
        notifications: z.array(notificationSchema).max(MAX_NOTIFICATIONS),
      }),
    },
    customer,
  );
}

export function markNotificationsRead() {
  return write(
    { method: "POST", path: "/notifications/read", schema: z.object({}) },
    () => ({ result: "done", message: "Marked every alert read." }),
    true,
    customer,
  );
}
