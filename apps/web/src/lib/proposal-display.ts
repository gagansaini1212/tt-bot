import Decimal from "decimal.js";
import {
  proposalRisk,
  type ProposalStatus,
  type ProposalView,
} from "@crypto-trading/exchanges/ai-decisions";

import {
  formatAmount,
  formatDecimal,
  formatPercent,
  formatUtc,
} from "./format";

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  submitted: "Submitted",
  filled: "Filled",
  cancelled: "Cancelled",
  expired: "Expired",
};

export function proposalStatusVariant(
  status: ProposalStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "filled":
      return "default";
    case "approved":
    case "submitted":
      return "secondary";
    case "rejected":
      return "destructive";
    default:
      return "outline";
  }
}

/**
 * The figures a proposal card shows: its size in the quote currency, how far
 * each exit is from the entry, and the risk to reward. Null while the draft's
 * prices are incomplete.
 */
export function proposalFigures(proposal: {
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
}) {
  let risk: ReturnType<typeof proposalRisk>;
  try {
    risk = proposalRisk(proposal);
  } catch {
    return null;
  }
  return {
    notional: formatAmount(risk.notional),
    stopLossPercent: formatPercent(risk.stopLossPercent),
    takeProfitPercent: formatPercent(risk.takeProfitPercent),
    // Such as "1 : 2" or "1 : 1.94".
    riskReward:
      risk.rewardPerRisk === null
        ? null
        : `1 : ${new Decimal(risk.rewardPerRisk).toDecimalPlaces(2).toString()}`,
  };
}

/** "BTC" and "USDT" from "BTC-USDT". */
export function instrumentAssets(instrument: string) {
  const [base = instrument, quote = ""] = instrument.split("-");
  return { base, quote };
}

/** What happened to a proposal, in a sentence or two. */
export function proposalOutcome(proposal: ProposalView): string {
  const { base } = instrumentAssets(proposal.instrument);
  const entry = proposal.order?.entry;
  // The execution loop's finding, once it has checked the entry.
  const watched = proposal.order?.reconciliation ?? null;
  const filled = watched?.filledQuantity ?? entry?.filledQuantity ?? "0";
  const amount = `${formatDecimal(filled)} ${base}`;
  switch (proposal.status) {
    case "draft":
      return `Waiting for your approval until ${formatUtc(Date.parse(proposal.entryExpiresAt))}.`;
    case "expired":
      return `Expired at ${formatUtc(Date.parse(proposal.entryExpiresAt))} before it was approved. Nothing was sent.`;
    case "rejected":
      if (proposal.order?.intentStatus === "rejected")
        return "You approved it, but Binance refused the order, or never received it, so nothing was placed.";
      if (proposal.decidedBy === "execution_checks")
        return `The execution checks rejected it when you approved it, so nothing was sent.${proposal.decisionReason ? ` ${proposal.decisionReason}` : ""}`;
      return proposal.decisionReason
        ? `You rejected it: “${proposal.decisionReason}”`
        : "You rejected it.";
    case "approved":
      return "You approved it, but Binance has not confirmed the order yet. The execution worker is looking it up; it is never sent twice.";
    case "submitted":
      return new Decimal(filled).greaterThan(0)
        ? `The entry is on Binance and has bought ${amount} so far. Binance places its exits when it fills completely.`
        : "The entry is on Binance, waiting to fill. Its take profit and stop loss are placed when it fills.";
    case "filled": {
      const bought =
        entry?.status === "FILLED" && entry.averageFillPrice
          ? `Bought ${formatDecimal(entry.filledQuantity)} ${base} at ${formatDecimal(entry.averageFillPrice, { cents: true })}.`
          : `Bought ${amount}.`;
      if (proposal.order?.takeProfit?.status === "FILLED")
        return `${bought} The take profit closed the position.`;
      if (proposal.order?.stopLoss?.status === "FILLED")
        return `${bought} The stop loss closed the position.`;
      switch (watched?.state) {
        case "protected":
          return `${bought} Its take profit and stop loss are on Binance.`;
        case "awaiting_exits":
          return `${bought} Binance is placing its take profit and stop loss.`;
        case "unprotected":
        case "exiting":
          return watched.closeBlocked
            ? `${bought} The execution worker could not sell what it holds and stopped trying. Sell it yourself.`
            : `${bought} The execution worker is selling what it holds.`;
        case "closed":
          return `${bought} The position is closed.`;
      }
      return [proposal.order?.takeProfit, proposal.order?.stopLoss].every(
        (exit) => exit?.status === "NEW",
      )
        ? `${bought} Its take profit and stop loss are on Binance.`
        : `${bought} The execution worker checks its exits on its next pass.`;
    }
    case "cancelled":
      if (watched?.state === "handed_over")
        return `You cancelled it after it bought ${amount}, which has no exits and is yours to manage.`;
      if (watched?.state === "missing")
        return "Binance no longer knows this order, as after a testnet reset, so the execution worker stopped watching it.";
      return new Decimal(filled).greaterThan(0)
        ? `The entry was cancelled after buying ${amount}.`
        : "The entry was cancelled or expired on Binance before it bought anything.";
  }
}
