import Decimal from "decimal.js";

import { ceilToStep, ExactDecimal, quantityFor } from "@crypto-trading/domain";

import { HOUR_MS, type Candle } from "./candles";
import type { BacktestAssumptions, BacktestMarket } from "./market";
import type { BacktestTrade, EquityPoint } from "./simulator";

/**
 * How the Sharpe ratio is annualised: hourly returns, and crypto markets
 * trade every hour of a 365-day year.
 */
export const PERIODS_PER_YEAR = 24 * 365;
/** The annual risk-free rate the Sharpe ratio subtracts, in percent. */
export const RISK_FREE_RATE_PERCENT = "0";

export type Drawdown = {
  // The largest fall from a running peak, in USDT and as a percentage of
  // that peak, and when the peak and the trough were.
  amount: string;
  percent: string;
  peakAt?: number;
  troughAt?: number;
};

/** The deepest fall in equity from an earlier peak, measured by percentage. */
export function maxDrawdown(points: readonly EquityPoint[]): Drawdown {
  let worst: Drawdown = { amount: "0", percent: "0" };
  let worstShare = new Decimal(0);
  let peak = points[0];
  for (const point of points) {
    if (new Decimal(point.equity).greaterThan(peak.equity)) peak = point;
    const fall = new Decimal(peak.equity).minus(point.equity);
    if (!fall.greaterThan(0)) continue;
    const share = fall.dividedBy(peak.equity);
    if (share.greaterThan(worstShare)) {
      worstShare = share;
      worst = {
        amount: fall.toFixed(),
        percent: share.times(100).toFixed(),
        peakAt: peak.time,
        troughAt: point.time,
      };
    }
  }
  return worst;
}

/**
 * The annualised Sharpe ratio of the equity curve: the mean hourly return
 * above the risk-free rate, over the sample standard deviation of hourly
 * returns, times √(periods per year). The annual risk-free rate is spread
 * evenly across the year's hours. Null with fewer than two returns, or when
 * equity never changes.
 */
export function sharpeRatio(
  points: readonly EquityPoint[],
  riskFreeRatePercent = RISK_FREE_RATE_PERCENT,
  periodsPerYear = PERIODS_PER_YEAR,
): string | null {
  const riskFree = new Decimal(riskFreeRatePercent)
    .dividedBy(100)
    .dividedBy(periodsPerYear);
  const excess: Decimal[] = [];
  for (let index = 1; index < points.length; index++) {
    const before = new Decimal(points[index - 1].equity);
    if (!before.greaterThan(0)) return null;
    excess.push(
      new Decimal(points[index].equity)
        .dividedBy(before)
        .minus(1)
        .minus(riskFree),
    );
  }
  if (excess.length < 2) return null;
  const mean = Decimal.sum(...excess).dividedBy(excess.length);
  const variance = Decimal.sum(
    ...excess.map((value) => value.minus(mean).pow(2)),
  ).dividedBy(excess.length - 1);
  if (variance.isZero()) return null;
  return mean
    .dividedBy(variance.sqrt())
    .times(new Decimal(periodsPerYear).sqrt())
    .toFixed();
}

export type TradeStats = {
  // Entries that filled, closed and still open.
  trades: number;
  closed: number;
  open: number;
  // Closed trades by their result after fees.
  wins: number;
  losses: number;
  breakeven: number;
  // Percentages of closed trades. Null before any trade closes.
  winRate: string | null;
  lossRate: string | null;
};

export function tradeStats(trades: readonly BacktestTrade[]): TradeStats {
  const closed = trades.filter((trade) => trade.exit);
  const wins = closed.filter((trade) => new Decimal(trade.pnl).greaterThan(0));
  const losses = closed.filter((trade) => new Decimal(trade.pnl).lessThan(0));
  const rate = (count: number) =>
    closed.length === 0
      ? null
      : new Decimal(count).dividedBy(closed.length).times(100).toFixed();
  return {
    trades: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    winRate: rate(wins.length),
    lossRate: rate(losses.length),
  };
}

export type Baseline = {
  quantity: string;
  entryPrice: string;
  fee: string;
  equity: EquityPoint[];
};

/**
 * Buying with the whole allocation at the first candle's open and holding to
 * the end, as the strategy would: a taker buy at the open plus slippage,
 * rounded to the tick, paying the taker fee. The holding is valued at each
 * close, without a sell fee, as the strategy's open entries are.
 */
export function buyAndHold({
  candles,
  allocation,
  market,
  assumptions,
}: {
  candles: readonly Candle[];
  allocation: string;
  market: BacktestMarket;
  assumptions: BacktestAssumptions;
}): Baseline {
  const taker = new Decimal(assumptions.takerFeePercent).dividedBy(100);
  const price = new Decimal(candles[0].open).times(
    new Decimal(1).plus(
      new Decimal(assumptions.slippagePercent).dividedBy(100),
    ),
  );
  const entryPrice = ceilToStep(price, market.rules.tickSize);
  // Leave room for the fee, so the buy and its fee fit the allocation.
  const spend = new ExactDecimal(allocation).dividedBy(taker.plus(1));
  const quantity = quantityFor(
    spend.toFixed(),
    entryPrice,
    market.rules.stepSize,
  );
  const notional = quantity.times(entryPrice);
  const fee = notional.times(taker);
  const cash = new Decimal(allocation).minus(notional).minus(fee);
  return {
    quantity: quantity.toFixed(),
    entryPrice: entryPrice.toFixed(),
    fee: fee.toFixed(),
    equity: [
      { time: candles[0].openTime, equity: new Decimal(allocation).toFixed() },
      ...candles.map((candle) => ({
        time: candle.openTime + HOUR_MS,
        equity: cash.plus(quantity.times(candle.close)).toFixed(),
      })),
    ],
  };
}
