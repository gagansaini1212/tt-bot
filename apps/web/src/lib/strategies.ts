import "server-only";
import {
  killSwitchResultSchema,
  portfolioLimitsChangeSchema,
  portfolioLimitsStateSchema,
  strategiesStateSchema,
  strategyChangeSchema,
  type KillSwitchResult,
  type PortfolioLimitsChangeRequest,
  type PortfolioLimitsState,
  type StrategiesState,
  type StrategyChange,
  type StrategyDraft,
  type StrategyVersionRequest,
} from "@crypto-trading/exchanges/strategies";
import { z } from "zod";
import type { SettingsActionResult } from "./settings";
import {
  callWorkerForAccount,
  type WorkerFailureReason,
  type WorkerState,
} from "./worker-client";

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

/** The outcome of a strategy action, for the page. */
export type StrategyActionResult =
  | StrategyChange
  | {
      result: "unavailable" | "unconfirmed" | "refused";
      message: string;
      strategy: null;
    };

/**
 * Every strategy on the customer's current exchange account, or on
 * `exchangeAccountId`, with its results, and when the worker read them, by
 * its own clock.
 */
export async function getStrategies(
  exchangeAccountId?: string,
): Promise<WorkerState<{ state: StrategiesState; readAt: number }>> {
  const result = await callWorkerForAccount(
    {
      path: "/strategies",
      schema: z.object({ state: strategiesStateSchema }),
    },
    exchangeAccountId,
  );
  return result.status === "connected"
    ? {
        status: "connected",
        state: result.data.state,
        readAt: Date.parse(result.date ?? "") || Date.now(),
      }
    : { status: result.status, message: result.message };
}

async function change(
  path: `/${string}`,
  body: unknown,
  exchangeAccountId?: string,
): Promise<StrategyActionResult> {
  const result = await callWorkerForAccount(
    {
      method: "POST",
      path,
      body,
      schema: z.object({ change: strategyChangeSchema }),
    },
    exchangeAccountId,
  );
  if (result.status === "connected") return result.data.change;
  return NOT_SENT.has(result.reason)
    ? { result: "unavailable", message: result.message, strategy: null }
    : {
        result: "unconfirmed",
        message: `${result.message} The change may or may not have been made: check this page after it refreshes before trying again.`,
        strategy: null,
      };
}

export const createStrategy = (
  draft: StrategyDraft,
  exchangeAccountId?: string,
) => change("/strategies", draft, exchangeAccountId);

export const saveStrategyVersion = (
  request: StrategyVersionRequest,
  exchangeAccountId?: string,
) => change("/strategies/versions", request, exchangeAccountId);

export const pauseStrategy = (
  strategyId: string,
  exchangeAccountId?: string,
) => change("/strategies/pause", { strategyId }, exchangeAccountId);

export const resumeStrategy = (
  strategyId: string,
  exchangeAccountId?: string,
) => change("/strategies/resume", { strategyId }, exchangeAccountId);

export const closeAllStrategy = (
  strategyId: string,
  exchangeAccountId?: string,
) => change("/strategies/close-all", { strategyId }, exchangeAccountId);

/** The kill switch: pauses every strategy and closes every managed entry. */
export async function activateKillSwitch(
  exchangeAccountId?: string,
): Promise<
  | ({ result: "done" } & KillSwitchResult)
  | { result: "unavailable" | "unconfirmed"; message: string }
> {
  const result = await callWorkerForAccount(
    {
      method: "POST",
      path: "/strategies/kill-switch",
      body: {},
      schema: z.object({ result: killSwitchResultSchema }),
    },
    exchangeAccountId,
  );
  if (result.status === "connected")
    return { result: "done", ...result.data.result };
  return NOT_SENT.has(result.reason)
    ? { result: "unavailable", message: result.message }
    : {
        result: "unconfirmed",
        message: `${result.message} The kill switch may or may not have run: check Strategies before using it again.`,
      };
}

export async function getPortfolioLimits(): Promise<
  WorkerState<{ limits: PortfolioLimitsState }>
> {
  const result = await callWorkerForAccount({
    path: "/settings/portfolio-limits",
    schema: z.object({ limits: portfolioLimitsStateSchema }),
  });
  return result.status === "connected"
    ? { status: "connected", limits: result.data.limits }
    : { status: result.status, message: result.message };
}

export async function savePortfolioLimits(
  request: PortfolioLimitsChangeRequest,
): Promise<SettingsActionResult> {
  const result = await callWorkerForAccount({
    method: "POST",
    path: "/settings/portfolio-limits",
    body: request,
    schema: z.object({ change: portfolioLimitsChangeSchema }),
  });
  if (result.status === "connected")
    return {
      result: result.data.change.result,
      message: result.data.change.message,
    };
  return NOT_SENT.has(result.reason)
    ? { result: "unavailable", message: result.message }
    : {
        result: "unconfirmed",
        message: `${result.message} The change may or may not have been made: check this page after it refreshes before trying again.`,
      };
}
