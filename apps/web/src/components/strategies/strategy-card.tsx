"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  FlaskConical,
  LoaderCircle,
  Pause,
  PencilLine,
  Play,
  XOctagon,
} from "lucide-react";
import { strategyStatusLabel } from "@crypto-trading/domain";
import {
  STOP_REASON_LABELS,
  STRATEGY_KIND_LABELS,
  type StrategyView,
} from "@crypto-trading/exchanges/strategies";

import { controlStrategy } from "@/app/strategies/strategy-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  changeTone,
  formatAge,
  formatAmount,
  formatChange,
  formatUtc,
} from "@/lib/format";
import type { StrategyActionResult } from "@/lib/strategies";
import {
  lossShare,
  strategyMarkets,
  strategyPnl,
} from "@/lib/strategy-display";

const STATUS_VARIANTS = {
  Running: "default",
  Paused: "outline",
  Completed: "secondary",
} as const;

/**
 * One strategy: its status, allocation against current value, unrealized
 * and realized PnL, loss limits, entries, what the worker is doing, and its
 * controls.
 */
export function StrategyCard({
  strategy,
  now,
  onEdit,
}: {
  strategy: StrategyView;
  now: number;
  onEdit: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StrategyActionResult>();
  const [confirming, setConfirming] = useState(false);
  // Blocks a second click before the first one re-renders the buttons.
  const sending = useRef(false);
  const status = strategyStatusLabel(strategy.status);
  const pnl = strategyPnl(strategy);
  const { measure } = strategy;

  const act = (action: "pause" | "resume" | "close_all") => {
    if (sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const outcome = await controlStrategy(action, {
          strategyId: strategy.id,
        });
        setResult(outcome);
        if (action === "close_all") setConfirming(false);
      } finally {
        sending.current = false;
      }
    });
  };

  const titleId = `strategy-${strategy.id}`;
  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>
              <h3 className="[overflow-wrap:anywhere]" id={titleId}>
                {strategy.name}
              </h3>
            </CardTitle>
            <CardDescription className="mt-1">
              {STRATEGY_KIND_LABELS[strategy.rules.kind]} ·{" "}
              {strategyMarkets(strategy.rules)} · version {strategy.version}
            </CardDescription>
          </div>
          <Badge variant={STATUS_VARIANTS[status]}>{status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Figure
            label="Allocated"
            value={`${formatAmount(strategy.allocation)} USDT`}
          />
          <Figure
            label="Current value"
            value={
              pnl ? `${formatAmount(pnl.currentValue)} USDT` : "Unavailable"
            }
          />
          <Figure
            label="Unrealized PnL"
            tone={pnl ? changeTone(formatChange(pnl.unrealized)) : undefined}
            value={pnl ? `${formatChange(pnl.unrealized)} USDT` : "—"}
          />
          <Figure
            detail={
              pnl ? `after ${formatAmount(pnl.fees)} USDT fees` : undefined
            }
            label="Realized PnL"
            tone={pnl ? changeTone(formatChange(pnl.realized)) : undefined}
            value={pnl ? `${formatChange(pnl.realized)} USDT` : "—"}
          />
        </dl>

        {measure.status === "measured" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <LossLimit
              label="Daily loss"
              loss={measure.daily.loss}
              limit={measure.daily.limit}
              reached={measure.daily.reached}
            />
            <LossLimit
              label="Total loss"
              loss={measure.total.loss}
              limit={measure.total.limit}
              reached={measure.total.reached}
            />
          </div>
        ) : (
          <p className="text-sm text-destructive">
            Opens no entries: the worker cannot measure its losses.{" "}
            {measure.reason}
          </p>
        )}

        <p className="text-sm text-muted-foreground">
          {strategy.entries.pending} pending · {strategy.entries.open} open
          {strategy.entries.awaitingApproval ? (
            <>
              {" "}
              ·{" "}
              <Link
                className="text-primary underline-offset-4 hover:underline"
                href="/activity"
              >
                {strategy.entries.awaitingApproval} awaiting your approval
              </Link>
            </>
          ) : null}
        </p>

        {strategy.ai ? (
          <div className="space-y-1 text-sm">
            <p>
              {strategy.ai.proposalApproval === "automatic"
                ? "Places the AI's proposals automatically, within its limits."
                : "You approve each of the AI's proposals."}{" "}
              {strategy.nextAnalysisAt && status === "Running" ? (
                <span className="text-muted-foreground">
                  Next analysis {formatUtc(Date.parse(strategy.nextAnalysisAt))}
                  .
                </span>
              ) : null}
            </p>
            {strategy.latestDecision ? (
              <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                Latest decision:{" "}
                {strategy.latestDecision.kind === "trade_proposal"
                  ? "a trade proposal"
                  : "no trade"}
                , {formatAge(Date.parse(strategy.latestDecision.at), now)}
                {strategy.latestDecision.fixture ? (
                  <Badge variant="outline">
                    <FlaskConical />
                    Recorded fixture
                  </Badge>
                ) : (
                  <span>· {strategy.latestDecision.model}</span>
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        {strategy.status === "paused" ? (
          <p className="text-sm">
            Paused: {STOP_REASON_LABELS[strategy.pauseReason ?? ""] ?? "paused"}
            {strategy.pausedAt
              ? `, ${formatAge(Date.parse(strategy.pausedAt), now)}`
              : ""}
            .{" "}
            {strategy.exitRequest && strategy.exitRequest !== "pause"
              ? "Its entries are being closed."
              : "Open entries keep their take profit, stop loss and holding deadline."}
          </p>
        ) : null}
        {strategy.runnerNote ? (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            Worker: {strategy.runnerNote}
            {strategy.runnerCheckedAt ? (
              <span>
                {" "}
                ({formatAge(Date.parse(strategy.runnerCheckedAt), now)})
              </span>
            ) : null}
          </p>
        ) : null}
        {result ? (
          <Alert
            role={result.result === "saved" ? "status" : "alert"}
            variant={result.result === "saved" ? "default" : "destructive"}
          >
            <AlertDescription
              className={
                result.result === "saved"
                  ? "text-foreground"
                  : "text-destructive"
              }
            >
              {result.message}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      {strategy.status === "retired" ? null : (
        <CardFooter className="mt-auto flex flex-wrap gap-2">
          {strategy.status === "paused" ? (
            <Button disabled={pending} onClick={() => act("resume")} size="sm">
              {pending ? <LoaderCircle className="animate-spin" /> : <Play />}
              Resume
            </Button>
          ) : (
            <Button
              disabled={pending}
              onClick={() => act("pause")}
              size="sm"
              variant="outline"
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Pause />}
              Pause
            </Button>
          )}
          <Button
            disabled={pending}
            onClick={onEdit}
            size="sm"
            variant="outline"
          >
            <PencilLine />
            Edit limits
          </Button>
          <Button
            // A lighter tint keeps the red label readable on the muted footer.
            className="dark:bg-destructive/10"
            disabled={pending}
            onClick={() => setConfirming(true)}
            size="sm"
            variant="destructive"
          >
            <XOctagon />
            Close all
          </Button>
        </CardFooter>
      )}
      <AlertDialog
        onOpenChange={(open) => !pending && setConfirming(open)}
        open={confirming}
      >
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Close all of {strategy.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The strategy is paused. The worker cancels its pending entries and
              sells what its {strategy.entries.open} open{" "}
              {strategy.entries.open === 1 ? "entry holds" : "entries hold"} at
              market, which can fill below the last price. It stays paused until
              you resume it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep them</AlertDialogCancel>
            <Button
              className="dark:bg-destructive/10"
              disabled={pending}
              onClick={() => act("close_all")}
              variant="destructive"
            >
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <XOctagon />
              )}
              Close all
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
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
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`font-medium tabular-nums ${tone ?? ""}`}>{value}</dd>
      {detail ? (
        <dd className="text-xs text-muted-foreground">{detail}</dd>
      ) : null}
    </div>
  );
}

function LossLimit({
  label,
  loss,
  limit,
  reached,
}: {
  label: string;
  loss: string;
  limit: string;
  reached: boolean;
}) {
  const share = lossShare(loss, limit);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`tabular-nums ${reached ? "text-destructive" : ""}`}>
          {formatAmount(loss)} of {formatAmount(limit)} USDT
        </span>
      </div>
      <Progress
        aria-label={`${label}: ${formatAmount(loss)} of ${formatAmount(limit)} USDT`}
        value={share}
      />
    </div>
  );
}
