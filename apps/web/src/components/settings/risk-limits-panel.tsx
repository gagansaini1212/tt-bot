"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { LoaderCircle, ShieldAlert } from "lucide-react";
import type { ManualRiskLimits } from "@crypto-trading/exchanges/manual-order";
import type { RiskLimitsState } from "@crypto-trading/exchanges/settings";

import { changeRiskLimits } from "@/app/settings-actions";
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

export function RiskLimitsPanel({
  state,
}: {
  state: WorkerState<{ limits: RiskLimitsState }>;
}) {
  // Kept here, so the message outlives the form a new version replaces.
  const [result, setResult] = useState<SettingsActionResult>();
  if (state.status !== "connected")
    return (
      <Alert variant="destructive">
        <ShieldAlert />
        <AlertTitle>Risk limits are unavailable</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  // A new version starts a fresh form from it.
  return (
    <RiskLimitsForm
      key={state.limits.current?.version ?? 0}
      limits={state.limits}
      onResult={setResult}
      result={result}
    />
  );
}

function RiskLimitsForm({
  limits,
  result,
  onResult,
}: {
  limits: RiskLimitsState;
  result?: SettingsActionResult;
  onResult: (result: SettingsActionResult) => void;
}) {
  const { current, platformMaximums, minimumStopLossPercent } = limits;
  const [values, setValues] = useState<ManualRiskLimits>({
    maxOrderNotional: current?.maxOrderNotional ?? "",
    maxDailyRisk: current?.maxDailyRisk ?? "",
    defaultStopLossPercent: current?.defaultStopLossPercent ?? "",
  });
  const [pending, startTransition] = useTransition();
  const change = (field: keyof ManualRiskLimits) => (value: string) =>
    setValues((previous) => ({ ...previous, [field]: value.trim() }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () =>
      onResult(
        await changeRiskLimits({
          ...values,
          baseVersion: current?.version ?? 0,
        }),
      ),
    );
  };

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Manual trading limits</CardTitle>
        <CardDescription className="leading-6">
          For orders you place from the dashboard and the CLI. The worker reads
          the latest limits immediately before each order, so a change applies
          to orders placed after you save it. Open orders keep the limits they
          were placed under.
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
            <AlertTitle>Dashboard orders are off</AlertTitle>
            <AlertDescription>
              Set your limits to place orders from the dashboard or the CLI.
            </AlertDescription>
          </Alert>
        )}
        <form className="space-y-6" onSubmit={submit}>
          <fieldset className="space-y-6" disabled={pending}>
            <LimitField
              hint={`The largest order, and the largest position, in USDT. Platform maximum ${platformMaximums.maxOrderNotional} USDT.`}
              label="Per-order cap"
              max={platformMaximums.maxOrderNotional}
              min="1"
              onChange={change("maxOrderNotional")}
              step="1"
              unit="USDT"
              value={values.maxOrderNotional}
            />
            <LimitField
              hint={`The most the day's manual orders may lose if every stop loss fills at its price, counted from 00:00 UTC. A CLI buy has no stop, so all of it counts. A stop-market exit can fill lower and fees are extra, so this is not a guaranteed maximum. Platform maximum ${platformMaximums.maxDailyRisk} USDT.`}
              label="Daily risk limit"
              max={platformMaximums.maxDailyRisk}
              min="1"
              onChange={change("maxDailyRisk")}
              step="1"
              unit="USDT"
              value={values.maxDailyRisk}
            />
            <LimitField
              hint={`The order drawer suggests a stop loss this far below the entry price. You can still change it on each order. From ${minimumStopLossPercent}% to ${platformMaximums.defaultStopLossPercent}%.`}
              label="Default stop loss"
              max={platformMaximums.defaultStopLossPercent}
              min={minimumStopLossPercent}
              onChange={change("defaultStopLossPercent")}
              step="0.1"
              unit="%"
              value={values.defaultStopLossPercent}
            />
          </fieldset>
          <Button disabled={pending} type="submit">
            {pending ? <LoaderCircle className="animate-spin" /> : null}
            Save limits
          </Button>
          <ActionMessage result={result} />
        </form>
      </CardContent>
    </Card>
  );
}

function LimitField({
  label,
  hint,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  min: string;
  max: string;
  step: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  // The slider is a shortcut; the text field holds the exact amount.
  const sliderValue = /^\d+(\.\d+)?$/.test(value) ? value : min;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr] sm:items-center">
        <div className="relative">
          <Input
            aria-describedby={`${id}-hint`}
            autoComplete="off"
            className="pr-14 font-mono"
            id={id}
            inputMode="decimal"
            onChange={(event) => onChange(event.target.value)}
            placeholder="0"
            required
            value={value}
          />
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
            {unit}
          </span>
        </div>
        <input
          aria-label={`${label} slider`}
          className="h-8 w-full accent-primary"
          max={max}
          min={min}
          onChange={(event) => onChange(event.target.value)}
          step={step}
          type="range"
          value={sliderValue}
        />
      </div>
      <p className="text-xs leading-5 text-muted-foreground" id={`${id}-hint`}>
        {hint}
      </p>
    </div>
  );
}
