"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ComponentProps,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  FlaskConical,
  LoaderCircle,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import {
  backtestPeriodSchema,
  RECORDED_PROPOSAL_FIXTURES,
} from "@crypto-trading/backtest";
import type { Instrument } from "@crypto-trading/domain";

import { BacktestResults } from "@/components/backtest/backtest-results";
import {
  loadPeriodSummary,
  runBacktest,
} from "@/app/strategies/backtest-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BacktestOutcome, PeriodSummaryOutcome } from "@/lib/backtest";
import { formatPriceText } from "@/lib/backtest-display";
import {
  buildBacktestRequest,
  DCA_INTERVALS,
  DEFAULT_FORM,
  defaultPeriod,
  EMPTY_STANDING_ENTRY,
  MAX_STANDING_ENTRIES,
  STRATEGY_CHOICES,
  suggestPrices,
  utcToday,
  type BacktestForm,
  type PeriodPrices,
  type StandingEntryFields,
} from "@/lib/backtest-form";
import { cn } from "@/lib/utils";

const PAIRS: { value: Instrument; label: string }[] = [
  { value: "BTC-USDT", label: "BTC/USDT" },
  { value: "ETH-USDT", label: "ETH/USDT" },
];

// The first day Binance lists BTCUSDT and ETHUSDT hourly candles.
const FIRST_DAY = "2017-08-17";

// Today's date changes rarely, and the server renders without one.
const noSubscription = () => () => {};
const serverToday = () => null;

/** The form with grid and instruction prices suggested from the open. */
function withSuggestedPrices(
  form: BacktestForm,
  prices: PeriodPrices,
): BacktestForm {
  const suggestion = suggestPrices(prices);
  return {
    ...form,
    grid: { ...form.grid, ...suggestion.grid },
    standing: [suggestion.standing],
  };
}

/**
 * Runs a strategy's rules over up to 30 days of past hourly candles, on the
 * same planners, execution checks and loss limits as live strategies, and
 * shows the metrics, the equity curve and the trades.
 */
export function BacktestRunner() {
  const today = useSyncExternalStore(noSubscription, utcToday, serverToday);
  const [form, setForm] = useState<BacktestForm>(DEFAULT_FORM);
  const [summary, setSummary] = useState<PeriodSummaryOutcome>();
  const [outcome, setOutcome] = useState<BacktestOutcome>();
  const [problem, setProblem] = useState<string>();
  const [running, startRunning] = useTransition();
  const [loadingSummary, startLoadingSummary] = useTransition();
  // Prices follow the period's open until the customer edits one.
  const followOpen = useRef(true);

  const fixture = RECORDED_PROPOSAL_FIXTURES.find(
    (entry) => entry.id === form.fixtureId,
  );
  const replay = form.choice === "recorded_proposals";
  const period = form.period ?? (today ? defaultPeriod(today) : undefined);
  const start = period?.start;
  const end = period?.end;

  const update = (change: Partial<BacktestForm>) =>
    setForm((current) => ({ ...current, ...change }));
  const applySuggestion = (prices: PeriodPrices) =>
    setForm((current) => withSuggestedPrices(current, prices));

  // Read the period's prices whenever the pair or the dates change.
  useEffect(() => {
    const dates = { start, end };
    if (replay || !backtestPeriodSchema.safeParse(dates).success) return;
    startLoadingSummary(async () => {
      const loaded = await loadPeriodSummary({
        instrument: form.instrument,
        period: dates,
      });
      setSummary(loaded);
      if (loaded.status === "ready" && followOpen.current)
        setForm((current) => withSuggestedPrices(current, loaded.summary));
    });
  }, [form.instrument, start, end, replay]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!period) return;
    const built = buildBacktestRequest(form, period);
    if (built.status !== "ready") {
      setProblem(built.message);
      return;
    }
    setProblem(undefined);
    startRunning(async () => setOutcome(await runBacktest(built.request)));
  }

  const editPrices = () => {
    followOpen.current = false;
  };

  return (
    <div className="space-y-6">
      <form className="space-y-5" noValidate onSubmit={submit}>
        <Choice
          label="Strategy"
          onChange={(choice) => update({ choice })}
          options={STRATEGY_CHOICES}
          value={form.choice}
        />

        {replay ? (
          <FixtureSummary fixture={fixture} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Choice
                className="col-span-2 md:col-span-1"
                label="Pair"
                onChange={(instrument) => update({ instrument })}
                options={PAIRS}
                value={form.instrument}
              />
              <Field
                label="From (UTC)"
                max={today ?? undefined}
                min={FIRST_DAY}
                onChange={(start) =>
                  period && update({ period: { ...period, start } })
                }
                type="date"
                value={period?.start ?? ""}
              />
              <Field
                label="To (UTC)"
                max={today ?? undefined}
                min={FIRST_DAY}
                onChange={(end) =>
                  period && update({ period: { ...period, end } })
                }
                type="date"
                value={period?.end ?? ""}
              />
              <Field
                inputMode="decimal"
                label="Allocation (USDT)"
                onChange={(allocation) => update({ allocation })}
                value={form.allocation}
              />
            </div>
            <PeriodLine
              loading={loadingSummary}
              onUseOpen={(prices) => {
                followOpen.current = true;
                applySuggestion(prices);
              }}
              summary={summary}
            />

            {form.choice === "grid" ? (
              <GridFields
                form={form}
                onChange={(grid) => {
                  if (
                    "lowerPrice" in grid ||
                    "upperPrice" in grid ||
                    "rangeStopPrice" in grid
                  )
                    editPrices();
                  update({ grid: { ...form.grid, ...grid } });
                }}
              />
            ) : form.choice === "dca" ? (
              <DcaFields
                form={form}
                onChange={(dca) => update({ dca: { ...form.dca, ...dca } })}
              />
            ) : (
              <StandingFields
                entries={form.standing}
                onChange={(standing) => {
                  editPrices();
                  update({ standing });
                }}
              />
            )}

            <fieldset className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <legend className="mb-2 text-sm font-medium">Limits</legend>
              <Field
                hint="Since midnight UTC"
                inputMode="decimal"
                label="Daily loss limit (USDT)"
                onChange={(dailyLossLimit) => update({ dailyLossLimit })}
                value={form.dailyLossLimit}
              />
              <Field
                inputMode="decimal"
                label="Total loss limit (USDT)"
                onChange={(totalLossLimit) => update({ totalLossLimit })}
                value={form.totalLossLimit}
              />
              <Field
                hint="Each entry, from its first fill"
                inputMode="numeric"
                label="Holding period (hours)"
                onChange={(holdingHours) => update({ holdingHours })}
                value={form.holdingHours}
              />
            </fieldset>
          </>
        )}

        <details className="group rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">
            Costs: {form.assumptions.makerFeePercent}% maker,{" "}
            {form.assumptions.takerFeePercent}% taker,{" "}
            {form.assumptions.slippagePercent}% slippage
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-4 pb-1 md:grid-cols-4">
            <Field
              hint="Binance's regular rate, without BNB"
              inputMode="decimal"
              label="Maker fee (%)"
              onChange={(makerFeePercent) =>
                update({
                  assumptions: { ...form.assumptions, makerFeePercent },
                })
              }
              value={form.assumptions.makerFeePercent}
            />
            <Field
              inputMode="decimal"
              label="Taker fee (%)"
              onChange={(takerFeePercent) =>
                update({
                  assumptions: { ...form.assumptions, takerFeePercent },
                })
              }
              value={form.assumptions.takerFeePercent}
            />
            <Field
              hint="On buys at the ask, stops and closes"
              inputMode="decimal"
              label="Slippage (%)"
              onChange={(slippagePercent) =>
                update({
                  assumptions: { ...form.assumptions, slippagePercent },
                })
              }
              value={form.assumptions.slippagePercent}
            />
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={running || !period} size="lg" type="submit">
            {running ? <LoaderCircle className="animate-spin" /> : <Play />}
            {running ? "Running…" : "Run backtest"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Uses Binance&apos;s public spot history, downloaded once and kept on
            this machine. Nothing is traded.
          </p>
        </div>
        {problem ? (
          <p className="text-sm text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
      </form>

      {outcome && outcome.status !== "completed" ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>The backtest did not run</AlertTitle>
          <AlertDescription>{outcome.message}</AlertDescription>
        </Alert>
      ) : null}
      {outcome?.status === "completed" ? (
        <div
          className={cn(
            "transition-opacity",
            running ? "opacity-60" : undefined,
          )}
        >
          <BacktestResults result={outcome.result} />
        </div>
      ) : null}
    </div>
  );
}

function PeriodLine({
  summary,
  loading,
  onUseOpen,
}: {
  summary?: PeriodSummaryOutcome;
  loading: boolean;
  onUseOpen: (prices: PeriodPrices) => void;
}) {
  if (!summary)
    return (
      <p className="min-h-8 text-sm text-muted-foreground">
        {loading ? "Reading the period's prices…" : null}
      </p>
    );
  if (summary.status !== "ready")
    return (
      <p className="min-h-8 text-sm text-muted-foreground">{summary.message}</p>
    );
  const { summary: market } = summary;
  return (
    <div
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground",
        loading ? "opacity-60" : undefined,
      )}
    >
      <p>
        {market.instrument.replace("-", "/")} opened the period at{" "}
        <span className="text-foreground tabular-nums">
          {formatPriceText(market.firstOpen)}
        </span>{" "}
        and traded from{" "}
        <span className="tabular-nums">{formatPriceText(market.low)}</span> to{" "}
        <span className="tabular-nums">{formatPriceText(market.high)}</span>{" "}
        over {market.candles} hours.
      </p>
      <Button
        onClick={() => onUseOpen(market)}
        size="sm"
        type="button"
        variant="outline"
      >
        Suggest prices from the open
      </Button>
    </div>
  );
}

function FixtureSummary({
  fixture,
}: {
  fixture?: (typeof RECORDED_PROPOSAL_FIXTURES)[number];
}) {
  if (!fixture)
    return (
      <p className="text-sm text-muted-foreground">
        No recorded proposals are available to replay.
      </p>
    );
  const { rules } = fixture;
  return (
    <Alert>
      <FlaskConical />
      <AlertTitle>Replays a fixture, not AI performance</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          <span className="font-medium text-foreground">{fixture.title}</span>.{" "}
          {fixture.provenance}
        </p>
        <p>
          {fixture.proposals.length} proposals on{" "}
          {fixture.instrument.replace("-", "/")}, {fixture.period.start} to{" "}
          {fixture.period.end}, allocation {fixture.allocation} USDT. Rules:
          positions up to {rules.maxPositionNotional} USDT, at most{" "}
          {rules.maxProtectedEntries} entries, each held up to{" "}
          {rules.holdingPeriodSeconds / 3600} hours, loss limits{" "}
          {rules.lossLimits.daily} USDT a day and {rules.lossLimits.total} USDT
          in total. The market, period and rules come from the fixture.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function GridFields({
  form,
  onChange,
}: {
  form: BacktestForm;
  onChange: (change: Partial<BacktestForm["grid"]>) => void;
}) {
  const grid = form.grid;
  return (
    <fieldset className="grid grid-cols-2 gap-4 md:grid-cols-5">
      <legend className="mb-2 text-sm font-medium">Grid</legend>
      <Field
        inputMode="decimal"
        label="Lower price"
        onChange={(lowerPrice) => onChange({ lowerPrice })}
        value={grid.lowerPrice}
      />
      <Field
        inputMode="decimal"
        label="Upper price"
        onChange={(upperPrice) => onChange({ upperPrice })}
        value={grid.upperPrice}
      />
      <Field
        hint="Including both ends"
        inputMode="numeric"
        label="Levels"
        onChange={(levelCount) => onChange({ levelCount })}
        value={grid.levelCount}
      />
      <Field
        inputMode="decimal"
        label="Per level (USDT)"
        onChange={(amountPerLevel) => onChange({ amountPerLevel })}
        value={grid.amountPerLevel}
      />
      <Field
        hint="Below the lower price"
        inputMode="decimal"
        label="Range stop"
        onChange={(rangeStopPrice) => onChange({ rangeStopPrice })}
        value={grid.rangeStopPrice}
      />
    </fieldset>
  );
}

function DcaFields({
  form,
  onChange,
}: {
  form: BacktestForm;
  onChange: (change: Partial<BacktestForm["dca"]>) => void;
}) {
  const dca = form.dca;
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-medium">DCA</legend>
      <Choice
        label="Buy every"
        onChange={(interval) => onChange({ interval })}
        options={DCA_INTERVALS}
        value={dca.interval}
      />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Field
          inputMode="decimal"
          label="Per buy (USDT)"
          onChange={(amountPerBuy) => onChange({ amountPerBuy })}
          value={dca.amountPerBuy}
        />
        <Field
          hint="From the period's start"
          inputMode="numeric"
          label="Number of buys"
          onChange={(maxBuys) => onChange({ maxBuys })}
          value={dca.maxBuys}
        />
        <Field
          inputMode="decimal"
          label="Stop loss (%)"
          onChange={(stopLossPercent) => onChange({ stopLossPercent })}
          value={dca.stopLossPercent}
        />
        <Field
          inputMode="decimal"
          label="Take profit (%)"
          onChange={(takeProfitPercent) => onChange({ takeProfitPercent })}
          value={dca.takeProfitPercent}
        />
        <Field
          hint="Empty for no dip rule"
          inputMode="decimal"
          label="Dip drop (%)"
          onChange={(dipDropPercent) => onChange({ dipDropPercent })}
          value={dca.dipDropPercent}
        />
        <Field
          hint="Above 1, at most 2"
          inputMode="decimal"
          label="Dip multiplier"
          onChange={(dipMultiplier) => onChange({ dipMultiplier })}
          value={dca.dipMultiplier}
        />
      </div>
    </fieldset>
  );
}

function StandingFields({
  entries,
  onChange,
}: {
  entries: StandingEntryFields[];
  onChange: (entries: StandingEntryFields[]) => void;
}) {
  const set = (index: number, change: Partial<StandingEntryFields>) =>
    onChange(
      entries.map((entry, at) =>
        at === index ? { ...entry, ...change } : entry,
      ),
    );
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">
        Entries, which expire when the period ends
      </legend>
      {entries.map((entry, index) => (
        <div
          className="grid grid-cols-2 items-end gap-4 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
          key={index}
        >
          <Field
            inputMode="decimal"
            label={`Entry ${index + 1} quantity`}
            onChange={(quantity) => set(index, { quantity })}
            value={entry.quantity}
          />
          <Field
            inputMode="decimal"
            label="Buy at"
            onChange={(entryPrice) => set(index, { entryPrice })}
            value={entry.entryPrice}
          />
          <Field
            inputMode="decimal"
            label="Stop loss"
            onChange={(stopLossPrice) => set(index, { stopLossPrice })}
            value={entry.stopLossPrice}
          />
          <Field
            inputMode="decimal"
            label="Take profit"
            onChange={(takeProfitPrice) => set(index, { takeProfitPrice })}
            value={entry.takeProfitPrice}
          />
          <Button
            aria-label={`Remove entry ${index + 1}`}
            disabled={entries.length === 1}
            onClick={() => onChange(entries.filter((_, at) => at !== index))}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        disabled={entries.length >= MAX_STANDING_ENTRIES}
        onClick={() => onChange([...entries, EMPTY_STANDING_ENTRY])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus />
        Add an entry
      </Button>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  onChange,
  ...props
}: Omit<ComponentProps<typeof Input>, "onChange"> & {
  label: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        aria-describedby={hint ? `${id}-hint` : undefined}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
      {hint ? (
        <p className="text-xs text-muted-foreground" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A segmented control built from radio buttons. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg border border-border bg-background/40 p-0.5">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              className={cn(
                buttonVariants({
                  variant: selected ? "secondary" : "ghost",
                  size: "sm",
                }),
                "cursor-pointer has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                selected ? undefined : "text-muted-foreground",
              )}
              key={option.value}
            >
              <input
                checked={selected}
                className="sr-only"
                name={name}
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
