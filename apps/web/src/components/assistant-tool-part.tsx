"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Ban,
  CircleCheck,
  CircleSlash,
  LoaderCircle,
  ReceiptText,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { ProposalView } from "@crypto-trading/exchanges/ai-decisions";
import type { EveDynamicToolPart } from "eve/react";

import { loadProposal } from "@/app/proposal-actions";
import { ProposalActions } from "@/components/proposal-actions";
import { ProposalFigures } from "@/components/proposal-figures";
import { Badge } from "@/components/ui/badge";
import {
  PROPOSAL_STATUS_LABELS,
  proposalOutcome,
  proposalStatusVariant,
} from "@/lib/proposal-display";
import { cn } from "@/lib/utils";

type ToolState = EveDynamicToolPart["state"];

const stateLabels: Record<ToolState, string> = {
  "input-streaming": "Preparing",
  "input-available": "Running",
  "approval-requested": "Awaiting approval",
  "approval-responded": "Responded",
  "output-available": "Completed",
  "output-error": "Failed",
  "output-denied": "Denied",
};

/** A tool call and its result, as projected by eve into a `dynamic-tool` part. */
export function AssistantToolPart({ part }: { part: EveDynamicToolPart }) {
  if (part.toolName === "draft_trade_proposal") {
    const proposal =
      part.state === "output-available"
        ? readProposalDraft(part.output)
        : readProposalDraft(part.input);
    if (proposal || part.state !== "output-available") {
      return <TradeProposalPart part={part} proposal={proposal} />;
    }
  }
  if (part.toolName === "record_no_trade_decision") {
    const decision = readNoTradeDecision(
      part.state === "output-available" ? part.output : part.input,
    );
    if (decision) return <NoTradePart decision={decision} part={part} />;
  }

  return <GenericToolPart part={part} />;
}

function isPending(part: EveDynamicToolPart) {
  return (
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.state === "approval-requested" ||
    part.state === "approval-responded" ||
    (part.state === "output-available" && part.partial === true)
  );
}

function GenericToolPart({ part }: { part: EveDynamicToolPart }) {
  const pending = isPending(part);
  const Icon = pending
    ? LoaderCircle
    : part.state === "output-error"
      ? TriangleAlert
      : part.state === "output-denied"
        ? Ban
        : CircleCheck;

  return (
    <div
      className={cn(
        "my-2 rounded-md border px-2.5 py-2 text-xs",
        part.state === "output-error"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/30",
      )}
    >
      <div className="flex items-center gap-2">
        <Wrench className="size-3.5 shrink-0" />
        <span className="font-mono text-foreground">{part.toolName}</span>
        <span
          className={cn(
            "ml-auto flex items-center gap-1",
            part.state === "output-error" && "text-destructive",
          )}
        >
          <Icon className={cn("size-3.5", pending && "animate-spin")} />
          {stateLabels[part.state]}
        </span>
      </div>
      {part.state === "output-error" ? (
        <p className="mt-1.5 text-destructive">{part.errorText}</p>
      ) : null}
    </div>
  );
}

type ProposalDraft = {
  instrument: string;
  marketKind: string;
  direction: string;
  quantity: string;
  entryPrice: string;
  entryExpiresAt: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  rationale: string;
  // Set once the worker saved it for the customer to approve.
  proposalId?: string;
  saved?: boolean;
  notice?: string;
};

const proposalStringFields = [
  "instrument",
  "marketKind",
  "direction",
  "quantity",
  "entryPrice",
  "entryExpiresAt",
  "stopLossPrice",
  "takeProfitPrice",
  "rationale",
] as const;

function readProposalDraft(value: unknown): ProposalDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (proposalStringFields.some((field) => typeof record[field] !== "string"))
    return null;
  return {
    ...(record as Omit<ProposalDraft, "proposalId" | "saved" | "notice">),
    proposalId:
      typeof record.proposalId === "string" ? record.proposalId : undefined,
    saved: record.status === "draft" && typeof record.proposalId === "string",
    notice: typeof record.notice === "string" ? record.notice : undefined,
  };
}

function TradeProposalPart({
  part,
  proposal,
}: {
  part: EveDynamicToolPart;
  proposal: ProposalDraft | null;
}) {
  const pending = isPending(part);
  const failed = part.state === "output-error";
  const denied = part.state === "output-denied";
  const done = part.state === "output-available" && !pending;
  const proposalId = done && proposal?.saved ? proposal.proposalId : undefined;
  // The proposal as the worker now has it: another tab may have decided it.
  const [view, setView] = useState<ProposalView | null>(null);
  useEffect(() => {
    if (!proposalId) return;
    let current = true;
    void loadProposal(proposalId).then((loaded) => {
      if (current && loaded) setView(loaded);
    });
    return () => {
      current = false;
    };
  }, [proposalId]);
  const status = view?.status ?? "draft";

  return (
    <section
      aria-label="Trade proposal"
      className={cn(
        "my-2 rounded-lg border bg-card/60 text-xs text-card-foreground",
        failed ? "border-destructive/40" : "border-primary/30",
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ReceiptText className="size-4 shrink-0 text-primary" />
        <p className="font-medium text-foreground">
          {proposal
            ? `${capitalize(proposal.direction)} ${proposal.instrument.replace("-", "/")}`
            : "Trade proposal"}
          {proposal ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {proposal.marketKind}
            </span>
          ) : null}
        </p>
        <span className="ml-auto">
          {pending ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              Drafting
            </span>
          ) : failed ? (
            <Badge variant="destructive">Not drafted</Badge>
          ) : denied ? (
            <Badge variant="outline">Declined</Badge>
          ) : proposalId ? (
            <Badge variant={proposalStatusVariant(status)}>
              {PROPOSAL_STATUS_LABELS[status]}
            </Badge>
          ) : done ? (
            <Badge variant="outline">Not saved</Badge>
          ) : (
            <Badge variant="outline">Draft</Badge>
          )}
        </span>
      </header>

      {proposal ? (
        <div className="space-y-2 px-3 py-2.5">
          <ProposalFigures proposal={proposal} />
          <div>
            <p className="text-muted-foreground">Rationale</p>
            <p className="mt-0.5 leading-5 text-foreground">
              {proposal.rationale}
            </p>
          </div>
        </div>
      ) : null}

      {failed ? (
        <p className="px-3 py-2.5 text-destructive">{part.errorText}</p>
      ) : null}
      {denied ? (
        <p className="px-3 py-2.5 text-muted-foreground">
          The proposal was not drafted.
        </p>
      ) : null}
      {proposalId ? (
        <div className="space-y-2 border-t border-border px-3 py-2.5">
          {view && status !== "draft" ? (
            <p className="text-muted-foreground">{proposalOutcome(view)}</p>
          ) : (
            <p className="text-muted-foreground">
              The execution worker checks it again with your current account and
              limits before anything is sent.
            </p>
          )}
          <ProposalActions
            onUpdate={setView}
            proposalId={proposalId}
            status={status}
          />
          <Link
            className="inline-block text-primary underline-offset-4 hover:underline"
            href="/activity"
          >
            View on Activity
          </Link>
        </div>
      ) : done && proposal?.notice ? (
        <p className="border-t border-border px-3 py-2 text-muted-foreground">
          {proposal.notice}
        </p>
      ) : null}
    </section>
  );
}

type NoTradeDecision = {
  instrument?: string;
  rationale: string;
  recorded?: boolean;
  notice?: string;
};

function readNoTradeDecision(value: unknown): NoTradeDecision | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.rationale !== "string") return null;
  return {
    instrument:
      typeof record.instrument === "string" ? record.instrument : undefined,
    rationale: record.rationale,
    recorded: record.recorded === true,
    notice: typeof record.notice === "string" ? record.notice : undefined,
  };
}

function NoTradePart({
  part,
  decision,
}: {
  part: EveDynamicToolPart;
  decision: NoTradeDecision;
}) {
  const done = part.state === "output-available" && !isPending(part);
  return (
    <section
      aria-label="No-trade decision"
      className="my-2 rounded-lg border border-border bg-card/60 text-xs text-card-foreground"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <CircleSlash className="size-4 shrink-0 text-muted-foreground" />
        <p className="font-medium text-foreground">
          No trade
          {decision.instrument ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {decision.instrument.replace("-", "/")}
            </span>
          ) : null}
        </p>
        <span className="ml-auto">
          {done ? (
            <Badge variant="outline">
              {decision.recorded ? "Recorded" : "Not recorded"}
            </Badge>
          ) : (
            <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
          )}
        </span>
      </header>
      <p className="px-3 py-2.5 leading-5 text-foreground">
        {decision.rationale}
      </p>
      {done && decision.notice ? (
        <p className="border-t border-border px-3 py-2 text-muted-foreground">
          {decision.notice}
        </p>
      ) : null}
    </section>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
