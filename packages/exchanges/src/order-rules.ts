// Browser-safe: the dashboard runs these checks for its preview, and the
// worker runs them again before it submits.
import { instrumentSchema } from "@crypto-trading/domain";
import Decimal from "decimal.js";
import { z } from "zod";
import type { MarketRules } from "./market-catalogue";

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
export const positiveDecimal = decimal.refine((value) => /[1-9]/.test(value));

// Binance accepts 36 characters. Three are kept for the leg suffixes below.
export const listClientOrderIdSchema = z
  .string()
  .regex(/^ct_[A-Za-z0-9_-]{1,30}$/);
const legSuffixes = {
  entry: "_en",
  takeProfit: "_tp",
  stopLoss: "_sl",
} as const;
export type ProtectedLeg = keyof typeof legSuffixes;

export function protectedLegIds(listClientOrderId: string) {
  return {
    entry: `${listClientOrderId}${legSuffixes.entry}`,
    takeProfit: `${listClientOrderId}${legSuffixes.takeProfit}`,
    stopLoss: `${listClientOrderId}${legSuffixes.stopLoss}`,
  };
}

/**
 * The client order ID of the worker's `attempt`th market sell closing a
 * protected entry. Each attempt has its own ID, so none is sent twice.
 */
export function closeOrderId(listClientOrderId: string, attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9)
    throw new Error("Close attempts are numbered 1 to 9.");
  return `${listClientOrderIdSchema.parse(listClientOrderId)}_c${attempt}`;
}

/**
 * A strategy's protected entries have list client order IDs that start with
 * this, so dashboard limits can leave them out: they count against their
 * strategy's allocation instead.
 */
export const STRATEGY_LIST_PREFIX = "ct_sg";

export function isStrategyListId(listClientOrderId: string) {
  return listClientOrderId.startsWith(STRATEGY_LIST_PREFIX);
}

/** Recognises the legs of a protected entry placed by this application. */
export function protectedLeg(
  clientOrderId: string,
): { listClientOrderId: string; leg: ProtectedLeg } | undefined {
  const match = /^(ct_[A-Za-z0-9_-]{1,30})_(en|tp|sl)$/.exec(clientOrderId);
  if (!match) return undefined;
  const leg = (Object.keys(legSuffixes) as ProtectedLeg[]).find(
    (key) => legSuffixes[key] === `_${match[2]}`,
  )!;
  return { listClientOrderId: match[1], leg };
}

/**
 * A long spot entry whose exits Binance places itself: a LIMIT buy that, once
 * completely filled, places a LIMIT_MAKER take profit and a STOP_LOSS sell as
 * one-cancels-the-other (OPOCO).
 */
export const protectedEntrySchema = z
  .object({
    instrument: instrumentSchema,
    quantity: positiveDecimal,
    price: positiveDecimal,
    // FOK fills completely or not at all, so a marketable entry never leaves
    // a partly filled position without exits.
    timeInForce: z.enum(["GTC", "FOK"]),
    takeProfitPrice: positiveDecimal,
    stopLossPrice: positiveDecimal,
    listClientOrderId: listClientOrderIdSchema,
  })
  .refine(
    (entry) =>
      new Decimal(entry.stopLossPrice).lessThan(entry.price) &&
      new Decimal(entry.takeProfitPrice).greaterThan(entry.price),
    "Spot entries are long only: the stop loss must be below the entry price and the take profit above it.",
  );
export type ProtectedEntry = z.infer<typeof protectedEntrySchema>;

/**
 * Binance sizes the exits from what the entry received after fees, rounded
 * down to the lot step, and checks them only once the entry fills. Exits that
 * fail then would leave the position unprotected, so require them to pass even
 * if fees took this share of the entry.
 */
export const EXIT_FEE_MARGIN = "0.01";

export function floorToStep(value: Decimal.Value, step: string) {
  const amount = new Decimal(value);
  if (new Decimal(step).isZero()) return amount;
  return amount.dividedBy(step).floor().times(step);
}

/** Returns every Binance filter the entry or its exits would fail. */
export function protectedEntryFilterIssues(
  entry: Pick<
    ProtectedEntry,
    "quantity" | "price" | "takeProfitPrice" | "stopLossPrice"
  >,
  rules: MarketRules,
): string[] {
  const issues: string[] = [];
  if (rules.status !== "trading")
    issues.push("Binance is not trading this market now.");
  if (!rules.protectedEntryAllowed)
    issues.push(
      "Binance does not accept entries with attached exits on this market.",
    );
  for (const [label, value] of [
    ["Entry price", entry.price],
    ["Take-profit price", entry.takeProfitPrice],
    ["Stop-loss price", entry.stopLossPrice],
  ] as const) {
    const price = new Decimal(value);
    if (!new Decimal(rules.minPrice).isZero() && price.lessThan(rules.minPrice))
      issues.push(`${label} is below Binance's minimum of ${rules.minPrice}.`);
    if (
      !new Decimal(rules.maxPrice).isZero() &&
      price.greaterThan(rules.maxPrice)
    )
      issues.push(`${label} is above Binance's maximum of ${rules.maxPrice}.`);
    if (
      !new Decimal(rules.tickSize).isZero() &&
      !price.mod(rules.tickSize).isZero()
    )
      issues.push(
        `${label} must be a multiple of the ${trim(rules.tickSize)} tick size.`,
      );
  }
  const quantity = new Decimal(entry.quantity);
  if (quantity.lessThan(rules.minQty))
    issues.push(
      `Quantity is below Binance's minimum of ${trim(rules.minQty)}.`,
    );
  if (quantity.greaterThan(rules.maxQty))
    issues.push(
      `Quantity is above Binance's maximum of ${trim(rules.maxQty)}.`,
    );
  if (
    !new Decimal(rules.stepSize).isZero() &&
    !quantity.mod(rules.stepSize).isZero()
  )
    issues.push(
      `Quantity must be a multiple of the ${trim(rules.stepSize)} step size.`,
    );
  const notional = quantity.times(entry.price);
  if (notional.lessThan(rules.minNotional))
    issues.push(
      `Order value is below Binance's minimum of ${trim(rules.minNotional)} USDT.`,
    );
  if (
    !new Decimal(rules.maxNotional).isZero() &&
    notional.greaterThan(rules.maxNotional)
  )
    issues.push(
      `Order value is above Binance's maximum of ${trim(rules.maxNotional)} USDT.`,
    );
  const exitQuantity = floorToStep(
    quantity.times(new Decimal(1).minus(EXIT_FEE_MARGIN)),
    rules.stepSize,
  );
  const lowestExit = Decimal.min(entry.stopLossPrice, entry.takeProfitPrice);
  if (
    quantity.greaterThanOrEqualTo(rules.minQty) &&
    notional.greaterThanOrEqualTo(rules.minNotional) &&
    (exitQuantity.lessThan(rules.minQty) ||
      exitQuantity.times(lowestExit).lessThan(rules.minNotional))
  )
    issues.push(
      `After fees, the exits could fall below Binance's minimum order size of ${trim(rules.minNotional)} USDT at the stop-loss price. Increase the quantity.`,
    );
  return issues;
}

function trim(value: string) {
  return new Decimal(value).toFixed();
}
