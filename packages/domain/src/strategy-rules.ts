import Decimal from "decimal.js";
import { z } from "zod";

import { positiveDecimalString } from "./decimal";
import { protectionIsValid } from "./protection";
import {
  instrumentSchema,
  marketKindSchema,
  tradeDirectionSchema,
  type Instrument,
  type MarketKind,
} from "./trading";

/**
 * Bounds that every strategy's rules stay within. Platform maximums, which
 * deployment sets, may be lower. Percentages are of the entry price.
 */
export const RULE_BOUNDS = {
  minHoldingPeriodSeconds: 60,
  maxHoldingPeriodSeconds: 90 * 24 * 60 * 60,
  maxStandingEntries: 10,
  maxPerpetualLeverage: 10,
  maxAiProtectedEntries: 10,
  minGridLevels: 2,
  maxGridLevels: 100,
  maxDcaBuys: 1_000,
  minProtectionPercent: "0.1",
  maxStopLossPercent: "50",
  maxTakeProfitPercent: "1000",
  minDipDropPercent: "0.1",
  maxDipDropPercent: "50",
  maxDipMultiplier: "2",
} as const;

function decimalBetween(min: string, max: string, unit: string) {
  return positiveDecimalString.refine(
    (value) =>
      new Decimal(value).greaterThanOrEqualTo(min) &&
      new Decimal(value).lessThanOrEqualTo(max),
    `Must be from ${min} to ${max}${unit}`,
  );
}

// Cross-field checks run only once every field is valid on its own.
const whenFieldsAreValid = {
  when: (payload: { issues: unknown[] }) => payload.issues.length === 0,
};

const holdingPeriodSeconds = z
  .int()
  .min(RULE_BOUNDS.minHoldingPeriodSeconds)
  .max(RULE_BOUNDS.maxHoldingPeriodSeconds);

/**
 * Daily and total loss limits, in the accounting currency. Every strategy has
 * both, and the daily limit is no higher than the total.
 */
export const lossLimitsSchema = z
  .strictObject({
    daily: positiveDecimalString,
    total: positiveDecimalString,
  })
  .refine(
    (limits) => new Decimal(limits.daily).lessThanOrEqualTo(limits.total),
    {
      error: "The daily loss limit cannot exceed the total loss limit.",
      path: ["daily"],
      ...whenFieldsAreValid,
    },
  );

export type LossLimits = z.infer<typeof lossLimitsSchema>;

/** One protected entry of a standing price instruction. */
const standingEntrySchema = z.strictObject({
  quantity: positiveDecimalString,
  entryPrice: positiveDecimalString,
  stopLossPrice: positiveDecimalString,
  takeProfitPrice: positiveDecimalString,
});

/**
 * A customer's entries at their own prices. The AI never changes them. Every
 * entry carries its own stop loss and take profit, and unfilled entries
 * expire together.
 */
export const standingPriceInstructionRulesSchema = z
  .strictObject({
    kind: z.literal("standing_price_instruction"),
    instrument: instrumentSchema,
    marketKind: marketKindSchema,
    direction: tradeDirectionSchema,
    leverage: z.int().min(1).max(RULE_BOUNDS.maxPerpetualLeverage),
    entries: z
      .array(standingEntrySchema)
      .min(1)
      .max(RULE_BOUNDS.maxStandingEntries),
    entryExpiresAt: z.iso.datetime(),
    holdingPeriodSeconds,
    lossLimits: lossLimitsSchema,
  })
  .superRefine((rules, ctx) => {
    if (rules.marketKind === "spot") {
      if (rules.direction === "short")
        ctx.addIssue({
          code: "custom",
          message: "Spot entries are long only.",
          path: ["direction"],
        });
      if (rules.leverage !== 1)
        ctx.addIssue({
          code: "custom",
          message: "Spot entries are unleveraged.",
          path: ["leverage"],
        });
    }
    rules.entries.forEach((entry, index) => {
      if (
        !protectionIsValid(
          rules.direction,
          entry.entryPrice,
          entry.stopLossPrice,
          entry.takeProfitPrice,
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "The stop loss and take profit must be on the protective sides of the entry price.",
          path: ["entries", index],
        });
    });
  }, whenFieldsAreValid);

/**
 * The AI proposes each protected entry within these limits, and every
 * proposal passes the execution checks before it can trade.
 */
export const aiManagedRulesSchema = z
  .strictObject({
    kind: z.literal("ai_managed"),
    allowedInstruments: z.array(instrumentSchema).min(1),
    marketKind: marketKindSchema,
    allowShort: z.boolean(),
    maxLeverage: z.int().min(1).max(RULE_BOUNDS.maxPerpetualLeverage),
    // The largest position in one instrument, across its protected entries.
    maxPositionNotional: positiveDecimalString,
    maxProtectedEntries: z.int().min(1).max(RULE_BOUNDS.maxAiProtectedEntries),
    holdingPeriodSeconds,
    // Whether the AI may move a take profit. It may always tighten a stop.
    takeProfitAdjustable: z.boolean(),
    lossLimits: lossLimitsSchema,
  })
  .superRefine((rules, ctx) => {
    if (
      new Set(rules.allowedInstruments).size !== rules.allowedInstruments.length
    )
      ctx.addIssue({
        code: "custom",
        message: "List each instrument once.",
        path: ["allowedInstruments"],
      });
    if (rules.marketKind === "spot") {
      if (rules.allowShort)
        ctx.addIssue({
          code: "custom",
          message: "Spot entries are long only.",
          path: ["allowShort"],
        });
      if (rules.maxLeverage !== 1)
        ctx.addIssue({
          code: "custom",
          message: "Spot entries are unleveraged.",
          path: ["maxLeverage"],
        });
    }
  }, whenFieldsAreValid);

export const dcaIntervalSchema = z.enum(["1h", "4h", "12h", "1d", "1w"]);
export type DcaInterval = z.infer<typeof dcaIntervalSchema>;

/**
 * Spot buys of a fixed amount on a schedule. Each buy is its own protected
 * entry, with a stop loss and take profit set from its entry price.
 */
export const dcaRulesSchema = z.strictObject({
  kind: z.literal("dca"),
  instrument: instrumentSchema,
  marketKind: z.literal("spot"),
  // Quote currency spent by a buy without the dip multiplier.
  amountPerBuy: positiveDecimalString,
  interval: dcaIntervalSchema,
  // When the first buy is due. Buy n is due n intervals later.
  startsAt: z.iso.datetime(),
  // Scheduled buys. A buy that is not made while it is due is skipped, so the
  // schedule ends maxBuys intervals after startsAt.
  maxBuys: z.int().min(1).max(RULE_BOUNDS.maxDcaBuys),
  stopLossPercent: decimalBetween(
    RULE_BOUNDS.minProtectionPercent,
    RULE_BOUNDS.maxStopLossPercent,
    "%",
  ),
  takeProfitPercent: decimalBetween(
    RULE_BOUNDS.minProtectionPercent,
    RULE_BOUNDS.maxTakeProfitPercent,
    "%",
  ),
  // A buy due when the price is at least dropPercent below the previous buy's
  // entry price spends amountPerBuy times multiplier. It never compounds.
  dip: z
    .strictObject({
      dropPercent: decimalBetween(
        RULE_BOUNDS.minDipDropPercent,
        RULE_BOUNDS.maxDipDropPercent,
        "%",
      ),
      multiplier: positiveDecimalString.refine(
        (value) =>
          new Decimal(value).greaterThan(1) &&
          new Decimal(value).lessThanOrEqualTo(RULE_BOUNDS.maxDipMultiplier),
        `Must be above 1 and at most ${RULE_BOUNDS.maxDipMultiplier}`,
      ),
    })
    .optional(),
  holdingPeriodSeconds,
  lossLimits: lossLimitsSchema,
});

/**
 * Spot buys resting at equally spaced levels in a price range. A buy at one
 * level takes profit at the next level up, and every grid entry shares the
 * range stop below the lowest level.
 */
export const gridRulesSchema = z
  .strictObject({
    kind: z.literal("grid"),
    instrument: instrumentSchema,
    marketKind: z.literal("spot"),
    lowerPrice: positiveDecimalString,
    upperPrice: positiveDecimalString,
    // Levels including both ends of the range. The top level only sells.
    levelCount: z
      .int()
      .min(RULE_BOUNDS.minGridLevels)
      .max(RULE_BOUNDS.maxGridLevels),
    // Quote currency spent by a buy at any level.
    amountPerLevel: positiveDecimalString,
    rangeStopPrice: positiveDecimalString,
    // The grid opens no entries after this.
    entryExpiresAt: z.iso.datetime(),
    holdingPeriodSeconds,
    lossLimits: lossLimitsSchema,
  })
  .superRefine((rules, ctx) => {
    const lower = new Decimal(rules.lowerPrice);
    const upper = new Decimal(rules.upperPrice);
    if (!upper.greaterThan(lower)) {
      ctx.addIssue({
        code: "custom",
        message: "The upper price must be above the lower price.",
        path: ["upperPrice"],
      });
      return;
    }
    if (!lower.greaterThan(rules.rangeStopPrice))
      ctx.addIssue({
        code: "custom",
        message: "The range stop must be below the lower price.",
        path: ["rangeStopPrice"],
      });
    const span = upper.minus(lower);
    const gaps = rules.levelCount - 1;
    if (!span.dividedBy(gaps).times(gaps).equals(span))
      ctx.addIssue({
        code: "custom",
        message: `The range must divide into ${gaps} equal steps with an exact decimal price.`,
        path: ["levelCount"],
      });
  }, whenFieldsAreValid);

/** The rules a strategy version stores, by strategy kind. */
export const strategyRulesSchema = z.discriminatedUnion("kind", [
  standingPriceInstructionRulesSchema,
  aiManagedRulesSchema,
  dcaRulesSchema,
  gridRulesSchema,
]);

export type StrategyRules = z.infer<typeof strategyRulesSchema>;
export type StrategyKind = StrategyRules["kind"];
export type StandingPriceInstructionRules = z.infer<
  typeof standingPriceInstructionRulesSchema
>;
export type AiManagedRules = z.infer<typeof aiManagedRulesSchema>;
export type DcaRules = z.infer<typeof dcaRulesSchema>;
export type GridRules = z.infer<typeof gridRulesSchema>;

/** The most a DCA buy can spend: amountPerBuy, times the dip multiplier. */
export function largestDcaBuy(rules: DcaRules) {
  return new Decimal(rules.amountPerBuy).times(rules.dip?.multiplier ?? 1);
}

/**
 * The most capital the rules can commit at once, in the quote currency, with
 * every entry they can make pending or open together. An AI-managed strategy
 * can fill each allowed instrument's position limit.
 */
export function maximumCommitment(rules: StrategyRules): string {
  switch (rules.kind) {
    case "standing_price_instruction":
      return rules.entries
        .reduce(
          (total, entry) =>
            total.plus(new Decimal(entry.quantity).times(entry.entryPrice)),
          new Decimal(0),
        )
        .dividedBy(rules.marketKind === "spot" ? 1 : rules.leverage)
        .toFixed();
    case "ai_managed":
      return new Decimal(rules.maxPositionNotional)
        .times(rules.allowedInstruments.length)
        .toFixed();
    case "dca":
      return largestDcaBuy(rules).times(rules.maxBuys).toFixed();
    case "grid":
      return new Decimal(rules.amountPerLevel)
        .times(rules.levelCount - 1)
        .toFixed();
  }
}

/** The execution policy limits a strategy version's rules set. */
export type RuleLimits = {
  allowedInstruments: Instrument[];
  marketKind: MarketKind;
  maxLeverage: number;
  maxPositionNotional: string;
  maxProtectedEntries: number;
};

export function ruleLimits(rules: StrategyRules): RuleLimits {
  switch (rules.kind) {
    case "standing_price_instruction":
      return {
        allowedInstruments: [rules.instrument],
        marketKind: rules.marketKind,
        maxLeverage: rules.leverage,
        maxPositionNotional: rules.entries
          .reduce(
            (total, entry) =>
              total.plus(new Decimal(entry.quantity).times(entry.entryPrice)),
            new Decimal(0),
          )
          .toFixed(),
        maxProtectedEntries: rules.entries.length,
      };
    case "ai_managed":
      return {
        allowedInstruments: rules.allowedInstruments,
        marketKind: rules.marketKind,
        maxLeverage: rules.maxLeverage,
        maxPositionNotional: rules.maxPositionNotional,
        maxProtectedEntries: rules.maxProtectedEntries,
      };
    case "dca":
      return {
        allowedInstruments: [rules.instrument],
        marketKind: "spot",
        maxLeverage: 1,
        maxPositionNotional: maximumCommitment(rules),
        maxProtectedEntries: rules.maxBuys,
      };
    case "grid":
      return {
        allowedInstruments: [rules.instrument],
        marketKind: "spot",
        maxLeverage: 1,
        maxPositionNotional: maximumCommitment(rules),
        maxProtectedEntries: rules.levelCount - 1,
      };
  }
}

export type RuleIssue = { path: (string | number)[]; message: string };

/**
 * Where the rules do not fit the strategy's allocation. The entries a
 * standing instruction, DCA or grid plans must all fit at once, so the
 * allocation never has to turn one of them away. An AI-managed strategy's
 * position limit must fit, and the allocation bounds its entries together.
 * A total loss limit above the allocation could never be reached on spot.
 */
export function allocationIssues(
  rules: StrategyRules,
  allocation: string,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (rules.kind === "ai_managed") {
    if (new Decimal(rules.maxPositionNotional).greaterThan(allocation))
      issues.push({
        path: ["maxPositionNotional"],
        message: `The position limit of ${rules.maxPositionNotional} is more than the allocation of ${allocation}.`,
      });
  } else {
    const commitment = maximumCommitment(rules);
    if (new Decimal(commitment).greaterThan(allocation))
      issues.push({
        path: [],
        message: `These rules can commit ${commitment} at once, more than the allocation of ${allocation}.`,
      });
  }
  if (new Decimal(rules.lossLimits.total).greaterThan(allocation))
    issues.push({
      path: ["lossLimits", "total"],
      message: `The total loss limit of ${rules.lossLimits.total} is more than the allocation of ${allocation}.`,
    });
  return issues;
}

/** The rules schema, also requiring the rules to fit `allocation`. */
export function strategyRulesWithinAllocation(allocation: string) {
  const amount = positiveDecimalString.parse(allocation);
  return strategyRulesSchema.superRefine((rules, ctx) => {
    for (const issue of allocationIssues(rules, amount))
      ctx.addIssue({ code: "custom", ...issue });
  }, whenFieldsAreValid);
}
