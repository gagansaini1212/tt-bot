"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Plus, ShieldAlert } from "lucide-react";
import type {
  StrategiesState,
  StrategyDraft,
  StrategyView,
} from "@crypto-trading/exchanges/strategies";

import { BacktestSection } from "@/components/backtest/backtest-section";
import { StrategyCard } from "@/components/strategies/strategy-card";
import { StrategyEditor } from "@/components/strategies/strategy-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { BacktestForm } from "@/lib/backtest-form";
import { changeTone, formatAmount, formatChange } from "@/lib/format";
import { lossShare } from "@/lib/strategy-display";
import { backtestFormFor } from "@/lib/strategy-form";
import type { WorkerState } from "@/lib/worker-client";

/**
 * The Strategies page: the portfolio's drawdown today, each strategy's
 * control card, the editor for a new strategy or version, and the backtest,
 * which any form's rules can be handed to.
 */
export function StrategiesView({
  state,
  acrossAccounts,
}: {
  state: WorkerState<{ state: StrategiesState; readAt: number }>;
  // The strategies on every exchange account together, shown only.
  acrossAccounts?: ReactNode;
}) {
  // A key starts the editor, or the backtest, afresh.
  const [editor, setEditor] = useState<{
    editing?: StrategyView;
    key: number;
  }>();
  const [seed, setSeed] = useState<{ form: BacktestForm; key: number }>();

  const backtest = (draft: StrategyDraft) => {
    setSeed((current) => ({
      form: backtestFormFor(draft),
      key: (current?.key ?? 0) + 1,
    }));
    requestAnimationFrame(() =>
      document
        .getElementById("backtest")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  const edit = (editing?: StrategyView) => {
    setEditor((current) => ({ editing, key: (current?.key ?? 0) + 1 }));
    requestAnimationFrame(() =>
      document
        .getElementById("strategy-editor")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  if (state.status !== "connected")
    return (
      <>
        <Alert className="mt-6" variant="destructive">
          <ShieldAlert />
          <AlertTitle>Strategies are unavailable</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <BacktestSection seed={seed} />
      </>
    );

  const { strategies, limits, today, markets, aiSource } = state.state;
  const limit = limits.current;
  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <h2>Portfolio today</h2>
          </CardTitle>
          <CardDescription className="mt-1">
            Every strategy&apos;s result on this exchange account since midnight
            UTC, against their allocations together. Reaching the account&apos;s
            daily drawdown limit pauses every strategy on it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {limit ? (
            today ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>
                    <span
                      className={`font-medium tabular-nums ${changeTone(formatChange(today.pnl)) ?? ""}`}
                    >
                      {formatChange(today.pnl)} USDT
                    </span>{" "}
                    on {formatAmount(today.allocation)} USDT allocated
                  </span>
                  <span
                    className={`tabular-nums ${today.reached ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    Drawdown {formatAmount(today.drawdownPercent)}% of the{" "}
                    {limit.maxDailyDrawdownPercent}% limit
                  </span>
                </div>
                <Progress
                  aria-label={`Daily drawdown: ${today.drawdownPercent}% of the ${limit.maxDailyDrawdownPercent}% limit`}
                  value={lossShare(
                    today.drawdownPercent,
                    limit.maxDailyDrawdownPercent,
                  )}
                />
              </>
            ) : (
              <p className="text-sm text-destructive">
                The worker cannot measure every strategy now, so it cannot
                measure the portfolio&apos;s drawdown. Strategies open no
                entries until it can.
              </p>
            )
          ) : (
            <Alert>
              <ShieldAlert />
              <AlertTitle>Set a daily drawdown limit first</AlertTitle>
              <AlertDescription>
                Strategies start only once the portfolio has a daily drawdown
                limit.{" "}
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  href="/settings?tab=risk"
                >
                  Set it in Settings → Risk limits
                </Link>
                .
              </AlertDescription>
            </Alert>
          )}
          {acrossAccounts}
          {aiSource.kind === "fixture" ? (
            <p className="text-xs text-muted-foreground">
              AI-managed strategies replay a recorded fixture: no model is
              configured. Their decisions are labelled as fixtures.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Your strategies
        </h2>
        <Button disabled={!limit} onClick={() => edit()}>
          <Plus />
          New strategy
        </Button>
      </div>
      {editor ? (
        <div className="scroll-mt-6" id="strategy-editor">
          <StrategyEditor
            aiSource={aiSource}
            editing={editor.editing}
            key={editor.key}
            markets={markets}
            now={state.readAt}
            onBacktest={backtest}
            onClose={() => setEditor(undefined)}
          />
        </div>
      ) : null}
      {strategies.length ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {strategies.map((strategy) => (
            <StrategyCard
              key={strategy.id}
              now={state.readAt}
              onEdit={() => edit(strategy)}
              strategy={strategy}
            />
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          No strategies yet. Start a grid, a DCA, an AI-managed strategy or a
          standing price instruction: you review its exact effects before it
          runs, and can backtest its rules first.
        </p>
      )}
      <BacktestSection seed={seed} />
    </>
  );
}
