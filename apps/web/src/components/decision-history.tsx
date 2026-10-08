import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { RECORDED_FIXTURE_MODEL } from "@crypto-trading/exchanges/strategies";
import type {
  DecisionView,
  ProposalOrderLeg,
  ProposalView,
} from "@crypto-trading/exchanges/ai-decisions";

import { ProposalActions } from "@/components/proposal-actions";
import { ProposalFigures } from "@/components/proposal-figures";
import { Badge } from "@/components/ui/badge";
import { formatAge, formatDecimal, formatUtc } from "@/lib/format";
import {
  instrumentAssets,
  PROPOSAL_STATUS_LABELS,
  proposalOutcome,
  proposalStatusVariant,
} from "@/lib/proposal-display";

/**
 * AI decisions, newest first: each trade proposal with its status, what
 * became of it and its order list, and each decision not to trade. Drafts can
 * be approved or rejected here too.
 */
export function DecisionHistory({
  decisions,
  now,
}: {
  decisions: DecisionView[];
  now: number;
}) {
  if (!decisions.length)
    return (
      <p className="text-sm text-muted-foreground">
        No AI decisions yet. Ask the analysis assistant on the{" "}
        <Link
          className="text-primary underline-offset-4 hover:underline"
          href="/"
        >
          Overview
        </Link>{" "}
        for a trade idea: its proposals and decisions not to trade appear here.
      </p>
    );
  return (
    <ol aria-label="AI decisions" className="divide-y divide-border">
      {decisions.map((decision) => (
        <li
          className="space-y-3 py-4 first:pt-0 last:pb-0"
          key={decision.id ?? decision.proposal?.id}
        >
          <Decision decision={decision} now={now} />
        </li>
      ))}
    </ol>
  );
}

function Decision({ decision, now }: { decision: DecisionView; now: number }) {
  const { proposal } = decision;
  const time = Date.parse(decision.createdAt);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="font-medium">{headline(decision)}</p>
          <p className="text-xs text-muted-foreground">
            <time dateTime={decision.createdAt} title={formatUtc(time)}>
              {formatAge(time, now)}
            </time>
            <span className="sr-only">, {formatUtc(time)}</span> ·{" "}
            {proposal?.strategyId
              ? `Strategy proposal, version ${proposal.strategyVersion}`
              : proposal
                ? "Assistant proposal"
                : "Decision not to trade"}
          </p>
          {decision.model === RECORDED_FIXTURE_MODEL ? (
            <Badge className="mt-1" variant="outline">
              <FlaskConical />
              Recorded fixture, not AI analysis
            </Badge>
          ) : null}
        </div>
        {proposal ? (
          <Badge variant={proposalStatusVariant(proposal.status)}>
            {PROPOSAL_STATUS_LABELS[proposal.status]}
          </Badge>
        ) : (
          <Badge variant="outline">No trade</Badge>
        )}
      </div>
      {proposal ? (
        <ProposalFigures
          className="text-xs sm:grid-cols-3"
          proposal={proposal}
        />
      ) : null}
      <p className="text-sm leading-6">{decision.rationale}</p>
      {proposal ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {proposalOutcome(proposal)}
        </p>
      ) : null}
      {proposal?.order ? <OrderList proposal={proposal} now={now} /> : null}
      {proposal ? (
        // Kept mounted after a decision, so its outcome stays in view when
        // the page refreshes with the new status. A strategy's proposals
        // are drafts only when its customer approves each one, and approving
        // checks them against the strategy's limits.
        <ProposalActions proposalId={proposal.id} status={proposal.status} />
      ) : null}
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {decision.model
          ? `${decision.model} · prompt ${decision.promptVersion} · `
          : null}
        input: account snapshot{" "}
        <span className="font-mono" title={decision.sourceSnapshotId ?? ""}>
          {decision.sourceSnapshotId?.slice(0, 8) ?? "unknown"}
        </span>
      </p>
    </>
  );
}

function headline(decision: DecisionView) {
  const { proposal } = decision;
  if (!proposal)
    return decision.instrument
      ? `No trade in ${decision.instrument.replace("-", "/")}`
      : "No trade";
  const { base, quote } = instrumentAssets(proposal.instrument);
  const side = proposal.direction === "long" ? "Buy" : "Sell";
  return `${side} ${formatDecimal(proposal.quantity)} ${base} at ${formatDecimal(proposal.entryPrice, { cents: true })} ${quote}`;
}

const LEG_LABELS = {
  entry: "Entry",
  takeProfit: "Take profit",
  stopLoss: "Stop loss",
} as const;

/** The order list an approval placed: each order's Binance ID and state. */
function OrderList({ proposal, now }: { proposal: ProposalView; now: number }) {
  const order = proposal.order!;
  const legs = (Object.keys(LEG_LABELS) as (keyof typeof LEG_LABELS)[])
    .map((key) => [key, order[key]] as const)
    .filter((entry): entry is [keyof typeof LEG_LABELS, ProposalOrderLeg] =>
      Boolean(entry[1]),
    );
  const open =
    proposal.status === "approved" ||
    proposal.status === "submitted" ||
    legs.some(([, leg]) => ["NEW", "PARTIALLY_FILLED"].includes(leg.status));
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <p className="[overflow-wrap:anywhere]">
        Order list <span className="font-mono">{order.listClientOrderId}</span>
        {order.checkedAt ? (
          <span className="text-muted-foreground">
            {" "}
            ·{" "}
            {order.reconciliation
              ? "checked by the execution loop"
              : "reported"}{" "}
            {formatAge(Date.parse(order.checkedAt), now)}
          </span>
        ) : null}
      </p>
      {order.reconciliation?.detail ? (
        <p className="text-muted-foreground">
          Execution loop: {order.reconciliation.detail}
        </p>
      ) : null}
      {legs.length ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {legs.map(([key, leg]) => (
            <li key={key}>
              <span className="text-muted-foreground">{LEG_LABELS[key]}</span>{" "}
              {leg.orderId ? (
                <span className="font-mono">#{leg.orderId}</span>
              ) : null}{" "}
              {leg.status.toLowerCase().replaceAll("_", " ")}
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Link
          className="inline-block text-primary underline-offset-4 hover:underline"
          href="/#open-orders"
        >
          View in Open orders
        </Link>
      ) : null}
    </div>
  );
}
