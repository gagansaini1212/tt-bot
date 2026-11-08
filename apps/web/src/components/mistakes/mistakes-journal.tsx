"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  History,
  Shield,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  XCircle,
} from "lucide-react";
import type { TradeMistakeView } from "@crypto-trading/exchanges/ai-decisions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatAge } from "@/lib/format";

export function MistakesJournal({
  mistakes,
  now,
}: {
  mistakes: TradeMistakeView[];
  now: number;
}) {
  const [filter, setFilter] = useState<
    "all" | "stop_loss" | "rejected_proposal" | "other"
  >("all");

  const filtered = mistakes.filter((m) => {
    if (filter === "all") return true;
    if (filter === "stop_loss") return m.kind === "stop_loss" || m.kind === "trailing_stop_loss";
    if (filter === "rejected_proposal") return m.kind === "rejected_proposal";
    return m.kind === "holding_deadline" || m.kind === "range_stop";
  });

  const stopLossCount = mistakes.filter(
    (m) => m.kind === "stop_loss" || m.kind === "trailing_stop_loss"
  ).length;
  const rejectedCount = mistakes.filter((m) => m.kind === "rejected_proposal").length;
  const otherCount = mistakes.filter(
    (m) => m.kind === "holding_deadline" || m.kind === "range_stop"
  ).length;

  return (
    <div className="space-y-6">
      {/* Overview Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <History className="h-4 w-4 text-primary" />
            <span>Mistakes Analyzed</span>
          </div>
          <div className="mt-2 text-2xl font-bold">{mistakes.length}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Historical failed setups recorded
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span>Stop Loss Reviews</span>
          </div>
          <div className="mt-2 text-2xl font-bold text-destructive">
            {stopLossCount}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Adverse momentum & drawdown exits
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <XCircle className="h-4 w-4 text-amber-500" />
            <span>User Feedback Rejections</span>
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-500">
            {rejectedCount}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Turned into negative prompt constraints
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Shield className="h-4 w-4 text-emerald-500" />
            <span>Adaptive Protection</span>
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-500">Active</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Cooldowns & dynamic dip widening on
          </p>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-2">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "all"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          All Lessons ({mistakes.length})
        </button>
        <button
          type="button"
          onClick={() => setFilter("stop_loss")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "stop_loss"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Stop Losses ({stopLossCount})
        </button>
        <button
          type="button"
          onClick={() => setFilter("rejected_proposal")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "rejected_proposal"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          User Rejections ({rejectedCount})
        </button>
        <button
          type="button"
          onClick={() => setFilter("other")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "other"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          Timeouts & Range ({otherCount})
        </button>
      </div>

      {/* Mistake Entries List */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-500/80 mb-3" />
          <h3 className="text-sm font-semibold">No trade mistakes found</h3>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            {filter === "all"
              ? "The bot has not recorded any stop loss triggers, rejected proposals, or holding timeouts yet. When mistakes occur, the AI automatically analyzes the root cause, applies protective cooldowns, and feeds lessons into future prompt decisions."
              : "No mistakes matching this filter category."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((item) => (
            <MistakeCard key={item.id} mistake={item} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function MistakeCard({
  mistake,
  now,
}: {
  mistake: TradeMistakeView;
  now: number;
}) {
  const occurredMs = Date.parse(mistake.occurredAt);
  const age = Number.isFinite(occurredMs) ? formatAge(occurredMs, now) : "";

  return (
    <div className="rounded-lg border bg-card p-5 text-card-foreground shadow-sm space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-base">{mistake.instrument}</span>
          {mistake.strategyName ? (
            <Badge variant="outline" className="text-xs">
              {mistake.strategyName}
            </Badge>
          ) : null}
          <KindBadge kind={mistake.kind} />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>{age ? `${age} ago` : mistake.occurredAt}</span>
        </div>
      </div>

      {/* Metric details if trade executed */}
      {(mistake.entryPrice || mistake.exitPrice || mistake.lossPercent) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-md bg-muted/40 p-3 text-xs">
          {mistake.entryPrice ? (
            <div>
              <div className="text-muted-foreground">Entry Price</div>
              <div className="font-mono font-medium">${mistake.entryPrice}</div>
            </div>
          ) : null}
          {mistake.exitPrice ? (
            <div>
              <div className="text-muted-foreground">Exit / Stop Price</div>
              <div className="font-mono font-medium">${mistake.exitPrice}</div>
            </div>
          ) : null}
          {mistake.lossPercent ? (
            <div>
              <div className="text-muted-foreground">Loss Drawdown</div>
              <div className="font-mono font-medium text-destructive">
                -{mistake.lossPercent}%
              </div>
            </div>
          ) : null}
          {mistake.lossAmountUsdt ? (
            <div>
              <div className="text-muted-foreground">Realized Loss</div>
              <div className="font-mono font-medium text-destructive">
                -${mistake.lossAmountUsdt} USDT
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Rejection reason if proposal rejected */}
      {mistake.reason && (
        <div className="text-xs rounded-md bg-amber-500/10 border border-amber-500/20 p-2.5 text-amber-900 dark:text-amber-200">
          <span className="font-semibold">Rejection Feedback:</span> {mistake.reason}
        </div>
      )}

      {/* Learned Lesson */}
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
        <div className="flex items-center gap-1.5 font-semibold text-primary">
          <Brain className="h-4 w-4" />
          <span>Learned Trading Lesson</span>
        </div>
        <p className="text-muted-foreground leading-relaxed pl-5">
          {mistake.lesson}
        </p>
      </div>

      {/* Adaptive Action */}
      <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs space-y-1">
        <div className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
          <ShieldAlert className="h-4 w-4" />
          <span>Adaptive Defense Action Applied</span>
        </div>
        <p className="text-muted-foreground leading-relaxed pl-5">
          {mistake.adaptiveAction}
        </p>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: TradeMistakeView["kind"] }) {
  switch (kind) {
    case "stop_loss":
      return (
        <Badge variant="destructive" className="text-xs">
          Stop Loss Hit
        </Badge>
      );
    case "trailing_stop_loss":
      return (
        <Badge variant="secondary" className="text-xs">
          Trailing Stop Loss
        </Badge>
      );
    case "rejected_proposal":
      return (
        <Badge variant="secondary" className="text-xs bg-amber-500/20 text-amber-700 dark:text-amber-300">
          Proposal Rejected
        </Badge>
      );
    case "holding_deadline":
      return (
        <Badge variant="outline" className="text-xs">
          Holding Timeout
        </Badge>
      );
    case "range_stop":
      return (
        <Badge variant="destructive" className="text-xs">
          Range Stop Hit
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs">
          {kind}
        </Badge>
      );
  }
}
