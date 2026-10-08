// Browser-safe: what the Strategies page sends the execution worker and what
// it answers. The web server checks requests with these schemas before
// sending them, and the worker checks them again.
import Decimal from "decimal.js";
import { z } from "zod";
import {
  allocationIssues,
  strategyRulesSchema,
  strategyStatusSchema,
  type StrategyRules,
} from "@crypto-trading/domain";
import { testnetInstrumentSchema } from "./order-rules";

const decimal = z
  .string()
  .max(60)
  .regex(/^\d+(\.\d+)?$/);
const signedDecimal = z
  .string()
  .max(61)
  .regex(/^-?\d+(\.\d+)?$/);
const timestamp = z.iso.datetime({ offset: true });

export const strategyKindSchema = z.enum([
  "grid",
  "dca",
  "ai_managed",
  "standing_price_instruction",
]);
export type StrategyKindName = z.infer<typeof strategyKindSchema>;

export const STRATEGY_KIND_LABELS: Record<StrategyKindName, string> = {
  grid: "Grid",
  dca: "DCA",
  ai_managed: "AI-managed",
  standing_price_instruction: "Standing price instruction",
};

/**
 * Whether the customer approves each of an AI-managed strategy's proposals,
 * or the worker submits each one that passes the strategy's limits.
 */
export const approvalModeSchema = z.enum(["required", "automatic"]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/** How often the worker asks the AI, in minutes. */
export const AI_ANALYSIS_INTERVALS = [15, 60, 240, 1440] as const;

export const aiSettingsSchema = z.strictObject({
  proposalApproval: approvalModeSchema,
  analysisIntervalMinutes: z.int().min(15).max(1440),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

// An amount in USDT, the testnet account's accounting currency.
const usdtAmount = z
  .string()
  .max(21)
  .regex(/^\d{1,12}(\.\d{1,8})?$/)
  .refine((value) => /[1-9]/.test(value), "Must be greater than zero");

/** Problems a strategy's rules have on the Binance Spot Testnet account. */
export function testnetRuleIssues(
  rules: StrategyRules,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (rules.marketKind !== "spot")
    issues.push({
      path: ["marketKind"],
      message: "This exchange account trades spot only.",
    });
  const instruments =
    rules.kind === "ai_managed" ? rules.allowedInstruments : [rules.instrument];
  if (
    !instruments.every(
      (instrument) => testnetInstrumentSchema.safeParse(instrument).success,
    )
  )
    issues.push({
      path: [],
      message: "This exchange account trades BTC/USDT and ETH/USDT only.",
    });
  return issues;
}

/**
 * A strategy as the customer configures it: a name, its allocation, its
 * rules, and, for an AI-managed strategy, how its proposals are approved and
 * how often the AI is asked. The rules must fit the allocation.
 */
export const strategyDraftSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    allocation: usdtAmount,
    rules: strategyRulesSchema,
    ai: aiSettingsSchema.nullable(),
  })
  .superRefine(
    (draft, ctx) => {
      if ((draft.rules.kind === "ai_managed") !== (draft.ai !== null))
        ctx.addIssue({
          code: "custom",
          message:
            "An AI-managed strategy needs its approval and schedule settings, and only it has them.",
          path: ["ai"],
        });
      for (const issue of [
        ...testnetRuleIssues(draft.rules),
        ...allocationIssues(draft.rules, draft.allocation),
      ])
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path.length ? ["rules", ...issue.path] : ["allocation"],
        });
      // Only once every field is valid on its own.
    },
    { when: (payload) => payload.issues.length === 0 },
  );
export type StrategyDraft = z.infer<typeof strategyDraftSchema>;

/** A new version of a strategy, made from the version the customer edited. */
export const strategyVersionRequestSchema = z.strictObject({
  strategyId: z.uuid(),
  baseVersion: z.int().positive(),
  draft: strategyDraftSchema,
});
export type StrategyVersionRequest = z.infer<
  typeof strategyVersionRequestSchema
>;

export const strategyActionRequestSchema = z.strictObject({
  strategyId: z.uuid(),
});

/** One loss limit, measured: profit, or loss as a negative amount. */
const lossMeasureSchema = z.object({
  pnl: signedDecimal,
  loss: decimal,
  limit: decimal,
  reached: z.boolean(),
});

/**
 * What a strategy has made or lost, in USDT. Realized PnL is before fees,
 * which are listed on their own. Current value is the allocation plus
 * realized PnL, less fees, plus unrealized PnL. A strategy that cannot be
 * measured opens no entries.
 */
export const strategyMeasureSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("measured"),
    measuredAt: timestamp,
    realizedPnl: signedDecimal,
    fees: decimal,
    unrealizedPnl: signedDecimal,
    currentValue: signedDecimal,
    // Capital of open entries and reservations of pending ones, at their
    // entry prices.
    committed: decimal,
    reserved: decimal,
    daily: lossMeasureSchema,
    total: lossMeasureSchema,
  }),
  z.object({
    status: z.literal("unmeasured"),
    reason: z.string().max(300),
  }),
]);
export type StrategyMeasure = z.infer<typeof strategyMeasureSchema>;

export const strategyViewSchema = z.object({
  id: z.uuid(),
  name: z.string().max(80),
  status: strategyStatusSchema,
  version: z.int().positive(),
  createdAt: timestamp,
  rules: strategyRulesSchema,
  ai: aiSettingsSchema.nullable(),
  allocation: decimal,
  pauseReason: z.string().max(40).nullable(),
  pausedAt: timestamp.nullable(),
  // The exit every entry gets until the customer resumes: pause, or a
  // reason that also sells what the entries hold.
  exitRequest: z.string().max(40).nullable(),
  rulesEnded: z
    .object({ at: timestamp, reason: z.string().max(40) })
    .nullable(),
  completedAt: timestamp.nullable(),
  runnerNote: z.string().max(500),
  runnerCheckedAt: timestamp.nullable(),
  nextAnalysisAt: timestamp.nullable(),
  entries: z.object({
    // Sent or being sent, with nothing filled yet.
    pending: z.int().nonnegative(),
    // Holding what they filled.
    open: z.int().nonnegative(),
    // AI proposals waiting for the customer's approval.
    awaitingApproval: z.int().nonnegative(),
  }),
  measure: strategyMeasureSchema,
  // The AI's latest decision, for an AI-managed strategy.
  latestDecision: z
    .object({
      at: timestamp,
      kind: z.enum(["trade_proposal", "no_trade"]),
      model: z.string().max(200),
      // From a recorded fixture, not a model.
      fixture: z.boolean(),
    })
    .nullable(),
});
export type StrategyView = z.infer<typeof strategyViewSchema>;

/** A market a strategy can trade, with Binance's rules and latest prices. */
export const strategyMarketSchema = z.object({
  instrument: testnetInstrumentSchema,
  lastPrice: decimal.nullable(),
  bestAsk: decimal.nullable(),
  tickSize: decimal,
  stepSize: decimal,
  minNotional: decimal,
  maxStopOrders: z.int().positive(),
  // Stop orders open on the symbol now, null if they could not be read.
  stopOrdersInUse: z.int().nonnegative().nullable(),
});
export type StrategyMarket = z.infer<typeof strategyMarketSchema>;

export const portfolioLimitsStateSchema = z.object({
  current: z
    .object({
      version: z.int().positive(),
      maxDailyDrawdownPercent: decimal,
      createdAt: timestamp,
    })
    .nullable(),
});
export type PortfolioLimitsState = z.infer<typeof portfolioLimitsStateSchema>;

/** Today's result of every strategy together, since midnight UTC. */
export const portfolioTodaySchema = z.object({
  pnl: signedDecimal,
  allocation: decimal,
  drawdownPercent: decimal,
  reached: z.boolean(),
});
export type PortfolioToday = z.infer<typeof portfolioTodaySchema>;

/** Where the AI-managed strategies' decisions come from. */
export const aiSourceSchema = z.object({
  kind: z.enum(["fixture", "eve"]),
  description: z.string().max(500),
});
export type AiSource = z.infer<typeof aiSourceSchema>;

export const strategiesStateSchema = z.object({
  strategies: z.array(strategyViewSchema),
  limits: portfolioLimitsStateSchema,
  // Null while a strategy cannot be measured.
  today: portfolioTodaySchema.nullable(),
  markets: z.array(strategyMarketSchema),
  aiSource: aiSourceSchema,
});
export type StrategiesState = z.infer<typeof strategiesStateSchema>;

/** The outcome of creating, editing, pausing, resuming or closing. */
export const strategyChangeSchema = z.object({
  result: z.enum(["saved", "invalid", "conflict", "refused"]),
  message: z.string().max(500),
  strategy: strategyViewSchema.nullable(),
});
export type StrategyChange = z.infer<typeof strategyChangeSchema>;

export const killSwitchResultSchema = z.object({
  pausedStrategies: z.int().nonnegative(),
  closingEntries: z.int().nonnegative(),
  cancelledTriggers: z.int().nonnegative(),
  message: z.string().max(500),
});
export type KillSwitchResult = z.infer<typeof killSwitchResultSchema>;

export const PORTFOLIO_DRAWDOWN_LIMITS = { min: "0.1", max: "100" } as const;

/** A new portfolio drawdown limit, made from the version the customer edited. */
export const portfolioLimitsChangeRequestSchema = z.strictObject({
  maxDailyDrawdownPercent: z
    .string()
    .max(6)
    .regex(/^\d{1,3}(\.\d{1,2})?$/)
    .refine(
      (value) =>
        new Decimal(value).greaterThanOrEqualTo(
          PORTFOLIO_DRAWDOWN_LIMITS.min,
        ) &&
        new Decimal(value).lessThanOrEqualTo(PORTFOLIO_DRAWDOWN_LIMITS.max),
      `Must be from ${PORTFOLIO_DRAWDOWN_LIMITS.min}% to ${PORTFOLIO_DRAWDOWN_LIMITS.max}%`,
    ),
  // 0 when there was no version yet.
  baseVersion: z.int().nonnegative(),
});
export type PortfolioLimitsChangeRequest = z.infer<
  typeof portfolioLimitsChangeRequestSchema
>;

export const portfolioLimitsChangeSchema = z.object({
  result: z.enum(["saved", "invalid", "conflict"]),
  message: z.string().max(500),
  limits: portfolioLimitsStateSchema,
});
export type PortfolioLimitsChange = z.infer<typeof portfolioLimitsChangeSchema>;

/** What the customer sees for a pause reason or exit request. */
export const STOP_REASON_LABELS: Record<string, string> = {
  customer: "you paused it",
  pause: "paused",
  close_all: "Close all",
  loss_limit: "a loss limit was reached",
  drawdown: "the portfolio's daily drawdown limit was reached",
  kill_switch: "the kill switch",
  protection_failed: "an entry lost its stop loss",
  range_stop: "the market reached the range stop",
  above_range: "the market rose above the range",
};
