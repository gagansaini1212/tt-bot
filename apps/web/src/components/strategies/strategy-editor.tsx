"use client";

import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  FlaskConical,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import type { DcaInterval, Instrument } from "@crypto-trading/domain";
import {
  AI_ANALYSIS_INTERVALS,
  type AiSource,
  type StrategyDraft,
  type StrategyKindName,
  type StrategyMarket,
  type StrategyView,
} from "@crypto-trading/exchanges/strategies";

import { saveVersion, startStrategy } from "@/app/strategies/strategy-actions";
import { Choice, Field } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DCA_INTERVALS, MAX_STANDING_ENTRIES } from "@/lib/backtest-form";
import { formatDecimal } from "@/lib/format";
import type { StrategyActionResult } from "@/lib/strategies";
import {
  buildStrategyDraft,
  newStrategyForm,
  strategyEffects,
  strategyFormFrom,
  type StrategyForm,
} from "@/lib/strategy-form";

const KINDS: { value: StrategyKindName; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "dca", label: "DCA" },
  { value: "ai_managed", label: "AI-managed" },
  { value: "standing_price_instruction", label: "Standing price instruction" },
];

const PAIRS: { value: Instrument; label: string }[] = [
  { value: "BTC-USDT", label: "BTC/USDT" },
  { value: "ETH-USDT", label: "ETH/USDT" },
];

const ANALYSIS_LABELS: Record<number, string> = {
  15: "15 minutes",
  60: "Hour",
  240: "4 hours",
  1440: "Day",
};

const EMPTY_ENTRY = {
  quantity: "",
  entryPrice: "",
  stopLossPrice: "",
  takeProfitPrice: "",
};

/**
 * Creates a strategy, or a new version of one, from a form checked against
 * the same schemas as the worker. Before anything starts, the customer
 * reviews its exact effects: what it can commit, each entry it can make,
 * and what its limits do. The reviewed draft is the one sent.
 */
export function StrategyEditor({
  editing,
  markets,
  aiSource,
  now,
  onClose,
  onBacktest,
}: {
  // The strategy to make a new version of, or undefined for a new one.
  editing?: StrategyView;
  markets: StrategyMarket[];
  aiSource: AiSource;
  now: number;
  onClose: () => void;
  onBacktest: (draft: StrategyDraft) => void;
}) {
  const [form, setForm] = useState<StrategyForm>(() =>
    editing
      ? strategyFormFrom(editing)
      : newStrategyForm("grid", now, markets[0]),
  );
  // The draft under review, exactly as it would be sent.
  const [review, setReview] = useState<StrategyDraft>();
  const [problem, setProblem] = useState<string>();
  const [result, setResult] = useState<StrategyActionResult>();
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const titleId = useId();

  const update = (change: Partial<StrategyForm>) =>
    setForm((current) => ({ ...current, ...change }));
  const market = (instrument: Instrument) =>
    markets.find((entry) => entry.instrument === instrument);

  const build = () => {
    const built = buildStrategyDraft(form);
    if (built.status !== "ready") {
      setProblem(built.message);
      return undefined;
    }
    setProblem(undefined);
    return built.draft;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const draft = build();
    if (draft) setReview(draft);
  };

  const confirm = () => {
    if (!review || sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const outcome = editing
          ? await saveVersion({
              strategyId: editing.id,
              baseVersion: editing.version,
              draft: review,
            })
          : await startStrategy(review);
        setResult(outcome);
        if (outcome.result === "saved") onClose();
      } finally {
        sending.current = false;
      }
    });
  };

  return (
    <Card aria-labelledby={titleId} className="mt-6" role="region">
      <CardHeader>
        <CardTitle>
          <h2 id={titleId}>
            {editing
              ? `Edit ${editing.name}: version ${editing.version + 1}`
              : "New strategy"}
          </h2>
        </CardTitle>
        <CardDescription className="mt-1">
          {editing
            ? editing.status === "retired"
              ? "Saving makes a new version, and the strategy runs again under it."
              : "Saving makes a new version. Entries already open keep the version they were made under."
            : "Runs on Binance Spot Testnet with virtual funds. Review its exact effects before it starts."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {review ? (
          <Review
            aiSource={aiSource}
            draft={review}
            editing={editing}
            markets={markets}
            now={now}
            onBack={() => {
              setReview(undefined);
              setResult(undefined);
            }}
            onBacktest={() => onBacktest(review)}
            onConfirm={confirm}
            pending={pending}
            result={result}
          />
        ) : (
          <form className="space-y-5" noValidate onSubmit={submit}>
            {editing ? null : (
              <Choice
                label="Kind"
                onChange={(kind) =>
                  setForm({
                    ...newStrategyForm(
                      kind,
                      now,
                      market(form.instrument) ?? markets[0],
                    ),
                    name: form.name,
                  })
                }
                options={KINDS}
                value={form.kind}
              />
            )}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field
                label="Name"
                maxLength={80}
                onChange={(name) => update({ name })}
                value={form.name}
                wrapperClassName="col-span-2"
              />
              {form.kind === "ai_managed" ? null : (
                <Choice
                  className="col-span-2 md:col-span-1"
                  label="Pair"
                  onChange={(instrument) => update({ instrument })}
                  options={PAIRS}
                  value={form.instrument}
                />
              )}
              <Field
                inputMode="decimal"
                label="Allocation (USDT)"
                onChange={(allocation) => update({ allocation })}
                value={form.allocation}
              />
            </div>

            {form.kind === "grid" ? (
              <GridFields
                form={form}
                onChange={(grid) => update({ grid: { ...form.grid, ...grid } })}
              />
            ) : form.kind === "dca" ? (
              <DcaFields
                form={form}
                onChange={(dca) => update({ dca: { ...form.dca, ...dca } })}
              />
            ) : form.kind === "standing_price_instruction" ? (
              <StandingFields
                form={form}
                onChange={(standing) =>
                  update({ standing: { ...form.standing, ...standing } })
                }
              />
            ) : (
              <AiFields
                aiSource={aiSource}
                form={form}
                onChange={(ai) => update({ ai: { ...form.ai, ...ai } })}
              />
            )}

            <fieldset className="grid grid-cols-2 gap-4 md:grid-cols-3">
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
                inputMode="decimal"
                label="Holding period (hours)"
                onChange={(holdingHours) => update({ holdingHours })}
                value={form.holdingHours}
              />
            </fieldset>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">
                <Play />
                Review effects
              </Button>
              <Button
                onClick={() => {
                  const draft = build();
                  if (draft) onBacktest(draft);
                }}
                type="button"
                variant="outline"
              >
                <FlaskConical />
                Backtest these rules
              </Button>
              <Button onClick={onClose} type="button" variant="ghost">
                Cancel
              </Button>
            </div>
            {problem ? (
              <p className="text-sm text-destructive" role="alert">
                {problem}
              </p>
            ) : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Review({
  draft,
  editing,
  markets,
  aiSource,
  now,
  pending,
  result,
  onBack,
  onConfirm,
  onBacktest,
}: {
  draft: StrategyDraft;
  editing?: StrategyView;
  markets: StrategyMarket[];
  aiSource: AiSource;
  now: number;
  pending: boolean;
  result?: StrategyActionResult;
  onBack: () => void;
  onConfirm: () => void;
  onBacktest: () => void;
}) {
  const { effects, entries, warnings } = strategyEffects(draft, markets, now);
  return (
    <div className="space-y-5">
      <p className="text-sm">
        <span className="font-medium">{draft.name}</span> will do exactly this:
      </p>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {effects.map((effect) => (
          <div className="min-w-0" key={effect.label}>
            <dt className="text-xs text-muted-foreground">{effect.label}</dt>
            <dd className="font-medium">{effect.value}</dd>
            {effect.detail ? (
              <dd className="text-xs leading-5 text-muted-foreground">
                {effect.detail}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
      {draft.rules.kind === "ai_managed" ? (
        <Alert>
          <FlaskConical />
          <AlertTitle>
            {aiSource.kind === "fixture"
              ? "Decisions come from a recorded fixture"
              : "Decisions come from the analysis assistant"}
          </AlertTitle>
          <AlertDescription>{aiSource.description}</AlertDescription>
        </Alert>
      ) : null}
      {entries.length ? (
        // A focusable region, so keyboard users can scroll a table wider
        // than the screen.
        <div
          aria-label="Entries"
          className="relative w-full overflow-x-auto"
          role="region"
          tabIndex={0}
        >
          <table className="w-full caption-bottom text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Buy at</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Cost (USDT)</TableHead>
                <TableHead className="text-right">Take profit</TableHead>
                <TableHead className="text-right">Stop loss</TableHead>
                <TableHead>Now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.label}>
                  <TableCell>{entry.label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDecimal(entry.price)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.quantity === "—"
                      ? "—"
                      : formatDecimal(entry.quantity)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.cost === "—"
                      ? "—"
                      : formatDecimal(entry.cost, { cents: true })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDecimal(entry.takeProfit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDecimal(entry.stopLoss)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.note ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
      ) : null}
      {warnings.length ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Check before you start</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        Every entry passes the execution checks again, with fresh account data,
        before it is sent. Pause stops new entries and cancels pending ones,
        keeping open entries&apos; exits and deadlines. Close all also sells
        what the open entries hold. One strategy owns a market&apos;s position
        on this account; another strategy there waits until it holds nothing.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending} onClick={onConfirm}>
          {pending ? (
            <LoaderCircle className="animate-spin" />
          ) : editing ? (
            <Save />
          ) : (
            <Play />
          )}
          {editing ? `Save version ${editing.version + 1}` : "Start strategy"}
        </Button>
        <Button disabled={pending} onClick={onBacktest} variant="outline">
          <FlaskConical />
          Backtest these rules
        </Button>
        <Button disabled={pending} onClick={onBack} variant="ghost">
          <ArrowLeft />
          Back to edit
        </Button>
      </div>
      {result && result.result !== "saved" ? (
        <p className="text-sm text-destructive" role="alert">
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

function GridFields({
  form,
  onChange,
}: {
  form: StrategyForm;
  onChange: (change: Partial<StrategyForm["grid"]>) => void;
}) {
  const grid = form.grid;
  return (
    <fieldset className="grid grid-cols-2 gap-4 md:grid-cols-3">
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
      <Field
        label="No entries after (UTC)"
        onChange={(entryExpiresAt) => onChange({ entryExpiresAt })}
        type="datetime-local"
        value={grid.entryExpiresAt}
      />
    </fieldset>
  );
}

function DcaFields({
  form,
  onChange,
}: {
  form: StrategyForm;
  onChange: (change: Partial<StrategyForm["dca"]>) => void;
}) {
  const dca = form.dca;
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-medium">DCA</legend>
      <Choice
        label="Buy every"
        onChange={(interval: DcaInterval) => onChange({ interval })}
        options={DCA_INTERVALS}
        value={dca.interval}
      />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field
          inputMode="decimal"
          label="Per buy (USDT)"
          onChange={(amountPerBuy) => onChange({ amountPerBuy })}
          value={dca.amountPerBuy}
        />
        <Field
          inputMode="numeric"
          label="Number of buys"
          onChange={(maxBuys) => onChange({ maxBuys })}
          value={dca.maxBuys}
        />
        <Field
          label="First buy (UTC)"
          onChange={(startsAt) => onChange({ startsAt })}
          type="datetime-local"
          value={dca.startsAt}
          wrapperClassName="col-span-2"
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
  form,
  onChange,
}: {
  form: StrategyForm;
  onChange: (change: Partial<StrategyForm["standing"]>) => void;
}) {
  const { entries } = form.standing;
  const set = (index: number, change: Partial<(typeof entries)[number]>) =>
    onChange({
      entries: entries.map((entry, at) =>
        at === index ? { ...entry, ...change } : entry,
      ),
    });
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">
        Entries, at your prices
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
            onClick={() =>
              onChange({ entries: entries.filter((_, at) => at !== index) })
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-4">
        <Button
          disabled={entries.length >= MAX_STANDING_ENTRIES}
          onClick={() => onChange({ entries: [...entries, EMPTY_ENTRY] })}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus />
          Add an entry
        </Button>
        <Field
          label="Unfilled entries expire (UTC)"
          onChange={(entryExpiresAt) => onChange({ entryExpiresAt })}
          type="datetime-local"
          value={form.standing.entryExpiresAt}
        />
      </div>
    </fieldset>
  );
}

function AiFields({
  form,
  aiSource,
  onChange,
}: {
  form: StrategyForm;
  aiSource: AiSource;
  onChange: (change: Partial<StrategyForm["ai"]>) => void;
}) {
  const { ai } = form;
  const toggle = (instrument: Instrument, on: boolean) =>
    onChange({
      instruments: PAIRS.map((pair) => pair.value).filter((value) =>
        value === instrument ? on : ai.instruments.includes(value),
      ),
    });
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-medium">AI-managed</legend>
      <p className="text-sm text-muted-foreground">
        The AI proposes long spot entries within these limits, on a schedule.{" "}
        {aiSource.kind === "fixture"
          ? "No model is configured, so its decisions come from a recorded fixture, labelled as one."
          : null}
      </p>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Markets</legend>
        <div className="flex flex-wrap gap-4">
          {PAIRS.map((pair) => (
            <label className="flex items-center gap-2 text-sm" key={pair.value}>
              <input
                checked={ai.instruments.includes(pair.value)}
                className="size-4 accent-primary"
                onChange={(event) => toggle(pair.value, event.target.checked)}
                type="checkbox"
              />
              {pair.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Field
          hint="Per market, across its entries"
          inputMode="decimal"
          label="Position limit (USDT)"
          onChange={(maxPositionNotional) => onChange({ maxPositionNotional })}
          value={ai.maxPositionNotional}
        />
        <Field
          hint="At most 10"
          inputMode="numeric"
          label="Entries at once"
          onChange={(maxProtectedEntries) => onChange({ maxProtectedEntries })}
          value={ai.maxProtectedEntries}
        />
      </div>
      <Choice
        label="Proposals"
        onChange={(proposalApproval) => onChange({ proposalApproval })}
        options={[
          { value: "required", label: "I approve each one" },
          { value: "automatic", label: "Place automatically" },
        ]}
        value={ai.proposalApproval}
      />
      <Choice
        label="Ask the AI every"
        onChange={(analysisIntervalMinutes) =>
          onChange({ analysisIntervalMinutes })
        }
        options={AI_ANALYSIS_INTERVALS.map((minutes) => ({
          value: String(minutes),
          label: ANALYSIS_LABELS[minutes],
        }))}
        value={ai.analysisIntervalMinutes}
      />
    </fieldset>
  );
}
