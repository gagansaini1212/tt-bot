"use client";

import {
  useEffect,
  useId,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Decimal from "decimal.js";
import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Info,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import {
  defaultStopLossPrice,
  manualOrderRequestSchema,
  marketEntryPrice,
  planManualOrder,
  type ManualOrderOutcome,
  type ManualOrderTicket,
} from "@crypto-trading/exchanges/manual-order";
import {
  binanceSymbol,
  type TestnetInstrument,
} from "@crypto-trading/exchanges/order-rules";

import {
  checkOrderStatus,
  loadOrderTicket,
  placeOrder,
} from "@/app/order-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  baseAsset,
  isDecimal,
  newListClientOrderId,
  quantityForShare,
} from "@/lib/order-display";
import type { OrderTicketState } from "@/lib/orders";
import { cn } from "@/lib/utils";

type OrderType = "limit" | "market" | "stop_limit";
type Draft = {
  instrument?: TestnetInstrument;
  type: OrderType;
  stopPrice: string;
  price: string;
  quantity: string;
  takeProfitPrice: string;
  stopLossPrice: string;
  // Until the trader types a stop loss, it follows the default percentage
  // from Settings below the entry price.
  stopLossEdited: boolean;
};

// The preview is advisory, so it uses fixed IDs. The worker issues its own.
const PREVIEW = {
  listClientOrderId: "ct_preview",
  ids: {
    proposalId: "00000000-0000-4000-8000-000000000001",
    sourceSnapshotId: "00000000-0000-4000-8000-000000000002",
  },
};
const SHARES = [0.25, 0.5, 0.75, 1];
// Outcomes after which the order may exist on Binance. Its ID is kept, so a
// retry is refused as a duplicate, until a status check settles it.
const UNSETTLED = new Set<ManualOrderOutcome["status"]>([
  "unknown",
  "unverified",
  "duplicate",
]);

export function OrderTicket({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [ticket, setTicket] = useState<OrderTicketState>();
  const [loading, startLoading] = useTransition();
  const [submitting, startSubmitting] = useTransition();
  const [draft, setDraft] = useState<Draft>({
    type: "limit",
    stopPrice: "",
    price: "",
    quantity: "",
    takeProfitPrice: "",
    stopLossPrice: "",
    stopLossEdited: false,
  });
  const [attempt, setAttempt] = useState<{
    unsettledId?: string;
    outcome?: ManualOrderOutcome;
  }>({});

  const reload = () =>
    startLoading(async () => setTicket(await loadOrderTicket()));
  // Limits and balances change with every order, so read them on each open.
  useEffect(() => {
    if (open) reload();
  }, [open]);

  const ready = ticket?.status === "ready" ? ticket.ticket : undefined;
  const form = ready ? orderForm(draft, ready) : undefined;

  const submit = () => {
    if (!form?.request || !form.plan?.passed) return;
    const id = attempt.unsettledId ?? newListClientOrderId();
    const request = { ...form.request, listClientOrderId: id };
    setAttempt({ unsettledId: id });
    startSubmitting(async () => {
      const outcome = await placeOrder(request);
      const unsettled = UNSETTLED.has(outcome.status);
      setAttempt({ unsettledId: unsettled ? id : undefined, outcome });
      if (!unsettled && !["invalid", "rejected"].includes(outcome.status))
        setDraft((current) => ({ ...current, quantity: "" }));
      setTicket(await loadOrderTicket());
    });
  };
  const checkStatus = () => {
    const id = attempt.unsettledId;
    if (!id) return;
    startSubmitting(async () => {
      const outcome = await checkOrderStatus(id);
      const unsettled = ["unknown", "unverified"].includes(outcome.status);
      setAttempt({ unsettledId: unsettled ? id : undefined, outcome });
      setTicket(await loadOrderTicket());
    });
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Place a testnet order</SheetTitle>
          <SheetDescription>
            A spot buy with its take profit and stop loss attached on Binance
            Spot Testnet. Virtual funds only.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-2">
          {!ticket ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading account limits…
            </p>
          ) : ticket.status === "unavailable" ? (
            <Alert>
              <Info />
              <AlertTitle>Orders are unavailable</AlertTitle>
              <AlertDescription>{ticket.message}</AlertDescription>
            </Alert>
          ) : (
            form && (
              <OrderFields
                draft={draft}
                form={form}
                loading={loading}
                onChange={(change) =>
                  setDraft((current) => ({ ...current, ...change }))
                }
                onReload={reload}
                ticket={ticket.ticket}
              />
            )
          )}
          {attempt.outcome ? <OutcomeAlert outcome={attempt.outcome} /> : null}
        </div>
        <SheetFooter className="border-t">
          {attempt.unsettledId && !submitting ? (
            <Button onClick={checkStatus} size="lg" variant="outline">
              <RefreshCw />
              Check order status
            </Button>
          ) : (
            <Button
              disabled={!form?.plan?.passed || submitting}
              onClick={submit}
              size="lg"
            >
              {submitting ? <LoaderCircle className="animate-spin" /> : null}
              {submitting
                ? "Sending to the worker…"
                : draft.type === "stop_limit"
                  ? `Place stop-limit buy${form?.base ? ` of ${form.base}` : ""}`
                  : form?.base
                    ? `Buy ${form.base} with exits`
                    : "Buy with exits"}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            The execution worker repeats every check before it sends the order.
          </p>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function orderForm(draft: Draft, ticket: ManualOrderTicket) {
  const instruments = ticket.policy.allowedInstruments;
  const instrument =
    draft.instrument && instruments.includes(draft.instrument)
      ? draft.instrument
      : instruments[0];
  const market = ticket.markets.find(
    (entry) => entry.rules.instrument === instrument,
  );
  const base = baseAsset(binanceSymbol(instrument));
  const marketPrice =
    market?.bestAsk && ticket.marketSlippage !== null
      ? marketEntryPrice(
          market.bestAsk,
          ticket.marketSlippage,
          market.rules.tickSize,
        )
      : undefined;
  const entryPrice = draft.type === "market" ? marketPrice : draft.price;
  const { defaultStopLossPercent } = ticket.riskLimits;
  const defaultStop =
    market && entryPrice && isDecimal(entryPrice)
      ? defaultStopLossPrice(
          entryPrice,
          defaultStopLossPercent,
          market.rules.tickSize,
        )
      : undefined;
  const stopLossPrice = draft.stopLossEdited
    ? draft.stopLossPrice
    : (defaultStop ?? "");
  const parsed = manualOrderRequestSchema.safeParse({
    type: draft.type,
    instrument,
    quantity: draft.quantity,
    ...(draft.type === "market" ? {} : { price: draft.price }),
    ...(draft.type === "stop_limit" ? { stopPrice: draft.stopPrice } : {}),
    takeProfitPrice: draft.takeProfitPrice,
    stopLossPrice,
    listClientOrderId: PREVIEW.listClientOrderId,
  });
  const missing = [
    draft.type === "stop_limit" &&
      !isDecimal(draft.stopPrice) &&
      "a stop price",
    draft.type !== "market" && !isDecimal(draft.price) && "a limit price",
    !isDecimal(draft.quantity) && "a quantity",
    !isDecimal(draft.takeProfitPrice) && "a take-profit price",
    !isDecimal(stopLossPrice) && "a stop-loss price",
  ].filter(Boolean) as string[];
  return {
    instrument,
    instruments,
    market,
    base,
    entryPrice,
    stopLossPrice,
    defaultStopLossPercent,
    missing,
    request: parsed.success ? parsed.data : undefined,
    // Measured on the ticket's clock, so the preview is a pure function of it.
    plan: parsed.success
      ? planManualOrder(
          parsed.data,
          ticket,
          new Date(ticket.capturedAt),
          PREVIEW.ids,
        )
      : undefined,
  };
}

function OrderFields({
  draft,
  form,
  ticket,
  loading,
  onChange,
  onReload,
}: {
  draft: Draft;
  form: ReturnType<typeof orderForm>;
  ticket: ManualOrderTicket;
  loading: boolean;
  onChange: (change: Partial<Draft>) => void;
  onReload: () => void;
}) {
  const { market, plan } = form;
  return (
    <>
      <div className="flex items-center justify-between gap-2 pt-4 text-xs text-muted-foreground">
        <span>
          Limits as of{" "}
          <time dateTime={ticket.capturedAt}>
            {ticket.capturedAt.slice(11, 19)} UTC
          </time>
        </span>
        <Button disabled={loading} onClick={onReload} size="xs" variant="ghost">
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <Segmented
        label="Market"
        onSelect={(instrument) => onChange({ instrument })}
        options={form.instruments.map((instrument) => ({
          value: instrument,
          label: instrument.replace("-", "/"),
        }))}
        value={form.instrument}
      />

      <div className="space-y-2">
        <Segmented
          label="Order type"
          onSelect={(type) => onChange({ type })}
          options={[
            { value: "limit", label: "Limit" },
            { value: "market", label: "Market" },
            { value: "stop_limit", label: "Stop-limit" },
          ]}
          value={draft.type}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {draft.type === "limit"
            ? "Rests on the book until it fills or you cancel it."
            : draft.type === "market"
              ? "Fills completely now at up to the price shown, or not at all."
              : "The execution worker holds it until the market trades at or above the stop price, checks it again, then sends a limit buy with its exits. Binance attaches exits only to limit entries, so it never holds a stop-limit buy itself."}
        </p>
      </div>

      <p className="text-sm">
        <span className="font-medium">Side:</span> Buy{" "}
        <span className="text-muted-foreground">· spot is long only</span>
      </p>

      {draft.type === "stop_limit" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <PriceField
            hint={
              market?.bestAsk
                ? `Above the best ask of ${market.bestAsk}`
                : undefined
            }
            label="Stop price"
            onChange={(stopPrice) => onChange({ stopPrice })}
            value={draft.stopPrice}
          />
          <PriceField
            hint="The most the buy pays once triggered"
            label="Limit price"
            onChange={(price) => onChange({ price })}
            value={draft.price}
          />
        </div>
      ) : draft.type === "limit" ? (
        <PriceField
          hint={market?.bestAsk ? `Best ask ${market.bestAsk}` : undefined}
          label="Limit price"
          onChange={(price) => onChange({ price })}
          value={draft.price}
        />
      ) : (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Market price</p>
          <p className="text-muted-foreground">
            {form.entryPrice
              ? `Pays at most ${form.entryPrice} USDT${market?.bestAsk ? ` (best ask ${market.bestAsk})` : ""}.`
              : "Unavailable: see the checks below."}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <PriceField
          label={`Quantity (${form.base})`}
          onChange={(quantity) => onChange({ quantity })}
          unit={form.base}
          value={draft.quantity}
        />
        <div className="grid grid-cols-4 gap-1.5">
          {SHARES.map((share) => {
            const quantity =
              market && form.entryPrice
                ? quantityForShare(
                    ticket.freeUsdt,
                    share,
                    form.entryPrice,
                    market.rules.stepSize,
                  )
                : undefined;
            return (
              <Button
                aria-label={`${share * 100}% of free USDT`}
                disabled={!quantity}
                key={share}
                onClick={() => quantity && onChange({ quantity })}
                size="sm"
                variant="outline"
              >
                {share * 100}%
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Of {new Decimal(ticket.freeUsdt).toFixed()} free USDT
          {form.entryPrice ? "" : ". Enter a limit price first"}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <PriceField
          label="Take profit"
          onChange={(takeProfitPrice) => onChange({ takeProfitPrice })}
          required
          value={draft.takeProfitPrice}
        />
        <PriceField
          hint={
            draft.stopLossEdited ? (
              <Button
                className="h-auto p-0 text-xs"
                onClick={() => onChange({ stopLossEdited: false })}
                size="xs"
                variant="link"
              >
                Use the {form.defaultStopLossPercent}% default
              </Button>
            ) : (
              `${form.defaultStopLossPercent}% below the entry, your default in Settings.`
            )
          }
          label="Stop loss"
          onChange={(stopLossPrice) =>
            onChange({ stopLossPrice, stopLossEdited: true })
          }
          required
          value={form.stopLossPrice}
        />
      </div>

      <section aria-labelledby="order-checks" className="space-y-2">
        <h3 className="text-sm font-medium" id="order-checks">
          Pre-execution checks
        </h3>
        {plan ? (
          <ul className="space-y-2">
            {plan.checks.map((check) => (
              <CheckItem key={check.name} {...check} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {form.missing.length
              ? `Enter ${joinWords(form.missing)} to run the checks.`
              : "Check the numbers entered: use digits and at most one decimal point."}
          </p>
        )}
      </section>

      {plan?.entry ? (
        <section aria-labelledby="order-legs" className="space-y-2 text-sm">
          <h3 className="font-medium" id="order-legs">
            {draft.type === "stop_limit"
              ? "Held by the worker, then sent to Binance as one order list"
              : "Sent to Binance as one order list"}
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {draft.type === "stop_limit" ? (
              <>
                <dt className="text-muted-foreground">Trigger</dt>
                <dd>
                  When {form.instrument.replace("-", "/")} trades at or above{" "}
                  {draft.stopPrice}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Entry</dt>
            <dd>
              {plan.entry.timeInForce === "FOK"
                ? "Fill-or-kill limit"
                : "Limit"}{" "}
              buy {plan.entry.quantity} {form.base} at {plan.entry.price}
            </dd>
            <dt className="text-muted-foreground">Take profit</dt>
            <dd>Limit-maker sell at {plan.entry.takeProfitPrice}</dd>
            <dt className="text-muted-foreground">Stop loss</dt>
            <dd>Stop-market sell at {plan.entry.stopLossPrice}</dd>
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            Binance places the exits once the entry fills completely, sized from
            the {form.base} received after fees. A partly filled entry has no
            exits yet. Cancelling any order in the list cancels all three.
          </p>
        </section>
      ) : null}
    </>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { value: T | string; label: string; disabled?: boolean }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" id={labelId}>
        {label}
      </p>
      <div
        aria-labelledby={labelId}
        className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-border bg-background/40 p-0.5"
        role="group"
      >
        {options.map((option) => (
          <Button
            aria-pressed={value === option.value}
            className={
              value === option.value ? undefined : "text-muted-foreground"
            }
            disabled={option.disabled}
            key={option.value}
            onClick={() => onSelect(option.value as T)}
            size="sm"
            variant={value === option.value ? "secondary" : "ghost"}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function PriceField({
  label,
  value,
  onChange,
  hint,
  unit = "USDT",
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  unit?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="font-normal text-muted-foreground">Required</span>
        ) : null}
      </Label>
      <div className="relative">
        <Input
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoComplete="off"
          className="pr-14 font-mono"
          id={id}
          inputMode="decimal"
          onChange={(event) => onChange(event.target.value.trim())}
          placeholder="0.00"
          required={required}
          value={value}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
          {unit}
        </span>
      </div>
      {hint ? (
        <p className="text-xs text-muted-foreground" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function CheckItem({
  label,
  passed,
  detail,
}: {
  label: string;
  passed: boolean;
  detail: string;
}) {
  const Icon = passed ? CheckCircle2 : CircleX;
  return (
    <li className="flex gap-2 text-sm">
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          passed
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-destructive",
        )}
      />
      <span>
        <span className="font-medium">
          {label}
          <span className="sr-only">{passed ? ": passed" : ": failed"}</span>
        </span>
        <span className="block text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

const OUTCOME_TITLES: Record<ManualOrderOutcome["status"], string> = {
  invalid: "Not sent",
  rejected: "Not placed",
  duplicate: "Already submitted",
  not_found: "Not on Binance",
  confirmation_required: "Confirmation needed",
  not_open: "No longer open",
  unknown: "Outcome unknown",
  unverified: "Placed, not yet verified",
  held: "Held by the worker",
  working: "Order placed",
  protected: "Bought, exits active",
  closed: "Filled and closed",
  not_filled: "Not filled",
  protection_failed: "Position has no exits",
  cancelled: "Cancelled",
};

export function OutcomeAlert({
  outcome,
  children,
}: {
  outcome: ManualOrderOutcome;
  children?: ReactNode;
}) {
  const danger = ["invalid", "rejected", "protection_failed"].includes(
    outcome.status,
  );
  const success = ["held", "working", "protected", "cancelled"].includes(
    outcome.status,
  );
  const Icon = danger ? AlertTriangle : success ? CheckCircle2 : Info;
  return (
    <Alert role="status" variant={danger ? "destructive" : "default"}>
      <Icon />
      <AlertTitle>{OUTCOME_TITLES[outcome.status]}</AlertTitle>
      <AlertDescription>
        <p>{outcome.message}</p>
        {outcome.checks
          ?.filter((check) => !check.passed)
          .map((check) => (
            <p key={check.name}>
              {check.label}: {check.detail}
            </p>
          ))}
        {outcome.listClientOrderId ? (
          <p className="font-mono text-xs">
            Order ID {outcome.listClientOrderId}
          </p>
        ) : null}
        {children}
      </AlertDescription>
    </Alert>
  );
}

function joinWords(words: string[]) {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
