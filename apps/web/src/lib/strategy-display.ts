// Browser-safe helpers for the Strategies page.
import Decimal from "decimal.js";
import { ruleLimits, type StrategyRules } from "@crypto-trading/domain";
import type { StrategyView } from "@crypto-trading/exchanges/strategies";

/** The markets a strategy trades, such as "BTC/USDT, ETH/USDT". */
export function strategyMarkets(rules: StrategyRules) {
  return ruleLimits(rules)
    .allowedInstruments.map((instrument) => instrument.replace("-", "/"))
    .join(", ");
}

/**
 * A strategy's figures in USDT: its current value, its unrealized PnL, and
 * its realized PnL after fees. Undefined while it cannot be measured.
 */
export function strategyPnl(strategy: StrategyView) {
  const { measure } = strategy;
  if (measure.status !== "measured") return undefined;
  return {
    currentValue: measure.currentValue,
    unrealized: measure.unrealizedPnl,
    realized: new Decimal(measure.realizedPnl).minus(measure.fees).toFixed(),
    fees: measure.fees,
  };
}

/** How much of a loss limit is used, as a percentage from 0 to 100. */
export function lossShare(loss: string, limit: string) {
  const amount = new Decimal(limit);
  if (!amount.greaterThan(0)) return 0;
  return Decimal.min(new Decimal(loss).dividedBy(amount).times(100), 100)
    .toDecimalPlaces(1)
    .toNumber();
}
