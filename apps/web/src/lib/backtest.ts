import "server-only";
import { type Instrument, instrumentSchema } from "@crypto-trading/domain";
import {
  backtestPeriodSchema,
  backtestRequestSchema,
  candleSeriesSchema,
  HOUR_MS,
  periodBounds,
  resolveBacktest,
  runBacktest,
  type BacktestResult,
} from "@crypto-trading/backtest";
import { SpotHistoryCache } from "@crypto-trading/exchanges/spot-history-cache";
import { BinanceHistoryError, type Kline } from "@crypto-trading/exchanges";
import Decimal from "decimal.js";
import { z } from "zod";

import { getCurrentCustomer } from "./current-customer";

/** A finished backtest, or why it could not run, safe to show. */
export type BacktestOutcome =
  | { status: "completed"; result: BacktestResult }
  | { status: "invalid" | "unavailable"; message: string };

/** The market over a period: what a customer could see before choosing prices. */
export type PeriodSummary = {
  instrument: Instrument;
  firstOpen: string;
  low: string;
  high: string;
  lastClose: string;
  candles: number;
  tickSize: string;
  stepSize: string;
};

export type PeriodSummaryOutcome =
  | { status: "ready"; summary: PeriodSummary }
  | { status: "invalid" | "unavailable"; message: string };

type HistorySource = Pick<SpotHistoryCache, "hourlyKlines" | "symbolFilters">;

// One cache for the server process, under MARKET_HISTORY_CACHE_DIR or
// .market-history in the working directory.
let sharedHistory: SpotHistoryCache | undefined;
const defaultHistory = () => (sharedHistory ??= new SpotHistoryCache());

// The proxy keeps signed-out visitors off /strategies, but actions are
// reachable without the page, so these functions check again.
const SIGNED_OUT = {
  status: "invalid" as const,
  message: "Sign in to run a backtest.",
};

const UNAVAILABLE =
  "Binance's market data could not be read. Check the connection and try again.";

/** The closed candles of the hours from `start` to `end`, or why there are none. */
async function closedCandles(
  history: HistorySource,
  instrument: Instrument,
  start: number,
  end: number,
  now: number,
) {
  // Only hours that have ended have final candles.
  const until = Math.min(end, Math.floor(now / HOUR_MS) * HOUR_MS);
  if (until <= start)
    return {
      status: "invalid" as const,
      message: "Choose a period that has already started.",
    };
  const klines: Kline[] = await history.hourlyKlines(instrument, start, until);
  if (klines.length === 0)
    return {
      status: "unavailable" as const,
      message: `Binance has no hourly candles for ${instrument.replace("-", "/")} in this period.`,
    };
  return {
    status: "ready" as const,
    candles: candleSeriesSchema.parse(
      klines.map(({ openTime, open, high, low, close }) => ({
        openTime,
        open,
        high,
        low,
        close,
      })),
    ),
  };
}

function failure(error: unknown) {
  return {
    status: "unavailable" as const,
    message: error instanceof BinanceHistoryError ? error.message : UNAVAILABLE,
  };
}

/**
 * Validates a backtest request, reads the period's hourly candles and the
 * market's filters (downloading and caching what is missing), and runs it.
 */
export async function runBacktestRequest(
  input: unknown,
  {
    history = defaultHistory(),
    now = Date.now(),
  }: { history?: HistorySource; now?: number } = {},
): Promise<BacktestOutcome> {
  if (!(await getCurrentCustomer())) return SIGNED_OUT;
  const parsed = backtestRequestSchema.safeParse(input);
  if (!parsed.success)
    return { status: "invalid", message: parsed.error.issues[0].message };
  const backtest = resolveBacktest(parsed.data);
  try {
    const [period, market] = await Promise.all([
      closedCandles(
        history,
        backtest.instrument,
        backtest.start,
        backtest.end,
        now,
      ),
      history.symbolFilters(backtest.instrument),
    ]);
    if (period.status !== "ready") return period;
    return {
      status: "completed",
      result: runBacktest({
        rules: backtest.rules,
        instrument: backtest.instrument,
        candles: period.candles,
        allocation: backtest.allocation,
        market,
        assumptions: backtest.assumptions,
        proposals: backtest.proposals,
        fixture: backtest.fixture,
      }),
    };
  } catch (error) {
    return failure(error);
  }
}

const summaryRequestSchema = z.strictObject({
  instrument: instrumentSchema,
  period: backtestPeriodSchema,
});

/** The period's opening price, range and close, for suggesting rules. */
export async function summarizePeriod(
  input: unknown,
  {
    history = defaultHistory(),
    now = Date.now(),
  }: { history?: HistorySource; now?: number } = {},
): Promise<PeriodSummaryOutcome> {
  if (!(await getCurrentCustomer())) return SIGNED_OUT;
  const parsed = summaryRequestSchema.safeParse(input);
  if (!parsed.success)
    return { status: "invalid", message: parsed.error.issues[0].message };
  const { instrument, period } = parsed.data;
  const { start, end } = periodBounds(period);
  try {
    const [result, market] = await Promise.all([
      closedCandles(history, instrument, start, end, now),
      history.symbolFilters(instrument),
    ]);
    if (result.status !== "ready") return result;
    const { candles } = result;
    const prices = (pick: "low" | "high") => candles.map((c) => c[pick]);
    return {
      status: "ready",
      summary: {
        instrument,
        firstOpen: candles[0].open,
        low: minimum(prices("low")),
        high: maximum(prices("high")),
        lastClose: candles[candles.length - 1].close,
        candles: candles.length,
        tickSize: market.rules.tickSize,
        stepSize: market.rules.stepSize,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

function minimum(values: string[]) {
  return values.reduce((low, value) =>
    new Decimal(value).lessThan(low) ? value : low,
  );
}
function maximum(values: string[]) {
  return values.reduce((high, value) =>
    new Decimal(value).greaterThan(high) ? value : high,
  );
}
