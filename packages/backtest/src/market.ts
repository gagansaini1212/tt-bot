import Decimal from "decimal.js";
import { z } from "zod";

import { decimalString } from "@crypto-trading/domain";
import type { MarketRules } from "@crypto-trading/exchanges/market-catalogue";

/**
 * The exchange's rules for the backtested market: its price, quantity and
 * notional filters, and how many stop orders an account may hold open on it
 * (Binance's MAX_NUM_ALGO_ORDERS). Every protected entry's stop is one of
 * those orders, so the stop-order limit caps the entries held at once.
 */
export type BacktestMarket = {
  rules: MarketRules;
  maxStopOrders: number;
};

function percentUpTo(max: string) {
  return decimalString.refine(
    (value) => new Decimal(value).lessThanOrEqualTo(max),
    `Must be from 0 to ${max}%`,
  );
}

/**
 * Trading costs, as percentages. A maker fill rests on the book and a taker
 * fill takes from it. Slippage is how far a taker fill lands from the price
 * the simulator sees, against the trader.
 */
export const assumptionsSchema = z.strictObject({
  makerFeePercent: percentUpTo("1"),
  takerFeePercent: percentUpTo("1"),
  slippagePercent: percentUpTo("5"),
});

export type BacktestAssumptions = z.infer<typeof assumptionsSchema>;

/**
 * Binance Spot's standard rate for a regular (VIP 0) account, 0.1% maker and
 * taker, without the BNB discount, and a modest slippage on taker fills.
 */
export const DEFAULT_ASSUMPTIONS: BacktestAssumptions = {
  makerFeePercent: "0.1",
  takerFeePercent: "0.1",
  slippagePercent: "0.05",
};
