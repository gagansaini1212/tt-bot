import "server-only";
import { servedAccountSchema } from "@crypto-trading/exchanges/served-accounts";
import { z } from "zod";
import { getCurrentExchangeAccount } from "./current-account";
import { getCurrentCustomer } from "./current-customer";

// The web app sends the worker's bearer token to this URL, so it must stay on this machine.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_WORKER_URL = "http://127.0.0.1:4001";
const TIMEOUT_MS = 15_000;

export function parseWorkerUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return undefined;
  return url;
}

/**
 * Why a worker call failed. The request was not sent after `missing_token`,
 * `invalid_url` or `signed_out`. The worker did nothing after
 * `worker_not_configured`, `exchange_keys_unusable`, `no_exchange_account` or
 * `database_unavailable`.
 * After `unreachable`, `timeout` or `invalid_response`, a write may have
 * reached the worker, so its outcome is unknown.
 */
export type WorkerFailureReason =
  | "missing_token"
  | "invalid_url"
  | "signed_out"
  | "worker_not_configured"
  | "exchange_keys_unusable"
  | "no_exchange_account"
  | "database_unavailable"
  | "unreachable"
  | "timeout"
  | "invalid_request"
  | "rejected"
  | "invalid_response";

export type WorkerFailure = {
  status: "not_configured" | "unavailable";
  reason: WorkerFailureReason;
  /** Safe to show to the user. */
  message: string;
};

export type WorkerResult<T> =
  | {
      status: "connected";
      data: T;
      /** The worker's Date header, for measuring age on the worker's clock. */
      date: string | null;
    }
  | WorkerFailure;

/** A page's view of one worker read: its data, or a message to show instead. */
export type WorkerState<T extends object> =
  | ({ status: "connected" } & T)
  | { status: "not_configured" | "unavailable"; message: string };

export type WorkerRequest<T> = {
  method?: "GET" | "POST" | "DELETE";
  path: `/${string}`;
  /** Undefined values are left out. */
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** The customer the worker acts for. Set by `callWorkerForCustomer`. */
  customerId?: string;
  /**
   * The customer's exchange account the request acts on. Set by
   * `callWorkerForAccount`; the worker checks that the customer owns it.
   */
  exchangeAccountId?: string;
  /** Validates a connected response, such as `{ status: "connected", snapshot }`. */
  schema: z.ZodType<T>;
};

const FAILURES: Record<WorkerFailureReason, Omit<WorkerFailure, "reason">> = {
  missing_token: {
    status: "not_configured",
    message:
      "Set up Binance Spot Testnet to use the execution worker. Follow the testnet setup in README.md.",
  },
  invalid_url: {
    status: "unavailable",
    message:
      "EXECUTION_API_URL must point to the execution worker on this machine, such as http://127.0.0.1:4001. Use 127.0.0.1, localhost, or [::1] as the host.",
  },
  signed_out: {
    status: "not_configured",
    message: "Sign in to see your exchange account.",
  },
  worker_not_configured: {
    status: "not_configured",
    message:
      "Add your Binance Spot Testnet API keys in Settings, or configure them in the execution worker and restart it.",
  },
  exchange_keys_unusable: {
    status: "not_configured",
    message:
      "The execution worker cannot open your saved exchange keys. Check its CREDENTIALS_MASTER_KEY, or save the keys again in Settings.",
  },
  no_exchange_account: {
    status: "not_configured",
    message:
      "No exchange account is connected for you on the execution worker. Run pnpm db:seed to create the development account, then refresh.",
  },
  database_unavailable: {
    status: "unavailable",
    message:
      "The execution worker cannot use its database. Start PostgreSQL with pnpm db:up if it is stopped, check the worker's output, then refresh.",
  },
  unreachable: {
    status: "unavailable",
    message:
      "The execution worker is unavailable. Start it and refresh to reconnect.",
  },
  timeout: {
    status: "unavailable",
    message:
      "The execution worker did not respond in time. Check that it is running, then refresh.",
  },
  // The worker refused the parameters or body: a bug in the caller.
  invalid_request: {
    status: "unavailable",
    message:
      "The execution worker could not read the request. Refresh, and report the problem if it continues.",
  },
  rejected: {
    status: "unavailable",
    message:
      "The execution worker could not complete the request. Check the worker and its credentials, then refresh.",
  },
  invalid_response: {
    status: "unavailable",
    message:
      "The execution worker sent an unexpected response. Restart it and refresh.",
  },
};

/** A failure as `callWorker` reports it, for callers that stop before it. */
export function workerFailure(reason: WorkerFailureReason): WorkerFailure {
  return { ...FAILURES[reason], reason };
}
const failure = workerFailure;

function isTimeout(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Calls the local execution worker with its bearer token. Never throws:
 * failures come back as user-facing states.
 */
export async function callWorker<T>({
  method = "GET",
  path,
  query = {},
  body,
  customerId,
  exchangeAccountId,
  schema,
}: WorkerRequest<T>): Promise<WorkerResult<T>> {
  const token = process.env.EXECUTION_API_TOKEN;
  if (!token) return failure("missing_token");
  const url = parseWorkerUrl(
    process.env.EXECUTION_API_URL ?? DEFAULT_WORKER_URL,
  );
  if (!url) return failure("invalid_url");
  // Set as a path, so a value like "//host" cannot change the host.
  url.pathname = path;
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(key, String(value));
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(customerId === undefined ? {} : { "X-Customer-Id": customerId }),
        ...(exchangeAccountId === undefined
          ? {}
          : { "X-Exchange-Account-Id": exchangeAccountId }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return failure(isTimeout(error) ? "timeout" : "unreachable");
  }
  if (!response.ok)
    return failure(response.status === 400 ? "invalid_request" : "rejected");
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    return failure(isTimeout(error) ? "timeout" : "invalid_response");
  }
  const { status, reason } =
    typeof data === "object" && data !== null
      ? (data as { status?: unknown; reason?: unknown })
      : {};
  if (status === "not_configured")
    return failure(
      reason === "database"
        ? "database_unavailable"
        : reason === "exchange_account"
          ? "no_exchange_account"
          : reason === "credentials"
            ? "exchange_keys_unusable"
            : "worker_not_configured",
    );
  const parsed = schema.safeParse(data);
  if (status !== "connected" || !parsed.success)
    return failure("invalid_response");
  return {
    status: "connected",
    data: parsed.data,
    date: response.headers.get("date"),
  };
}

/**
 * Calls a worker route that serves or changes a customer's data, for the
 * current customer. The worker trusts the customer it is told, because only
 * this server holds its token. For an exchange account's data, use
 * `callWorkerForAccount`, which also names the account.
 */
export async function callWorkerForCustomer<T>(
  request: Omit<WorkerRequest<T>, "customerId">,
): Promise<WorkerResult<T>> {
  const customer = await getCurrentCustomer();
  if (!customer) return failure("signed_out");
  return callWorker({ ...request, customerId: customer.id });
}

// The customer's exchange accounts that the worker serves.
export const listAccounts = () =>
  callWorkerForCustomer({
    path: "/accounts",
    schema: z.object({ accounts: z.array(servedAccountSchema) }),
  });
export const getServedAccounts = listAccounts;

/**
 * Calls a worker route that serves or changes an exchange account's data,
 * for the current customer on `exchangeAccountId`, or else on their current
 * exchange account (current-account.ts). The worker acts only if that
 * customer owns it.
 */
export async function callWorkerForAccount<T>(
  request: Omit<WorkerRequest<T>, "customerId" | "exchangeAccountId">,
  exchangeAccountId?: string,
): Promise<WorkerResult<T>> {
  if (exchangeAccountId !== undefined)
    return callWorkerForCustomer({ ...request, exchangeAccountId });
  const account = await getCurrentExchangeAccount(listAccounts);
  if (!account) return failure("no_exchange_account");
  if ("reason" in account) return account;
  return callWorkerForCustomer({ ...request, exchangeAccountId: account.id });
}

/**
 * The ID of the exchange account this request acts on, or undefined when
 * the customer has none the worker serves, or it cannot say.
 */
export async function currentExchangeAccountId(): Promise<string | undefined> {
  const account = await getCurrentExchangeAccount(listAccounts);
  return account && !("reason" in account) ? account.id : undefined;
}
