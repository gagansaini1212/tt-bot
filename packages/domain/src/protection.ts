import Decimal from "decimal.js";

import type { TradeDirection } from "./trading";

/**
 * Whether the stop loss and take profit sit on the protective sides of the
 * entry: below and above it for a long, above and below it for a short.
 */
export function protectionIsValid(
  direction: TradeDirection,
  entryPrice: Decimal.Value,
  stopLossPrice: Decimal.Value,
  takeProfitPrice: Decimal.Value,
) {
  const entry = new Decimal(entryPrice);
  return direction === "long"
    ? entry.greaterThan(stopLossPrice) && entry.lessThan(takeProfitPrice)
    : entry.lessThan(stopLossPrice) && entry.greaterThan(takeProfitPrice);
}

export type ProtectionChangeResult =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "stop_loss_removed"
        | "stop_loss_loosened"
        | "take_profit_fixed"
        | "would_trigger_now";
      reason: string;
    };

/**
 * Checks an AI change to an open entry's stop loss. The AI may tighten a stop
 * but never remove it or loosen it to accept a larger loss. A stop that the
 * market has already passed would close the entry at once, which is a close,
 * not a stop change.
 */
export function checkStopLossChange(change: {
  direction: TradeDirection;
  currentStopLossPrice: string;
  proposedStopLossPrice: string | null;
  marketPrice: string;
}): ProtectionChangeResult {
  if (change.proposedStopLossPrice === null) {
    return {
      allowed: false,
      code: "stop_loss_removed",
      reason: "Every filled quantity keeps a stop loss.",
    };
  }
  const proposed = new Decimal(change.proposedStopLossPrice);
  const loosened =
    change.direction === "long"
      ? proposed.lessThan(change.currentStopLossPrice)
      : proposed.greaterThan(change.currentStopLossPrice);
  if (loosened) {
    return {
      allowed: false,
      code: "stop_loss_loosened",
      reason: `A stop loss may only move closer to the market. ${change.proposedStopLossPrice} would accept a larger loss than ${change.currentStopLossPrice}.`,
    };
  }
  const triggered =
    change.direction === "long"
      ? proposed.greaterThanOrEqualTo(change.marketPrice)
      : proposed.lessThanOrEqualTo(change.marketPrice);
  if (triggered) {
    return {
      allowed: false,
      code: "would_trigger_now",
      reason: `A stop loss at ${change.proposedStopLossPrice} would trigger at once with the market at ${change.marketPrice}.`,
    };
  }
  return { allowed: true };
}

/**
 * Checks an AI change to an open entry's take profit. Targets are fixed unless
 * the customer lets the AI adjust them, and a target the market has already
 * passed would close the entry at once.
 */
export function checkTakeProfitChange(change: {
  direction: TradeDirection;
  takeProfitAdjustable: boolean;
  proposedTakeProfitPrice: string;
  marketPrice: string;
}): ProtectionChangeResult {
  if (!change.takeProfitAdjustable) {
    return {
      allowed: false,
      code: "take_profit_fixed",
      reason: "The customer has not let the AI adjust this strategy's targets.",
    };
  }
  const proposed = new Decimal(change.proposedTakeProfitPrice);
  const triggered =
    change.direction === "long"
      ? proposed.lessThanOrEqualTo(change.marketPrice)
      : proposed.greaterThanOrEqualTo(change.marketPrice);
  if (triggered) {
    return {
      allowed: false,
      code: "would_trigger_now",
      reason: `A take profit at ${change.proposedTakeProfitPrice} would trigger at once with the market at ${change.marketPrice}.`,
    };
  }
  return { allowed: true };
}
