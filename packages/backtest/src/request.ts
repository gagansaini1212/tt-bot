import { z } from "zod";

import {
  allocationIssues,
  positiveDecimalString,
  strategyRulesSchema,
  type Instrument,
  type StrategyRules,
} from "@crypto-trading/domain";

import { DAY_MS } from "./candles";
import { assumptionsSchema, type BacktestAssumptions } from "./market";
import {
  recordedProposalFixture,
  type RecordedProposal,
  type RecordedProposalFixture,
} from "./recorded-proposals";

/** The longest period a backtest replays: 30 days of hourly candles. */
export const MAX_BACKTEST_DAYS = 30;

/** Whole UTC days, from the start of `start` to the end of `end`. */
export const backtestPeriodSchema = z
  .strictObject({ start: z.iso.date(), end: z.iso.date() })
  .refine((period) => period.start <= period.end, {
    error: "The period must not end before it starts.",
    path: ["end"],
  })
  .refine((period) => periodDays(period) <= MAX_BACKTEST_DAYS, {
    error: `A backtest covers at most ${MAX_BACKTEST_DAYS} days.`,
    path: ["end"],
  });

export type BacktestPeriod = z.infer<typeof backtestPeriodSchema>;

export function periodDays(period: { start: string; end: string }) {
  return (Date.parse(period.end) - Date.parse(period.start)) / DAY_MS + 1;
}

/** The period's first candle open and its end, in milliseconds. */
export function periodBounds(period: { start: string; end: string }) {
  return {
    start: Date.parse(`${period.start}T00:00:00.000Z`),
    end: Date.parse(`${period.end}T00:00:00.000Z`) + DAY_MS,
  };
}

const rulesRequestSchema = z
  .strictObject({
    source: z.literal("rules"),
    rules: strategyRulesSchema,
    period: backtestPeriodSchema,
    allocation: positiveDecimalString,
    assumptions: assumptionsSchema,
  })
  .superRefine((request, ctx) => {
    if (request.rules.kind === "ai_managed")
      ctx.addIssue({
        code: "custom",
        message:
          "An AI-managed strategy needs recorded proposals to backtest. Replay a fixture instead.",
        path: ["rules", "kind"],
      });
    else if (request.rules.marketKind !== "spot")
      ctx.addIssue({
        code: "custom",
        message:
          "Backtests cover spot only: perpetual funding, margin and liquidation are not simulated.",
        path: ["rules", "marketKind"],
      });
    for (const issue of allocationIssues(request.rules, request.allocation))
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path.length ? ["rules", ...issue.path] : ["allocation"],
      });
  });

const recordedRequestSchema = z.strictObject({
  source: z.literal("recorded_proposals"),
  fixtureId: z.string().refine((id) => recordedProposalFixture(id), {
    error: "There is no recorded-proposal fixture with that ID.",
  }),
  assumptions: assumptionsSchema,
});

/**
 * What to backtest: a strategy's rules over a period, or a fixture of
 * recorded proposals for an AI-managed strategy, which fixes its own rules,
 * market, period and allocation.
 */
export const backtestRequestSchema = z.discriminatedUnion("source", [
  rulesRequestSchema,
  recordedRequestSchema,
]);

export type BacktestRequest = z.infer<typeof backtestRequestSchema>;

export type ResolvedBacktest = {
  rules: StrategyRules;
  instrument: Instrument;
  // The first candle's open, and the end of the last candle, in milliseconds.
  start: number;
  end: number;
  allocation: string;
  assumptions: BacktestAssumptions;
  fixture?: RecordedProposalFixture;
  proposals?: readonly RecordedProposal[];
};

/** The rules, market and hours a valid request backtests. */
export function resolveBacktest(request: BacktestRequest): ResolvedBacktest {
  if (request.source === "recorded_proposals") {
    const fixture = recordedProposalFixture(request.fixtureId)!;
    return {
      rules: fixture.rules,
      instrument: fixture.instrument,
      ...periodBounds(fixture.period),
      allocation: fixture.allocation,
      assumptions: request.assumptions,
      fixture,
      proposals: fixture.proposals,
    };
  }
  const { rules } = request;
  if (rules.kind === "ai_managed")
    throw new RangeError("AI-managed rules need recorded proposals.");
  return {
    rules,
    instrument: rules.instrument,
    ...periodBounds(request.period),
    allocation: request.allocation,
    assumptions: request.assumptions,
  };
}
