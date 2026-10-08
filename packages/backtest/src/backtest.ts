import Decimal from "decimal.js";

import type { Instrument, StrategyKind } from "@crypto-trading/domain";

import { HOUR_MS, missingHours } from "./candles";
import type { BacktestAssumptions } from "./market";
import {
  buyAndHold,
  maxDrawdown,
  PERIODS_PER_YEAR,
  RISK_FREE_RATE_PERCENT,
  sharpeRatio,
  tradeStats,
  type Drawdown,
  type TradeStats,
} from "./metrics";
import type { RecordedProposalFixture } from "./recorded-proposals";
import {
  simulate,
  type BacktestInput,
  type BacktestNotice,
  type BacktestTrade,
  type StrategyState,
} from "./simulator";

export type BacktestResult = {
  instrument: Instrument;
  strategyKind: StrategyKind;
  // Set when the run replays recorded proposals: never AI performance.
  fixture?: { id: string; title: string; provenance: string };
  // The first candle's open and the last candle's close.
  period: { start: string; end: string };
  candles: number;
  missingHours: number;
  allocation: string;
  assumptions: BacktestAssumptions;
  market: {
    tickSize: string;
    stepSize: string;
    minNotional: string;
    maxStopOrders: number;
  };
  entryLimit: number;
  state: StrategyState;
  notices: BacktestNotice[];
  rejections: Record<string, number>;
  metrics: {
    netPnl: string;
    returnPercent: string;
    fees: string;
    realizedPnl: string;
    unrealizedPnl: string;
    finalEquity: string;
    maxDrawdown: Drawdown;
    sharpe: {
      value: string | null;
      riskFreeRatePercent: string;
      periodsPerYear: number;
    };
    trades: TradeStats;
  };
  baseline: {
    netPnl: string;
    returnPercent: string;
    maxDrawdown: Drawdown;
    quantity: string;
    entryPrice: string;
    fee: string;
  };
  // The strategy's and the baseline's equity: at the first open, then at
  // every close.
  equity: { time: number; strategy: string; baseline: string }[];
  trades: BacktestTrade[];
  limitations: string[];
};

/** Simulates the input and measures the run against buying and holding. */
export function runBacktest(
  input: BacktestInput & { fixture?: RecordedProposalFixture },
): BacktestResult {
  const run = simulate(input);
  const baseline = buyAndHold(input);
  const allocation = new Decimal(input.allocation);
  const growth = (equity: string) => new Decimal(equity).minus(allocation);
  const percentOf = (amount: Decimal) =>
    amount.dividedBy(allocation).times(100).toFixed();
  const netPnl = growth(run.finalEquity);
  const baselineNet = growth(
    baseline.equity[baseline.equity.length - 1].equity,
  );
  const first = input.candles[0];
  const last = input.candles[input.candles.length - 1];
  const missing = missingHours(input.candles).length;
  const { rules: filters, maxStopOrders } = input.market;

  return {
    instrument: input.instrument,
    strategyKind: input.rules.kind,
    ...(input.fixture
      ? {
          fixture: {
            id: input.fixture.id,
            title: input.fixture.title,
            provenance: input.fixture.provenance,
          },
        }
      : {}),
    period: {
      start: new Date(first.openTime).toISOString(),
      end: new Date(last.openTime + HOUR_MS).toISOString(),
    },
    candles: input.candles.length,
    missingHours: missing,
    allocation: allocation.toFixed(),
    assumptions: input.assumptions,
    market: {
      tickSize: new Decimal(filters.tickSize).toFixed(),
      stepSize: new Decimal(filters.stepSize).toFixed(),
      minNotional: new Decimal(filters.minNotional).toFixed(),
      maxStopOrders,
    },
    entryLimit: run.entryLimit,
    state: run.state,
    notices: run.notices,
    rejections: run.rejections,
    metrics: {
      netPnl: netPnl.toFixed(),
      returnPercent: percentOf(netPnl),
      fees: run.fees,
      realizedPnl: run.realizedPnl,
      unrealizedPnl: run.unrealizedPnl,
      finalEquity: run.finalEquity,
      maxDrawdown: maxDrawdown(run.equity),
      sharpe: {
        value: sharpeRatio(run.equity),
        riskFreeRatePercent: RISK_FREE_RATE_PERCENT,
        periodsPerYear: PERIODS_PER_YEAR,
      },
      trades: tradeStats(run.trades),
    },
    baseline: {
      netPnl: baselineNet.toFixed(),
      returnPercent: percentOf(baselineNet),
      maxDrawdown: maxDrawdown(baseline.equity),
      quantity: baseline.quantity,
      entryPrice: baseline.entryPrice,
      fee: baseline.fee,
    },
    equity: run.equity.map((point, index) => ({
      time: point.time,
      strategy: point.equity,
      baseline: baseline.equity[index].equity,
    })),
    trades: run.trades,
    limitations: backtestLimitations({
      assumptions: input.assumptions,
      maxStopOrders,
      entryLimit: run.entryLimit,
      missingHours: missing,
      replay: input.fixture !== undefined,
    }),
  };
}

/** What the simulator leaves out, shown with every result. */
export function backtestLimitations(context: {
  assumptions: BacktestAssumptions;
  maxStopOrders: number;
  entryLimit: number;
  missingHours: number;
  replay: boolean;
}): string[] {
  const { makerFeePercent, takerFeePercent, slippagePercent } =
    context.assumptions;
  return [
    ...(context.replay
      ? [
          "This replays a fixture of recorded proposals. It shows how the execution checks and the simulator treat those decisions, not how the AI trades.",
        ]
      : []),
    "Candles give only each hour's open, high, low and close, so within a candle the simulator assumes the worst order: a stop loss fills before a take profit, and an entry that fills during a candle can be stopped out in it but takes no profit until the next one.",
    "Limit orders fill only when the price trades through them, in full, at their own price. Within a candle, resting entries fill first, then each open entry's stop or target, and orders never compete for liquidity. Queue position, partial fills and order book depth are not modelled.",
    `Taker fills (buys at the ask, stop losses, and closes for deadlines, loss limits and range exits) land ${slippagePercent}% beyond the price, and a stop the market opens through sells from the open. Real slippage depends on liquidity and can be much larger.`,
    `Fees are ${makerFeePercent}% on maker fills and ${takerFeePercent}% on taker fills, charged in USDT. Binance takes a buy's fee in the asset bought, so its exits sell slightly less.`,
    "The strategy acts once an hour, at each candle's open, where it places entries and enforces expiries and holding deadlines. Loss limits are measured at each open and close. An exit can come up to an hour late, and a loss can pass a limit within the hour before it is measured.",
    "Fills and exits are timed to the hourly candle they happen in. An entry that fills during a candle starts its holding period at that candle's close, the latest it could have filled, so it never closes early.",
    "Equity, drawdown and the Sharpe ratio use hourly closes, so a fall and recovery within an hour does not show.",
    "A strategy paused by a loss limit stays paused for the rest of the backtest. A customer could resume it.",
    `At most ${context.entryLimit} entries are held at once: Binance allows ${context.maxStopOrders} open stop orders per symbol per account, and the backtest assumes no other order uses them.`,
    "Exchange filters (tick size, lot step and minimum order value) are today's, from Binance's public market data. They may have differed during the period.",
    `History comes from Binance's live spot market at data-api.binance.vision, not the testnet, which keeps about a day of candles.${context.missingHours ? ` ${context.missingHours} ${context.missingHours === 1 ? "hour is" : "hours are"} missing from it, and the Sharpe ratio counts the step across each gap as one return.` : ""}`,
    "Open entries and the buy-and-hold baseline are valued at the last close, without a sell fee.",
    "Past results do not predict future ones. Passing software tests is not evidence of profitable trading.",
  ];
}
