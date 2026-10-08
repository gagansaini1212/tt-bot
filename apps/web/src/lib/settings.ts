import "server-only";
import {
  MAX_NOTIFICATIONS,
  connectionTestSchema,
  exchangeKeysChangeSchema,
  exchangeKeysStatusSchema,
  riskLimitsChangeSchema,
  riskLimitsStateSchema,
  webhookChangeSchema,
  webhookStatusSchema,
  webhookTestSchema,
  type ExchangeKeysRequest,
  type ExchangeKeysStatus,
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

async function read<T extends object>(
  request: Omit<WorkerRequest<T>, "customerId" | "method">,
): Promise<WorkerState<T>> {
  const result = await callWorkerForCustomer(request);
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
  request: Omit<WorkerRequest<T>, "customerId">,
  answer: (data: T) => SettingsActionResult,
  // False for checks, such as a connection test, that change nothing.
  changes = true,
): Promise<SettingsActionResult> {
  const result = await callWorkerForCustomer(request);
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

export function getExchangeKeys(): Promise<
  WorkerState<{ keys: ExchangeKeysStatus }>
> {
  return read({
    path: "/settings/exchange-keys",
    schema: z.object({ keys: exchangeKeysStatusSchema }),
  });
}

export function saveExchangeKeys(request: ExchangeKeysRequest) {
  return write(
    {
      method: "POST",
      path: "/settings/exchange-keys",
      body: request,
      schema: z.object({ change: exchangeKeysChangeSchema }),
    },
    changeResult,
  );
}

export function removeExchangeKeys() {
  return write(
    {
      method: "DELETE",
      path: "/settings/exchange-keys",
      schema: z.object({ change: exchangeKeysChangeSchema }),
    },
    changeResult,
  );
}

export function testExchangeConnection() {
  return write(
    {
      method: "POST",
      path: "/settings/exchange-keys/test",
      schema: z.object({ test: connectionTestSchema }),
    },
    ({ test }) => ({ result: test.result, message: test.message }),
    false,
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
  return read({
    path: "/settings/webhook",
    schema: z.object({ webhook: webhookStatusSchema }),
  });
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
  );
}

export function getNotifications(): Promise<
  WorkerState<{ notifications: Notification[] }>
> {
  return read({
    path: "/notifications",
    schema: z.object({
      notifications: z.array(notificationSchema).max(MAX_NOTIFICATIONS),
    }),
  });
}

export function markNotificationsRead() {
  return write(
    { method: "POST", path: "/notifications/read", schema: z.object({}) },
    () => ({ result: "done", message: "Marked every alert read." }),
  );
}
