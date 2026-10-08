import { formatDecimal, formatUtc } from "@/lib/format";
import { instrumentAssets, proposalFigures } from "@/lib/proposal-display";
import { cn } from "@/lib/utils";

type Proposal = {
  instrument: string;
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  entryExpiresAt: string;
};

/**
 * A proposal's entry, size, exits and risk to reward. Prices are exact, and
 * the percentages are each exit's distance from the entry price.
 */
export function ProposalFigures({
  proposal,
  className,
}: {
  proposal: Proposal;
  className?: string;
}) {
  const { base, quote } = instrumentAssets(proposal.instrument);
  const figures = proposalFigures(proposal);
  const price = (value: string) =>
    `${safe(() => formatDecimal(value, { cents: true }), value)} ${quote}`;
  return (
    <dl className={cn("grid grid-cols-2 gap-x-3 gap-y-2", className)}>
      <Figure label="Entry price" value={price(proposal.entryPrice)} />
      <Figure
        label="Size"
        value={`${safe(() => formatDecimal(proposal.quantity), proposal.quantity)} ${base}`}
        detail={figures ? `${figures.notional} ${quote}` : undefined}
      />
      <Figure
        label="Stop loss"
        value={price(proposal.stopLossPrice)}
        detail={figures?.stopLossPercent}
        tone="text-destructive"
      />
      <Figure
        label="Take profit"
        value={price(proposal.takeProfitPrice)}
        detail={figures?.takeProfitPercent}
        tone="text-emerald-700 dark:text-emerald-400"
      />
      <Figure label="Risk / reward" value={figures?.riskReward ?? "—"} />
      <Figure
        label="Entry expires"
        value={safe(
          () => formatUtc(Date.parse(proposal.entryExpiresAt)).slice(0, 16),
          proposal.entryExpiresAt,
        )}
        detail="UTC"
      />
    </dl>
  );
}

function Figure({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono [overflow-wrap:anywhere] text-foreground">
        {value}
        {detail ? (
          <span className={cn("ml-1.5 text-muted-foreground", tone)}>
            {detail}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

// A draft streaming in from the assistant can hold partial values.
function safe(format: () => string, fallback: string) {
  try {
    return format();
  } catch {
    return fallback;
  }
}
