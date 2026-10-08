import Decimal from "decimal.js";

import { quantityFor } from "./decimal";
import type { EntryIntent, EntryPlan, InstrumentSteps } from "./entry-plans";
import type { GridRules } from "./strategy-rules";

/** Every level's price, lowest first. The last level is the upper price. */
export function gridLevels(rules: GridRules): string[] {
  const lower = new Decimal(rules.lowerPrice);
  const spacing = new Decimal(rules.upperPrice)
    .minus(lower)
    .dividedBy(rules.levelCount - 1);
  return Array.from({ length: rules.levelCount }, (_, level) =>
    lower.plus(spacing.times(level)).toFixed(),
  );
}

/**
 * Where the market is against the range. At or below the range stop, every
 * grid entry's stop has been reached. Above the upper price, every level's
 * take profit has been. Either way the market has left the range, and the
 * grid closes what remains and stops.
 */
export function gridRangePosition(
  rules: GridRules,
  price: string,
): "in_range" | "range_stop" | "above_range" {
  if (new Decimal(price).lessThanOrEqualTo(rules.rangeStopPrice))
    return "range_stop";
  if (new Decimal(price).greaterThan(rules.upperPrice)) return "above_range";
  return "in_range";
}

/**
 * The protected entry for a buy level, counted from 0 at the lower price: a
 * limit buy of amountPerLevel at the level, taking profit at the next level up
 * and stopped at the range stop. Undefined when amountPerLevel buys less than
 * one quantity step there.
 */
export function gridLevelEntry(
  rules: GridRules,
  level: number,
  steps: InstrumentSteps,
): EntryIntent | undefined {
  if (!Number.isInteger(level) || level < 0 || level > rules.levelCount - 2)
    throw new RangeError(
      `Buy levels run from 0 to ${rules.levelCount - 2}, not ${level}.`,
    );
  const levels = gridLevels(rules);
  const quantity = quantityFor(
    rules.amountPerLevel,
    levels[level],
    steps.quantityStep,
  );
  if (quantity.isZero()) return undefined;
  return {
    key: `level:${level}`,
    instrument: rules.instrument,
    marketKind: "spot",
    direction: "long",
    leverage: 1,
    quantity: quantity.toFixed(),
    entryPrice: levels[level],
    stopLossPrice: new Decimal(rules.rangeStopPrice).toFixed(),
    takeProfitPrice: levels[level + 1],
    entryExpiresAt: new Date(rules.entryExpiresAt).toISOString(),
    holdingPeriodSeconds: rules.holdingPeriodSeconds,
  };
}

export type GridState = {
  now: Date;
  // The last traded price.
  price: string;
  steps: InstrumentSteps;
  // Buy levels whose entries are pending or open. A closed entry frees its
  // level for the next buy.
  occupiedLevels: number[];
  // The most protected entries the strategy may hold at once.
  maxProtectedEntries: number;
};

/**
 * The grid's next entries. It buys only at free levels strictly below the
 * market, nearest first, so no buy fills at once, and it never buys to stock
 * the levels above. Leaving the range closes everything.
 */
export function planGridEntries(rules: GridRules, state: GridState): EntryPlan {
  const position = gridRangePosition(rules, state.price);
  if (position !== "in_range") return { action: "close_all", reason: position };
  if (state.now.getTime() >= Date.parse(rules.entryExpiresAt))
    return { action: "finished", reason: "expired" };

  const occupied = new Set(state.occupiedLevels);
  const capacity = state.maxProtectedEntries - occupied.size;
  if (capacity <= 0) return { action: "wait", reason: "entry_limit" };

  const levels = gridLevels(rules);
  const free: number[] = [];
  for (let level = rules.levelCount - 2; level >= 0; level--) {
    if (
      !occupied.has(level) &&
      new Decimal(levels[level]).lessThan(state.price)
    )
      free.push(level);
  }
  if (free.length === 0) return { action: "wait", reason: "no_free_level" };

  const intents = free
    .map((level) => gridLevelEntry(rules, level, state.steps))
    .filter((intent) => intent !== undefined)
    .slice(0, capacity);
  if (intents.length === 0)
    return { action: "wait", reason: "amount_too_small" };
  return { action: "enter", intents };
}
