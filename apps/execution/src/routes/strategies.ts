import {
  portfolioLimitsChangeRequestSchema,
  strategyActionRequestSchema,
  strategyDraftSchema,
  strategyVersionRequestSchema,
  type BinanceSpotTestnet,
  type KillSwitchResult,
  type PortfolioLimitsChange,
  type StrategyChange,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import { accountHandler, handler } from "../http";
import type { StrategyRunner } from "../strategy-runner";
import type { ControlResult } from "../strategy-store";

const empty = z.strictObject({});

/**
 * The Strategies page: each strategy with its results and controls, the
 * portfolio's drawdown today, and the kill switch. Requests are checked
 * against the shared schemas here, whatever the web server checked.
 */
export function strategies(
  runner: Pick<StrategyRunner, "state" | "resumeProblem" | "store">,
) {
  const { store } = runner;
  // The strategy as the page shows it after a change.
  const answer = async (
    account: AccountScope,
    exchange: BinanceSpotTestnet,
    result: ControlResult,
  ): Promise<{ status: "connected"; change: StrategyChange }> => {
    let strategy: StrategyChange["strategy"] = null;
    if (result.result === "saved")
      strategy =
        (await runner.state(account, exchange)).strategies.find(
          (entry) => entry.id === result.strategy.id,
        ) ?? null;
    return {
      status: "connected",
      change: { result: result.result, message: result.message, strategy },
    };
  };
  const invalid = (error: z.ZodError) => {
    const [issue] = error.issues;
    const path = issue.path.join(".");
    return {
      status: "connected",
      change: {
        result: "invalid",
        message: (path ? `${path}: ${issue.message}` : issue.message).slice(
          0,
          500,
        ),
        strategy: null,
      } satisfies StrategyChange,
    };
  };
  return {
    list: handler({
      query: empty,
      handle: async ({ exchange, account }) => ({
        status: "connected",
        state: await runner.state(account, exchange),
      }),
    }),
    create: handler({
      query: empty,
      // Checked below, so the page learns what to fix.
      body: z.unknown(),
      async handle({ exchange, account, body }) {
        const draft = strategyDraftSchema.safeParse(body);
        if (!draft.success) return invalid(draft.error);
        return answer(
          account,
          exchange,
          await store.create(account, draft.data, new Date()),
        );
      },
    }),
    newVersion: handler({
      query: empty,
      body: z.unknown(),
      async handle({ exchange, account, body }) {
        const request = strategyVersionRequestSchema.safeParse(body);
        if (!request.success) return invalid(request.error);
        const { strategyId, baseVersion, draft } = request.data;
        return answer(
          account,
          exchange,
          await store.newVersion(account, strategyId, baseVersion, draft),
        );
      },
    }),
    pause: handler({
      query: empty,
      body: strategyActionRequestSchema,
      handle: async ({ exchange, account, body }) =>
        answer(account, exchange, await store.pause(account, body.strategyId)),
    }),
    resume: handler({
      query: empty,
      body: strategyActionRequestSchema,
      async handle({ exchange, account, body }) {
        const problem = await runner.resumeProblem(
          account,
          exchange,
          body.strategyId,
        );
        return answer(
          account,
          exchange,
          problem
            ? { result: "refused", message: problem }
            : await store.resume(account, body.strategyId),
        );
      },
    }),
    closeAll: handler({
      query: empty,
      body: strategyActionRequestSchema,
      handle: async ({ exchange, account, body }) =>
        answer(
          account,
          exchange,
          await store.closeAll(account, body.strategyId),
        ),
    }),
    killSwitch: accountHandler({
      query: empty,
      body: empty,
      async handle({ account }) {
        const counts = await store.killSwitch(account);
        return {
          status: "connected",
          result: {
            ...counts,
            message:
              "Every strategy is paused. The worker is cancelling every entry it manages and selling what they hold at market on its next pass, within seconds.",
          } satisfies KillSwitchResult,
        };
      },
    }),
    portfolioLimits: accountHandler({
      query: empty,
      handle: async ({ account }) => ({
        status: "connected",
        limits: await store.portfolioLimits(account),
      }),
    }),
    changePortfolioLimits: accountHandler({
      query: empty,
      body: portfolioLimitsChangeRequestSchema,
      async handle({ account, body }) {
        const { saved, limits } = await store.changePortfolioLimits(
          account,
          body.maxDailyDrawdownPercent,
          body.baseVersion,
        );
        return {
          status: "connected",
          change: {
            result: saved ? "saved" : "conflict",
            message: saved
              ? `Saved version ${limits.current!.version}. Every strategy is paused when their losses since midnight UTC reach ${limits.current!.maxDailyDrawdownPercent}% of their allocations.`
              : "The limit was changed elsewhere since you opened it. Review the latest version and save again.",
            limits,
          } satisfies PortfolioLimitsChange,
        };
      },
    }),
  };
}
