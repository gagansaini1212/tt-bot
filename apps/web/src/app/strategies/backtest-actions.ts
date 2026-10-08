"use server";

import {
  runBacktestRequest,
  summarizePeriod,
  type BacktestOutcome,
  type PeriodSummaryOutcome,
} from "@/lib/backtest";
import { isLocalRequest } from "@/lib/local-request";

// Backtests download and cache market data on this machine, so, like the
// rest of the dashboard, they answer only requests from this machine.
const REFUSED = "Backtests can only be run from the dashboard on this machine.";

export async function runBacktest(input: unknown): Promise<BacktestOutcome> {
  if (!(await isLocalRequest())) return { status: "invalid", message: REFUSED };
  return runBacktestRequest(input);
}

export async function loadPeriodSummary(
  input: unknown,
): Promise<PeriodSummaryOutcome> {
  if (!(await isLocalRequest())) return { status: "invalid", message: REFUSED };
  return summarizePeriod(input);
}
