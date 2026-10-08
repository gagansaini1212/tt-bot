"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { LoaderCircle, ShieldAlert } from "lucide-react";
import {
  PORTFOLIO_DRAWDOWN_LIMITS,
  type PortfolioLimitsState,
} from "@crypto-trading/exchanges/strategies";

import { changePortfolioLimits } from "@/app/settings-actions";
import { ActionMessage } from "@/components/settings/action-message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUtc } from "@/lib/format";
import type { SettingsActionResult } from "@/lib/settings";
import type { WorkerState } from "@/lib/worker-client";

/**
 * The portfolio's maximum daily drawdown, alongside each strategy's own
 * loss limits: a percentage of every strategy's allocation together.
 */
export function PortfolioLimitsPanel({
  state,
}: {
  state: WorkerState<{ limits: PortfolioLimitsState }>;
}) {
  const [result, setResult] = useState<SettingsActionResult>();
  if (state.status !== "connected")
    return (
      <Alert variant="destructive">
        <ShieldAlert />
        <AlertTitle>The drawdown limit is unavailable</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  return (
    <PortfolioLimitsForm
      key={state.limits.current?.version ?? 0}
      limits={state.limits}
      onResult={setResult}
      result={result}
    />
  );
}

function PortfolioLimitsForm({
  limits,
  result,
  onResult,
}: {
  limits: PortfolioLimitsState;
  result?: SettingsActionResult;
  onResult: (result: SettingsActionResult) => void;
}) {
  const { current } = limits;
  const [value, setValue] = useState(current?.maxDailyDrawdownPercent ?? "");
  const [pending, startTransition] = useTransition();
  const id = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () =>
      onResult(
        await changePortfolioLimits({
          maxDailyDrawdownPercent: value.trim(),
          baseVersion: current?.version ?? 0,
        }),
      ),
    );
  };

  return (
    <Card className="mt-6 max-w-3xl">
      <CardHeader>
        <CardTitle>Strategy limits</CardTitle>
        <CardDescription className="leading-6">
          Each strategy has its own daily and total loss limits, set with its
          rules. This limit covers them all: when your strategies together lose
          this share of their allocations since midnight UTC, counting realized
          and unrealized results and fees, the worker pauses every strategy and
          cancels their pending entries. Open entries keep their exits. Midnight
          does not resume them: you do.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {current ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Version {current.version}, saved{" "}
            <time dateTime={current.createdAt}>
              {formatUtc(Date.parse(current.createdAt))}
            </time>
            .
          </p>
        ) : (
          <Alert className="mb-4">
            <ShieldAlert />
            <AlertTitle>Strategies are off</AlertTitle>
            <AlertDescription>
              Set the portfolio&apos;s daily drawdown limit to start strategies.
            </AlertDescription>
          </Alert>
        )}
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor={id}>Maximum daily drawdown</Label>
            <div className="relative w-40">
              <Input
                aria-describedby={`${id}-hint`}
                autoComplete="off"
                className="pr-8 font-mono"
                disabled={pending}
                id={id}
                inputMode="decimal"
                onChange={(event) => setValue(event.target.value)}
                placeholder="5"
                required
                value={value}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                %
              </span>
            </div>
            <p
              className="text-xs leading-5 text-muted-foreground"
              id={`${id}-hint`}
            >
              From {PORTFOLIO_DRAWDOWN_LIMITS.min}% to{" "}
              {PORTFOLIO_DRAWDOWN_LIMITS.max}% of your strategies&apos;
              allocations. It measures strategies only; dashboard orders keep
              their own daily risk limit above.
            </p>
          </div>
          <Button disabled={pending} type="submit">
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            Save drawdown limit
          </Button>
          <ActionMessage result={result} />
        </form>
      </CardContent>
    </Card>
  );
}
