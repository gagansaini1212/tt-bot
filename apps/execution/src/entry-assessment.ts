// Decides, from what Binance reports, what a protected entry holds, whether
// a stop loss protects it, and what the worker must do. Pure, so every case
// is tested without an exchange or a database.
import Decimal from "decimal.js";
import type { OrderIntentStatus } from "./order-intents";

/** What the worker knows about one order on Binance. */
export type LegState = {
  clientOrderId: string;
  orderId: number | null;
  // Known for orders read from Binance in this pass.
  orderListId?: number;
  status: string;
  origQty: string;
  executedQty: string;
};

/** A market sell the worker sent to close the entry, and what became of it. */
export type CloseState = {
  clientOrderId: string;
  intentStatus: OrderIntentStatus;
  leg?: LegState;
};

export type EntryState =
  | "working"
  | "partly_filled"
  | "awaiting_exits"
  | "protected"
  | "unprotected"
  | "exiting"
  | "closed"
  | "not_filled"
  | "handed_over"
  | "missing";

export const TERMINAL_STATES: readonly EntryState[] = [
  "closed",
  "not_filled",
  "handed_over",
  "missing",
];

// Binance's statuses for an order that can still trade or is about to.
const OPEN = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW"]);

/**
 * Binance places an OPOCO list's exits just after its entry fills. Until
 * this long after the last fill, exits it has not placed yet are not missing.
 */
export const EXIT_PLACEMENT_GRACE_MS = 60_000;

export type EntryObservation = {
  entry: LegState;
  // Read only once the entry has filled completely; before that Binance
  // holds them back without a quantity.
  takeProfit?: LegState;
  stopLoss?: LegState;
  closes: CloseState[];
  // Commission Binance took from the bought asset, which the entry no
  // longer holds.
  baseFee: string;
  // Binance's lot step. Less than one step cannot be sold or protected, so
  // the entry counts as holding nothing.
  stepSize: string;
  lastFillAt: Date | null;
  stopLossPrice: string;
  // The latest traded price, when the worker read it.
  lastPrice?: string;
  customerCancelled: boolean;
  // Why the worker is already selling the entry, if it is.
  exitReason: string | null;
  now: Date;
};

export type EntryAssessment = {
  state: EntryState;
  filled: string;
  held: string;
  exitReason: string | null;
  // Something in the entry's order list is still open on Binance, and must
  // be cancelled before the worker can sell: it locks the bought quantity.
  cancelList: boolean;
  // The quantity to sell now, before Binance's filters and the balance.
  // Unset while an earlier sale is still in flight.
  sell?: string;
  // What happened, for the customer.
  finding: string;
};

export function isOpen(leg: LegState | undefined) {
  return leg !== undefined && OPEN.has(leg.status);
}

export function assessEntry(observation: EntryObservation): EntryAssessment {
  const {
    entry,
    takeProfit,
    stopLoss,
    closes,
    exitReason: carried,
  } = observation;
  const filled = new Decimal(entry.executedQty);
  const exits = [takeProfit, stopLoss].filter(
    (leg): leg is LegState => leg !== undefined,
  );
  const sized = exits.filter((leg) => new Decimal(leg.origQty).gt(0));
  // OPO sizes the exits from what the entry received after fees. Until it
  // does, the entry holds what filled less the fee taken from it.
  const received = sized.length
    ? Decimal.max(...sized.map((leg) => leg.origQty))
    : Decimal.max(0, filled.minus(observation.baseFee));
  const sold = [...sized, ...closes.flatMap((close) => close.leg ?? [])].reduce(
    (total, leg) => total.plus(leg.executedQty),
    new Decimal(0),
  );
  const remaining = Decimal.max(0, received.minus(sold));
  const held =
    filled.isZero() || remaining.lt(observation.stepSize)
      ? new Decimal(0)
      : remaining;
  const listOpen = isOpen(entry) || exits.some(isOpen);
  const selling = closes.some(
    (close) =>
      close.intentStatus === "submitting" ||
      close.intentStatus === "unknown" ||
      (close.intentStatus === "acknowledged" &&
        (!close.leg || isOpen(close.leg))),
  );
  const result = (
    state: EntryState,
    finding: string,
    changes: Partial<EntryAssessment> = {},
  ): EntryAssessment => ({
    state,
    filled: filled.toFixed(),
    held: held.toFixed(),
    exitReason: carried,
    cancelList: false,
    finding,
    ...changes,
  });

  if (carried) {
    const state = carried === "protection_failed" ? "unprotected" : "exiting";
    if (listOpen)
      return result(
        state,
        "The worker is cancelling what is left of its order list, then sells at market.",
        { cancelList: true },
      );
    if (filled.isZero())
      return result("not_filled", "Cancelled before anything filled.");
    if (held.isZero()) return result("closed", "Everything it held is sold.");
    const sellingNow = "The worker is selling it at market.";
    if (selling) return result(state, sellingNow);
    return result(state, sellingNow, { sell: held.toFixed() });
  }

  if (isOpen(entry)) {
    if (filled.isZero())
      return result("working", "The entry rests on the book.");
    if (
      observation.lastPrice &&
      new Decimal(observation.lastPrice).lte(observation.stopLossPrice)
    )
      return result(
        "exiting",
        `The market traded at ${new Decimal(observation.lastPrice).toFixed()}, at or below the stop loss of ${new Decimal(observation.stopLossPrice).toFixed()}, while the entry had only partly filled, so Binance had not placed its exits.`,
        { exitReason: "stop_loss", cancelList: true },
      );
    return result(
      "partly_filled",
      `${filled.toFixed()} has filled. Binance places the exits once the entry fills completely.`,
    );
  }

  if (filled.isZero())
    return result("not_filled", "The entry ended before anything filled.");
  if (held.isZero())
    return result("closed", "An exit sold everything the entry bought.");

  const covered =
    stopLoss && isOpen(stopLoss)
      ? new Decimal(stopLoss.origQty).minus(stopLoss.executedQty)
      : new Decimal(0);
  if (sized.length && covered.gte(held))
    return result("protected", "Its take profit and stop loss are on Binance.");

  const lastFill = observation.lastFillAt?.getTime() ?? 0;
  if (
    entry.status === "FILLED" &&
    !sized.length &&
    exits.some((leg) => leg.status === "PENDING_NEW") &&
    observation.now.getTime() - lastFill < EXIT_PLACEMENT_GRACE_MS
  )
    return result(
      "awaiting_exits",
      "The entry has filled and Binance is placing its exits.",
    );

  if (observation.customerCancelled)
    return result(
      "handed_over",
      `You cancelled the order after ${filled.toFixed()} filled, accepting that what it holds has no exits. It is yours to manage.`,
    );

  if (takeProfit?.status === "PARTIALLY_FILLED")
    return result(
      "exiting",
      "The take profit partly filled and Binance cancelled the stop loss, so the rest has no stop.",
      { exitReason: "take_profit", cancelList: listOpen },
    );

  const finding =
    entry.status === "FILLED"
      ? `The entry filled, but Binance did not keep its exits (take profit ${takeProfit?.status.toLowerCase() ?? "missing"}, stop loss ${stopLoss?.status.toLowerCase() ?? "missing"}).`
      : `The entry was ${entry.status.toLowerCase().replace(/_/g, " ")} after ${filled.toFixed()} filled, so Binance never placed its exits.`;
  return result("unprotected", finding, {
    exitReason: "protection_failed",
    cancelList: listOpen,
    sell: listOpen || selling ? undefined : held.toFixed(),
  });
}
