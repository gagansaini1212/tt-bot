import {
  Ban,
  CircleCheck,
  LoaderCircle,
  ReceiptText,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { EveDynamicToolPart } from "eve/react";

import { Badge } from "@/components/ui/badge";
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
  leverage?: number;
  strategyVersion: number;
  rationale: string;
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
  if (
    proposalStringFields.some((field) => typeof record[field] !== "string") ||
    typeof record.strategyVersion !== "number"
  ) {
    return null;
  }

  return {
    ...(record as Omit<ProposalDraft, "leverage" | "notice">),
    leverage: typeof record.leverage === "number" ? record.leverage : undefined,
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
  const [base, quote] = proposal?.instrument.split("-") ?? [];

  return (
    <section
      aria-label="Trade proposal draft"
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
          ) : (
            <Badge variant="outline">Draft</Badge>
          )}
        </span>
      </header>

      {proposal ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5">
          <ProposalField
            label="Quantity"
            value={withUnit(proposal.quantity, base)}
          />
          <ProposalField
            label="Entry price"
            value={withUnit(proposal.entryPrice, quote)}
          />
          <ProposalField
            label="Stop loss"
            value={withUnit(proposal.stopLossPrice, quote)}
          />
          <ProposalField
            label="Take profit"
            value={withUnit(proposal.takeProfitPrice, quote)}
          />
          <ProposalField
            label="Leverage"
            value={`${proposal.leverage ?? 1}×`}
          />
          <ProposalField
            label="Strategy version"
            value={`v${proposal.strategyVersion}`}
          />
          <ProposalField
            className="col-span-2"
            label="Entry expires"
            value={formatUtc(proposal.entryExpiresAt)}
          />
          <div className="col-span-2">
            <dt className="text-muted-foreground">Rationale</dt>
            <dd className="mt-0.5 leading-5 text-foreground">
              {proposal.rationale}
            </dd>
          </div>
        </dl>
      ) : null}

      {failed ? (
        <p className="px-3 py-2.5 text-destructive">{part.errorText}</p>
      ) : null}
      {denied ? (
        <p className="px-3 py-2.5 text-muted-foreground">
          The proposal was not drafted.
        </p>
      ) : null}
      {part.state === "output-available" && !pending && proposal?.notice ? (
        <p className="border-t border-border px-3 py-2 text-muted-foreground">
          {proposal.notice}
        </p>
      ) : null}
    </section>
  );
}

function ProposalField({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono [overflow-wrap:anywhere] text-foreground">
        {value}
      </dd>
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function withUnit(amount: string, unit: string | undefined) {
  return unit ? `${amount} ${unit}` : amount;
}

function formatUtc(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
