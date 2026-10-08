import {
  DAY_MS,
  type BacktestResult,
  type ExitReason,
} from "@crypto-trading/backtest";
import Decimal from "decimal.js";

import { formatDecimal } from "@/lib/decimals";

const hour = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const day = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});
const dayWithYear = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Sep 4, 14:00", in UTC. */
export function formatHour(time: number | string) {
  return hour.format(new Date(time));
}

/** "Sep 4", in UTC. */
export function formatDay(time: number | string) {
  return day.format(new Date(time));
}

/** "Sep 4 – Oct 3, 2026": the days a period's hours cover, in UTC. */
export function formatPeriod(period: { start: string; end: string }) {
  // The period ends at the last candle's close, which belongs to its day.
  const last = Date.parse(period.end) - 1;
  return `${formatDay(period.start)} – ${dayWithYear.format(new Date(last))}`;
}

/** An amount in USDT to two places, signed: "+12.30", "-0.45", "0.00". */
export function formatSigned(value: string) {
  const rounded = new Decimal(value).toDecimalPlaces(2);
  const text = formatDecimal(rounded.abs(), 2);
  return rounded.isZero() ? text : `${rounded.isNegative() ? "-" : "+"}${text}`;
}

/** A percentage to two places, with a sign unless `unsigned`. */
export function formatPercentage(value: string, { unsigned = false } = {}) {
  const text = formatSigned(value);
  return `${unsigned ? text.replace(/^[+-]/, "") : text}%`;
}

/** A price, keeping its decimals up to eight, with thousands grouped. */
export function formatPriceText(value: string) {
  const decimals = new Decimal(value).decimalPlaces();
  return formatDecimal(value, Math.min(8, Math.max(2, decimals)));
}

/** An amount of USDT to two places, with thousands grouped. */
export function formatUsdt(value: Decimal.Value) {
  return formatDecimal(value, 2);
}

/** A quantity with exactly its own decimals: "0.00124". */
export function formatQuantity(value: string) {
  return formatDecimal(value, new Decimal(value).decimalPlaces());
}

export const EXIT_REASONS: Record<ExitReason, string> = {
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  holding_deadline: "Holding deadline",
  loss_limit: "Loss limit",
  range_exit: "Left the range",
};

export const STATE_LABELS: Record<BacktestResult["state"], string> = {
  running: "Running at the end",
  paused: "Paused",
  completed: "Completed",
};

export const REJECTION_LABELS: Record<string, string> = {
  allocation_exceeded: "allocation fully committed",
  position_limit_exceeded: "position limit",
  entry_limit_exceeded: "entry limit",
  direction_not_allowed: "direction not allowed",
  market_kind_not_allowed: "market not allowed",
  instrument_not_allowed: "instrument not allowed",
  leverage_exceeded: "leverage",
  invalid_protection: "invalid stop or target",
  entry_expired: "expired",
  exchange_filter: "exchange filters",
};

/** "level:3" → "Level 4", "buy:0" → "Buy 1". */
export function entryName(key: string) {
  const [kind, index] = key.split(":");
  const number = Number(index) + 1;
  const names: Record<string, string> = {
    level: "Level",
    buy: "Buy",
    entry: "Entry",
    proposal: "Proposal",
  };
  return names[kind] ? `${names[kind]} ${number}` : key;
}

/** The strategy's equity at each UTC midnight and at the end, for a table. */
export function dailyEquity(result: BacktestResult) {
  const rows = result.equity.filter(
    (point, index) =>
      point.time % DAY_MS === 0 || index === result.equity.length - 1,
  );
  return rows;
}
