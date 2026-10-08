// Client-safe wording for what the execution loop reports.
import type {
  EntryAlert,
  StopTrigger,
} from "@crypto-trading/exchanges/execution";
import { formatDecimal } from "./format";

const REASONS: Record<string, string> = {
  protection_failed: "no stop loss",
  stop_loss: "stop loss reached before the entry filled",
  take_profit: "finishing a partly filled take profit",
  holding_deadline: "holding deadline reached",
  close_all: "close all",
  loss_limit: "loss limit reached",
};

/** Why the worker is selling, in words. */
export function exitReasonLabel(reason: string | null) {
  if (!reason) return "";
  return REASONS[reason] ?? reason.replace(/_/g, " ");
}

function asset(alert: Pick<EntryAlert, "instrument">) {
  return alert.instrument.split("-")[0];
}

/**
 * The loudest alerts need the customer: quantity without a stop loss, an
 * overdue exit, or a sale the worker gave up on.
 */
export function isUrgent(alert: EntryAlert) {
  return (
    alert.state === "unprotected" ||
    alert.closeBlocked ||
    alert.overdueSince !== null
  );
}

/** One line saying what is wrong, such as "0.00099 BTC has no stop loss". */
export function alertHeadline(alert: EntryAlert) {
  const held = `${formatDecimal(alert.heldQuantity)} ${asset(alert)}`;
  if (alert.closeBlocked) return `Could not sell ${held}`;
  if (alert.overdueSince) return `Exit overdue: ${held} still held`;
  if (alert.state === "unprotected") return `${held} has no stop loss`;
  return `Selling ${held}: ${exitReasonLabel(alert.exitReason)}`;
}

/** A held stop-limit entry, such as "Buy 0.001 BTC at 61,100 once …". */
export function triggerSummary(trigger: StopTrigger) {
  const pair = trigger.instrument.replace("-", "/");
  return `Buy ${formatDecimal(trigger.quantity)} ${asset(trigger)} at ${formatDecimal(trigger.price)} once ${pair} trades at or above ${formatDecimal(trigger.stopPrice)}`;
}

/** When the loop last checked the customer's orders. */
export function checkedLabel(checkedAt: string | null) {
  return checkedAt
    ? `The execution loop last checked your orders at ${checkedAt.slice(11, 19)} UTC.`
    : "The execution loop has not checked your orders since the worker started.";
}
