import Decimal from "decimal.js";
import { z } from "zod";

import { decimalString, positiveDecimalString } from "./decimal";
import { protectionIsValid } from "./protection";

export const instrumentSchema = z.enum(["BTC-USDT", "ETH-USDT"]);
export const marketKindSchema = z.enum(["spot", "perpetual"]);
export const tradeDirectionSchema = z.enum(["long", "short"]);
export const tradingModeSchema = z.enum(["simulation", "live"]);

export type Instrument = z.infer<typeof instrumentSchema>;
export type MarketKind = z.infer<typeof marketKindSchema>;
export type TradeDirection = z.infer<typeof tradeDirectionSchema>;

export const tradeProposalSchema = z.object({
  proposalId: z.uuid(),
  customerId: z.uuid(),
  exchangeAccountId: z.uuid(),
  strategyId: z.uuid(),
  strategyVersion: z.int().positive(),
  instrument: instrumentSchema,
  marketKind: marketKindSchema,
  direction: tradeDirectionSchema,
  quantity: positiveDecimalString,
  entryPrice: positiveDecimalString,
  stopLossPrice: positiveDecimalString,
  takeProfitPrice: positiveDecimalString,
  leverage: z.int().positive().default(1),
  entryExpiresAt: z.iso.datetime(),
  rationale: z.string().trim().min(1).max(2_000),
  sourceSnapshotId: z.uuid(),
});

export type TradeProposal = z.infer<typeof tradeProposalSchema>;

export const executionPolicySchema = z
  .object({
    customerId: z.uuid(),
    exchangeAccountId: z.uuid(),
    strategyId: z.uuid(),
    strategyVersion: z.int().positive(),
    tradingMode: tradingModeSchema,
    strategyStatus: z.enum(["simulation", "active", "paused"]),
    liveTradingEnabled: z.boolean(),
    allowedInstruments: z.array(instrumentSchema).min(1),
    allocation: positiveDecimalString,
    // Summed across all of the strategy's protected entries: the capital of its
    // open entries, and the reservations of its pending ones.
    committedCapital: decimalString,
    reservedBudget: decimalString,
    // The largest position in one instrument, counting every protected entry the
    // strategy holds in it.
    maxPositionNotional: positiveDecimalString,
    maxLeverage: z.int().positive(),
    // The market kind and directions the strategy's rules allow, when set.
    marketKind: marketKindSchema.optional(),
    allowedDirections: z.array(tradeDirectionSchema).min(1).optional(),
    // A strategy that may hold several protected entries states the most it may
    // hold, how many it holds now, pending or open, and the entry notional of
    // those entries per instrument. A policy without a maximum checks each
    // entry's capital and size on its own.
    maxProtectedEntries: z.int().positive().optional(),
    protectedEntries: z.int().nonnegative().optional(),
    positionNotionalByInstrument: z
      .partialRecord(instrumentSchema, decimalString)
      .optional(),
  })
  .refine(
    (policy) =>
      policy.maxProtectedEntries === undefined ||
      (policy.protectedEntries !== undefined &&
        policy.positionNotionalByInstrument !== undefined),
    {
      error:
        "A policy with an entry limit must state the entries the strategy holds and their notional per instrument.",
      path: ["maxProtectedEntries"],
    },
  );

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export type AuthorizationRejection = {
  allowed: false;
  code:
    | "invalid_proposal"
    | "scope_mismatch"
    | "strategy_not_active"
    | "live_trading_disabled"
    | "instrument_not_allowed"
    | "market_kind_not_allowed"
    | "direction_not_allowed"
    | "unsupported_spot_short"
    | "leverage_exceeded"
    | "invalid_protection"
    | "entry_expired"
    | "entry_limit_exceeded"
    | "position_limit_exceeded"
    | "allocation_exceeded";
  reason: string;
};

export type AuthorizationApproval = {
  allowed: true;
  proposal: TradeProposal;
  reservationAmount: string;
  positionNotional: string;
};

export type AuthorizationResult =
  AuthorizationApproval | AuthorizationRejection;

function reject(
  code: AuthorizationRejection["code"],
  reason: string,
): AuthorizationRejection {
  return { allowed: false, code, reason };
}

export function authorizeTradeProposal(
  rawProposal: unknown,
  rawPolicy: ExecutionPolicy,
  now: Date,
): AuthorizationResult {
  const parsedProposal = tradeProposalSchema.safeParse(rawProposal);
  if (!parsedProposal.success) {
    return reject("invalid_proposal", z.prettifyError(parsedProposal.error));
  }

  const proposal = parsedProposal.data;
  const policy = executionPolicySchema.parse(rawPolicy);

  if (
    proposal.customerId !== policy.customerId ||
    proposal.exchangeAccountId !== policy.exchangeAccountId ||
    proposal.strategyId !== policy.strategyId ||
    proposal.strategyVersion !== policy.strategyVersion
  ) {
    return reject(
      "scope_mismatch",
      "The proposal does not belong to the current customer, account, strategy, and version.",
    );
  }

  const requiredStatus =
    policy.tradingMode === "live" ? "active" : "simulation";
  if (policy.strategyStatus !== requiredStatus) {
    return reject(
      "strategy_not_active",
      `The strategy must be ${requiredStatus} for ${policy.tradingMode} trading.`,
    );
  }

  if (policy.tradingMode === "live" && !policy.liveTradingEnabled) {
    return reject(
      "live_trading_disabled",
      "Live trading is disabled for this deployment.",
    );
  }

  if (!policy.allowedInstruments.includes(proposal.instrument)) {
    return reject(
      "instrument_not_allowed",
      `${proposal.instrument} is outside the strategy's allowed instruments.`,
    );
  }

  if (policy.marketKind && proposal.marketKind !== policy.marketKind) {
    return reject(
      "market_kind_not_allowed",
      `The strategy trades ${policy.marketKind} only.`,
    );
  }

  if (
    policy.allowedDirections &&
    !policy.allowedDirections.includes(proposal.direction)
  ) {
    return reject(
      "direction_not_allowed",
      `The strategy does not open ${proposal.direction} positions.`,
    );
  }

  if (proposal.marketKind === "spot" && proposal.direction === "short") {
    return reject(
      "unsupported_spot_short",
      "The first release does not open short spot positions.",
    );
  }

  if (proposal.leverage > policy.maxLeverage) {
    return reject(
      "leverage_exceeded",
      `Requested leverage ${proposal.leverage} exceeds the configured maximum ${policy.maxLeverage}.`,
    );
  }

  if (
    !protectionIsValid(
      proposal.direction,
      proposal.entryPrice,
      proposal.stopLossPrice,
      proposal.takeProfitPrice,
    )
  ) {
    return reject(
      "invalid_protection",
      "The stop loss and take profit must be on the protective sides of the entry price.",
    );
  }

  if (new Date(proposal.entryExpiresAt).getTime() <= now.getTime()) {
    return reject("entry_expired", "The entry instruction has expired.");
  }

  if (
    policy.maxProtectedEntries !== undefined &&
    (policy.protectedEntries ?? 0) >= policy.maxProtectedEntries
  ) {
    return reject(
      "entry_limit_exceeded",
      `The strategy already holds ${policy.protectedEntries} of its ${policy.maxProtectedEntries} protected entries.`,
    );
  }

  const positionNotional = new Decimal(proposal.quantity).times(
    proposal.entryPrice,
  );
  const heldNotional =
    policy.positionNotionalByInstrument?.[proposal.instrument] ?? "0";
  if (
    positionNotional.plus(heldNotional).greaterThan(policy.maxPositionNotional)
  ) {
    return reject(
      "position_limit_exceeded",
      "The proposed position exceeds the strategy position limit.",
    );
  }

  const reservation =
    proposal.marketKind === "spot"
      ? positionNotional
      : positionNotional.dividedBy(proposal.leverage);
  const available = new Decimal(policy.allocation)
    .minus(policy.committedCapital)
    .minus(policy.reservedBudget);

  if (reservation.greaterThan(available)) {
    return reject(
      "allocation_exceeded",
      "The strategy does not have enough uncommitted allocation for this entry.",
    );
  }

  return {
    allowed: true,
    proposal,
    reservationAmount: reservation.toFixed(),
    positionNotional: positionNotional.toFixed(),
  };
}
