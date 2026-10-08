import Decimal from "decimal.js";

import type { EntryIntent, EntryPlan } from "./entry-plans";
import type { StandingPriceInstructionRules } from "./strategy-rules";

/** The protected entry for the instruction's entry at `index`, as written. */
export function standingEntryIntent(
  rules: StandingPriceInstructionRules,
  index: number,
): EntryIntent {
  const entry = rules.entries[index];
  if (!entry)
    throw new RangeError(
      `The instruction has entries 0 to ${rules.entries.length - 1}, not ${index}.`,
    );
  return {
    key: `entry:${index}`,
    instrument: rules.instrument,
    marketKind: rules.marketKind,
    direction: rules.direction,
    leverage: rules.leverage,
    quantity: entry.quantity,
    entryPrice: entry.entryPrice,
    stopLossPrice: entry.stopLossPrice,
    takeProfitPrice: entry.takeProfitPrice,
    entryExpiresAt: new Date(rules.entryExpiresAt).toISOString(),
    holdingPeriodSeconds: rules.holdingPeriodSeconds,
  };
}

export type StandingInstructionState = {
  now: Date;
  // Every entry submitted under the instruction: its index in the rules, how
  // much it filled, and whether it has closed.
  entries: { index: number; filledQuantity: string; closed: boolean }[];
  // The most protected entries the strategy may hold at once.
  maxProtectedEntries: number;
};

/**
 * The instruction's next entries, in the order it lists them. An entry that
 * filled any quantity is never submitted again. One that closed unfilled, as
 * a pause cancels it, is submitted again until the instruction expires.
 */
export function planStandingEntries(
  rules: StandingPriceInstructionRules,
  state: StandingInstructionState,
): EntryPlan {
  const filled = new Set(
    state.entries
      .filter((entry) => new Decimal(entry.filledQuantity).greaterThan(0))
      .map((entry) => entry.index),
  );
  if (rules.entries.every((_, index) => filled.has(index)))
    return { action: "finished", reason: "all_entries_filled" };
  if (state.now.getTime() >= Date.parse(rules.entryExpiresAt))
    return { action: "finished", reason: "expired" };

  const unclosed = state.entries.filter((entry) => !entry.closed);
  const active = new Set(unclosed.map((entry) => entry.index));
  const free = rules.entries
    .map((_, index) => index)
    .filter((index) => !filled.has(index) && !active.has(index));
  if (free.length === 0) return { action: "wait", reason: "entries_pending" };

  const capacity = state.maxProtectedEntries - unclosed.length;
  if (capacity <= 0) return { action: "wait", reason: "entry_limit" };
  return {
    action: "enter",
    intents: free
      .slice(0, capacity)
      .map((index) => standingEntryIntent(rules, index)),
  };
}
