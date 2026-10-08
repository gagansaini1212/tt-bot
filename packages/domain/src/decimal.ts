import Decimal from "decimal.js";
import { z } from "zod";

// The pattern check aborts, so later checks only ever parse valid decimals.
export const decimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, {
  error: "Must be a non-negative decimal string",
  abort: true,
});

export const positiveDecimalString = decimalString.refine(
  (value) => new Decimal(value).greaterThan(0),
  "Must be greater than zero",
);

/** A decimal string that may be negative, such as a profit or loss. */
export const signedDecimalString = z
  .string()
  .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/, {
    error: "Must be a decimal string",
    abort: true,
  });

function positiveStep(step: Decimal.Value) {
  const value = new Decimal(step);
  if (!value.greaterThan(0)) throw new RangeError("A step must be positive.");
  return value;
}

/** Rounds a non-negative value down to a multiple of `step`, exactly. */
export function floorToStep(value: Decimal.Value, step: Decimal.Value) {
  const size = positiveStep(step);
  return new Decimal(value).dividedToIntegerBy(size).times(size);
}

/** Rounds a non-negative value up to a multiple of `step`, exactly. */
export function ceilToStep(value: Decimal.Value, step: Decimal.Value) {
  const amount = new Decimal(value);
  const floored = floorToStep(amount, step);
  return floored.lessThan(amount) ? floored.plus(step) : floored;
}

/**
 * The most whole steps of quantity that `amount` buys at `price`, so the
 * notional never exceeds the amount. Exact: no division is rounded.
 */
export function quantityFor(
  amount: Decimal.Value,
  price: Decimal.Value,
  quantityStep: Decimal.Value,
) {
  const step = positiveStep(quantityStep);
  return new Decimal(amount)
    .dividedToIntegerBy(new Decimal(price).times(step))
    .times(step);
}
