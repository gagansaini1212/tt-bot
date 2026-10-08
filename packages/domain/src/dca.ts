import Decimal from "decimal.js";

import { ceilToStep, quantityFor } from "./decimal";
import type { EntryPlan, InstrumentSteps } from "./entry-plans";
import { protectionIsValid } from "./protection";
import {
  largestDcaBuy,
  type DcaInterval,
  type DcaRules,
} from "./strategy-rules";

export const DCA_INTERVAL_MS: Record<DcaInterval, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
};

/** When buy `index` is due. Buy 0 is due at startsAt. */
export function dcaBuyDueAt(rules: DcaRules, index: number) {
  return new Date(
    Date.parse(rules.startsAt) + index * DCA_INTERVAL_MS[rules.interval],
  );
}

/**
 * The buy due at `now`: due from its time until the next buy's. -1 before
 * the schedule starts, and maxBuys or more once it has ended.
 */
export function dcaBuyIndexAt(rules: DcaRules, now: Date) {
  const elapsed = now.getTime() - Date.parse(rules.startsAt);
  if (elapsed < 0) return -1;
  return Math.floor(elapsed / DCA_INTERVAL_MS[rules.interval]);
}

/**
 * What a buy at `price` spends. With a dip rule, a price at least dropPercent
 * below the previous buy's entry price spends the multiplied amount. The
 * multiplier applies to amountPerBuy, never to an earlier dip buy.
 */
export function dcaBuyAmount(
  rules: DcaRules,
  price: string,
  previousBuy?: { entryPrice: string },
): { amount: string; dip: boolean } {
  if (rules.dip && previousBuy) {
    const threshold = new Decimal(previousBuy.entryPrice).times(
      new Decimal(1).minus(new Decimal(rules.dip.dropPercent).dividedBy(100)),
    );
    if (new Decimal(price).lessThanOrEqualTo(threshold))
      return { amount: largestDcaBuy(rules).toFixed(), dip: true };
  }
  return { amount: new Decimal(rules.amountPerBuy).toFixed(), dip: false };
}

export type DcaState = {
  now: Date;
  // The best ask. A buy is a limit buy at this price.
  price: string;
  steps: InstrumentSteps;
  // The latest buy submitted: its index in the schedule and entry price.
  previousBuy?: { index: number; entryPrice: string };
  // Protected entries the strategy holds now, pending or open, and the most it
  // may hold at once.
  protectedEntries: number;
  maxProtectedEntries: number;
};

/**
 * The DCA's next buy. Each due buy is submitted at most once, as a limit buy
 * at the best ask that expires when the next buy is due. A buy that cannot be
 * made while it is due is skipped, never made up later. Its stop loss and take
 * profit are set from its entry price and rounded to the tick: the stop up,
 * so it never risks more than stopLossPercent, and the target up.
 */
export function planDcaBuy(rules: DcaRules, state: DcaState): EntryPlan {
  const index = dcaBuyIndexAt(rules, state.now);
  if (index < 0)
    return {
      action: "wait",
      reason: "not_started",
      until: new Date(rules.startsAt).toISOString(),
    };
  if (index >= rules.maxBuys)
    return { action: "no_more_entries", reason: "schedule_complete" };

  const nextDueAt = dcaBuyDueAt(rules, index + 1).toISOString();
  if (state.previousBuy && state.previousBuy.index >= index) {
    return index + 1 >= rules.maxBuys
      ? { action: "no_more_entries", reason: "schedule_complete" }
      : { action: "wait", reason: "buy_made", until: nextDueAt };
  }
  if (state.protectedEntries >= state.maxProtectedEntries)
    return { action: "wait", reason: "entry_limit", until: nextDueAt };

  const { amount } = dcaBuyAmount(rules, state.price, state.previousBuy);
  const quantity = quantityFor(amount, state.price, state.steps.quantityStep);
  const entry = new Decimal(state.price);
  const percent = (value: string) => new Decimal(value).dividedBy(100);
  const stopLoss = ceilToStep(
    entry.times(new Decimal(1).minus(percent(rules.stopLossPercent))),
    state.steps.tickSize,
  );
  const takeProfit = ceilToStep(
    entry.times(new Decimal(1).plus(percent(rules.takeProfitPercent))),
    state.steps.tickSize,
  );
  if (
    quantity.isZero() ||
    !protectionIsValid("long", entry, stopLoss, takeProfit)
  )
    return { action: "wait", reason: "unprotectable", until: nextDueAt };

  return {
    action: "enter",
    intents: [
      {
        key: `buy:${index}`,
        instrument: rules.instrument,
        marketKind: "spot",
        direction: "long",
        leverage: 1,
        quantity: quantity.toFixed(),
        entryPrice: entry.toFixed(),
        stopLossPrice: stopLoss.toFixed(),
        takeProfitPrice: takeProfit.toFixed(),
        entryExpiresAt: nextDueAt,
        holdingPeriodSeconds: rules.holdingPeriodSeconds,
      },
    ],
  };
}
