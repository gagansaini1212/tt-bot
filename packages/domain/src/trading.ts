import Decimal from "decimal.js";
import { z } from "zod";

const decimalString = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, "Must be a non-negative decimal string");

const positiveDecimalString = decimalString.refine(
  (value) => new Decimal(value).greaterThan(0),
  "Must be greater than zero",
);

export const instrumentSchema = z.enum(["BTC-USDT", "ETH-USDT"]);
export const marketKindSchema = z.enum(["spot", "perpetual"]);
export const tradeDirectionSchema = z.enum(["long", "short"]);
export const tradingModeSchema = z.enum(["simulation", "live"]);

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

export const executionPolicySchema = z.object({
  customerId: z.uuid(),
  exchangeAccountId: z.uuid(),
  strategyId: z.uuid(),
  strategyVersion: z.int().positive(),
  tradingMode: tradingModeSchema,
  strategyStatus: z.enum(["simulation", "active", "paused"]),
  liveTradingEnabled: z.boolean(),
  allowedInstruments: z.array(instrumentSchema).min(1),
  allocation: positiveDecimalString,
  committedCapital: decimalString,
  reservedBudget: decimalString,
  maxPositionNotional: positiveDecimalString,
  maxLeverage: z.int().positive(),
});

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export type AuthorizationRejection = {
  allowed: false;
  code:
    | "invalid_proposal"
    | "scope_mismatch"
    | "strategy_not_active"
    | "live_trading_disabled"
    | "instrument_not_allowed"
    | "unsupported_spot_short"
    | "leverage_exceeded"
    | "invalid_protection"
    | "entry_expired"
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

  const entry = new Decimal(proposal.entryPrice);
  const stop = new Decimal(proposal.stopLossPrice);
  const target = new Decimal(proposal.takeProfitPrice);
  const protectionIsValid =
    proposal.direction === "long"
      ? stop.lessThan(entry) && target.greaterThan(entry)
      : stop.greaterThan(entry) && target.lessThan(entry);

  if (!protectionIsValid) {
    return reject(
      "invalid_protection",
      "The stop loss and take profit must be on the protective sides of the entry price.",
    );
  }

  if (new Date(proposal.entryExpiresAt).getTime() <= now.getTime()) {
    return reject("entry_expired", "The entry instruction has expired.");
  }

  const positionNotional = new Decimal(proposal.quantity).times(entry);
  if (positionNotional.greaterThan(policy.maxPositionNotional)) {
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
