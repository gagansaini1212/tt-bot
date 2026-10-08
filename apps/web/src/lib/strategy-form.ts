// Browser-safe: the strategy form builds and checks its draft here, shows
// its effects, and hands its rules to the backtest. The worker checks the
// draft again before it saves it.
import Decimal from "decimal.js";
import {
  dcaBuyDueAt,
  gridLevelEntry,
  gridLevels,
  gridRangePosition,
  maximumCommitment,
  planDcaBuy,
  ruleLimits,
  standingEntryIntent,
  type DcaInterval,
  type Instrument,
  type StrategyRules,
} from "@crypto-trading/domain";
import {
  strategyDraftSchema,
  type ApprovalMode,
  type StrategyDraft,
  type StrategyKindName,
  type StrategyMarket,
  type StrategyView,
} from "@crypto-trading/exchanges/strategies";

import {
  DEFAULT_FORM as DEFAULT_BACKTEST_FORM,
  niceStep,
  type BacktestForm,
  type StandingEntryFields,
} from "./backtest-form";

/** What the strategy form holds: text as typed. Times are UTC. */
export type StrategyForm = {
  kind: StrategyKindName;
  name: string;
  instrument: Instrument;
  allocation: string;
  dailyLossLimit: string;
  totalLossLimit: string;
  holdingHours: string;
  grid: {
    lowerPrice: string;
    upperPrice: string;
    levelCount: string;
    amountPerLevel: string;
    rangeStopPrice: string;
    // "YYYY-MM-DDTHH:mm", UTC.
    entryExpiresAt: string;
  };
  dca: {
    amountPerBuy: string;
    interval: DcaInterval;
    maxBuys: string;
    stopLossPercent: string;
    takeProfitPercent: string;
    // Both empty turns the dip multiplier off.
    dipDropPercent: string;
    dipMultiplier: string;
    startsAt: string;
  };
  standing: { entries: StandingEntryFields[]; entryExpiresAt: string };
  ai: {
    instruments: Instrument[];
    maxPositionNotional: string;
    maxProtectedEntries: string;
    proposalApproval: ApprovalMode;
    analysisIntervalMinutes: string;
  };
};

const HOUR_MS = 60 * 60 * 1000;

/** A UTC time as a datetime-local value, to the minute. */
export function utcInput(time: number) {
  return new Date(time).toISOString().slice(0, 16);
}

/** A datetime-local value read as UTC, or undefined. */
function fromUtcInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.trim())) return undefined;
  const time = Date.parse(`${value.trim()}:00.000Z`);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** A new form, with times from `now`. Prices come from the market. */
export function newStrategyForm(
  kind: StrategyKindName,
  now: number,
  market?: StrategyMarket,
): StrategyForm {
  const price = market?.lastPrice ? new Decimal(market.lastPrice) : undefined;
  // Levels a round step of about 1% apart, three below the price, as the
  // backtest suggests them.
  const step = price ? niceStep(price.dividedBy(100)) : undefined;
  const lower =
    price && step
      ? price.dividedToIntegerBy(step).times(step).minus(step.times(3))
      : undefined;
  return {
    kind,
    name: "",
    instrument: market?.instrument ?? "BTC-USDT",
    allocation: kind === "dca" ? "225" : kind === "grid" ? "500" : "200",
    dailyLossLimit: "25",
    totalLossLimit: "75",
    holdingHours: "168",
    grid: {
      lowerPrice: lower?.toFixed() ?? "",
      upperPrice: lower && step ? lower.plus(step.times(5)).toFixed() : "",
      levelCount: "6",
      amountPerLevel: "100",
      rangeStopPrice: lower && step ? lower.minus(step).toFixed() : "",
      entryExpiresAt: utcInput(now + 7 * 24 * HOUR_MS),
    },
    dca: {
      amountPerBuy: "25",
      interval: "1d",
      maxBuys: "6",
      stopLossPercent: "5",
      takeProfitPercent: "5",
      dipDropPercent: "3",
      dipMultiplier: "1.5",
      startsAt: utcInput(Math.ceil(now / 60_000) * 60_000),
    },
    standing: {
      entries: [
        {
          quantity: "",
          entryPrice: "",
          stopLossPrice: "",
          takeProfitPrice: "",
        },
      ],
      entryExpiresAt: utcInput(now + 24 * HOUR_MS),
    },
    ai: {
      instruments: ["BTC-USDT"],
      maxPositionNotional: "100",
      maxProtectedEntries: "3",
      proposalApproval: "required",
      analysisIntervalMinutes: "60",
    },
  };
}

/** The form for a new version of `strategy`, from its current one. */
export function strategyFormFrom(strategy: StrategyView): StrategyForm {
  const { rules } = strategy;
  const base = newStrategyForm(rules.kind, Date.parse(strategy.createdAt));
  const time = (iso: string) => utcInput(Date.parse(iso));
  const form: StrategyForm = {
    ...base,
    name: strategy.name,
    allocation: strategy.allocation,
    dailyLossLimit: rules.lossLimits.daily,
    totalLossLimit: rules.lossLimits.total,
    holdingHours: new Decimal(rules.holdingPeriodSeconds)
      .dividedBy(3600)
      .toFixed(),
  };
  switch (rules.kind) {
    case "grid":
      return {
        ...form,
        instrument: rules.instrument,
        grid: {
          lowerPrice: rules.lowerPrice,
          upperPrice: rules.upperPrice,
          levelCount: String(rules.levelCount),
          amountPerLevel: rules.amountPerLevel,
          rangeStopPrice: rules.rangeStopPrice,
          entryExpiresAt: time(rules.entryExpiresAt),
        },
      };
    case "dca":
      return {
        ...form,
        instrument: rules.instrument,
        dca: {
          amountPerBuy: rules.amountPerBuy,
          interval: rules.interval,
          maxBuys: String(rules.maxBuys),
          stopLossPercent: rules.stopLossPercent,
          takeProfitPercent: rules.takeProfitPercent,
          dipDropPercent: rules.dip?.dropPercent ?? "",
          dipMultiplier: rules.dip?.multiplier ?? "",
          startsAt: time(rules.startsAt),
        },
      };
    case "standing_price_instruction":
      return {
        ...form,
        instrument: rules.instrument,
        standing: {
          entries: rules.entries.map((entry) => ({ ...entry })),
          entryExpiresAt: time(rules.entryExpiresAt),
        },
      };
    case "ai_managed":
      return {
        ...form,
        ai: {
          instruments: rules.allowedInstruments,
          maxPositionNotional: rules.maxPositionNotional,
          maxProtectedEntries: String(rules.maxProtectedEntries),
          proposalApproval: strategy.ai?.proposalApproval ?? "required",
          analysisIntervalMinutes: String(
            strategy.ai?.analysisIntervalMinutes ?? 60,
          ),
        },
      };
  }
}

const text = (value: string) => value.trim();
const integer = (value: string) =>
  /^\d+$/.test(text(value)) ? Number(text(value)) : Number.NaN;

/** Hours as whole seconds, or NaN. */
function holdingSeconds(hours: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(text(hours))) return Number.NaN;
  const seconds = new Decimal(text(hours)).times(3600);
  return seconds.isInteger() ? seconds.toNumber() : Number.NaN;
}

/** The draft the form describes, before validation. */
function formDraft(form: StrategyForm): Record<string, unknown> {
  const common = {
    marketKind: "spot",
    holdingPeriodSeconds: holdingSeconds(form.holdingHours),
    lossLimits: {
      daily: text(form.dailyLossLimit),
      total: text(form.totalLossLimit),
    },
  };
  let rules: Record<string, unknown>;
  switch (form.kind) {
    case "grid":
      rules = {
        kind: "grid",
        instrument: form.instrument,
        ...common,
        lowerPrice: text(form.grid.lowerPrice),
        upperPrice: text(form.grid.upperPrice),
        levelCount: integer(form.grid.levelCount),
        amountPerLevel: text(form.grid.amountPerLevel),
        rangeStopPrice: text(form.grid.rangeStopPrice),
        entryExpiresAt: fromUtcInput(form.grid.entryExpiresAt),
      };
      break;
    case "dca": {
      const drop = text(form.dca.dipDropPercent);
      const multiplier = text(form.dca.dipMultiplier);
      rules = {
        kind: "dca",
        instrument: form.instrument,
        ...common,
        amountPerBuy: text(form.dca.amountPerBuy),
        interval: form.dca.interval,
        startsAt: fromUtcInput(form.dca.startsAt),
        maxBuys: integer(form.dca.maxBuys),
        stopLossPercent: text(form.dca.stopLossPercent),
        takeProfitPercent: text(form.dca.takeProfitPercent),
        ...(drop || multiplier
          ? { dip: { dropPercent: drop, multiplier } }
          : {}),
      };
      break;
    }
    case "standing_price_instruction":
      rules = {
        kind: "standing_price_instruction",
        instrument: form.instrument,
        ...common,
        direction: "long",
        leverage: 1,
        entries: form.standing.entries.map((entry) => ({
          quantity: text(entry.quantity),
          entryPrice: text(entry.entryPrice),
          stopLossPrice: text(entry.stopLossPrice),
          takeProfitPrice: text(entry.takeProfitPrice),
        })),
        entryExpiresAt: fromUtcInput(form.standing.entryExpiresAt),
      };
      break;
    case "ai_managed":
      rules = {
        kind: "ai_managed",
        ...common,
        allowedInstruments: form.ai.instruments,
        allowShort: false,
        maxLeverage: 1,
        maxPositionNotional: text(form.ai.maxPositionNotional),
        maxProtectedEntries: integer(form.ai.maxProtectedEntries),
        // The AI may tighten stops, never move targets.
        takeProfitAdjustable: false,
      };
      break;
  }
  return {
    name: text(form.name),
    allocation: text(form.allocation),
    rules,
    ai:
      form.kind === "ai_managed"
        ? {
            proposalApproval: form.ai.proposalApproval,
            analysisIntervalMinutes: integer(form.ai.analysisIntervalMinutes),
          }
        : null,
  };
}

const LABELS: Record<string, string> = {
  name: "Name",
  allocation: "Allocation",
  "rules.lossLimits.daily": "Daily loss limit",
  "rules.lossLimits.total": "Total loss limit",
  "rules.holdingPeriodSeconds": "Holding period",
  "rules.lowerPrice": "Lower price",
  "rules.upperPrice": "Upper price",
  "rules.levelCount": "Levels",
  "rules.amountPerLevel": "Amount per level",
  "rules.rangeStopPrice": "Range stop",
  "rules.entryExpiresAt": "Entries expire",
  "rules.amountPerBuy": "Amount per buy",
  "rules.maxBuys": "Number of buys",
  "rules.startsAt": "First buy",
  "rules.stopLossPercent": "Stop loss",
  "rules.takeProfitPercent": "Take profit",
  "rules.dip.dropPercent": "Dip drop",
  "rules.dip.multiplier": "Dip multiplier",
  "rules.allowedInstruments": "Markets",
  "rules.maxPositionNotional": "Position limit",
  "rules.maxProtectedEntries": "Entries at once",
  "ai.analysisIntervalMinutes": "Analysis interval",
};

const ENTRY_FIELDS: Record<string, string> = {
  quantity: "quantity",
  entryPrice: "price",
  stopLossPrice: "stop loss",
  takeProfitPrice: "take profit",
};

function label(path: PropertyKey[]) {
  if (
    path[0] === "rules" &&
    path[1] === "entries" &&
    typeof path[2] === "number"
  )
    return [`Entry ${path[2] + 1}`, ENTRY_FIELDS[String(path[3])]]
      .filter(Boolean)
      .join(" ");
  return LABELS[path.join(".")];
}

export type BuiltDraft =
  | { status: "ready"; draft: StrategyDraft }
  | { status: "invalid"; message: string };

/**
 * The draft the form describes, checked with the schema the worker uses, or
 * the first problem with it, named by field.
 */
export function buildStrategyDraft(form: StrategyForm): BuiltDraft {
  const parsed = strategyDraftSchema.safeParse(formDraft(form));
  if (parsed.success) return { status: "ready", draft: parsed.data };
  const [issue] = parsed.error.issues;
  const name = label(issue.path);
  const message =
    issue.path.includes("holdingPeriodSeconds") && issue.code === "invalid_type"
      ? "Enter hours with at most 2 decimals."
      : issue.path.includes("entryExpiresAt") || issue.path.includes("startsAt")
        ? "Enter a date and time in UTC."
        : issue.message;
  return {
    status: "invalid",
    message: name ? `${name}: ${message}` : message,
  };
}

/** One line of a strategy's effects: what it does, exactly. */
export type Effect = { label: string; value: string; detail?: string };

/** An entry the rules can make, as it would be placed. */
export type EffectEntry = {
  label: string;
  quantity: string;
  price: string;
  cost: string;
  takeProfit: string;
  stopLoss: string;
  // Placed as soon as the strategy runs, given the market now.
  now?: boolean;
  note?: string;
};

export type Effects = {
  effects: Effect[];
  entries: EffectEntry[];
  warnings: string[];
};

/** The lower of the rules' entry limit and Binance's stop-order limit. */
export function entryLimit(rules: StrategyRules, market?: StrategyMarket) {
  const rulesLimit = ruleLimits(rules).maxProtectedEntries;
  return market ? Math.min(rulesLimit, market.maxStopOrders) : rulesLimit;
}

const usdt = (value: Decimal.Value) => `${new Decimal(value).toFixed()} USDT`;
const pair = (instrument: string) => instrument.replace("-", "/");

/**
 * What the strategy will do, from its rules and the market now: what it
 * can commit, the entries it can make with their exact prices and sizes,
 * and what its limits do. `markets` gives Binance's tick and lot steps and
 * stop-order limit.
 */
export function strategyEffects(
  draft: StrategyDraft,
  markets: StrategyMarket[],
  now: number,
): Effects {
  const { rules } = draft;
  const instrument =
    rules.kind === "ai_managed"
      ? rules.allowedInstruments[0]
      : rules.instrument;
  const market = markets.find((entry) => entry.instrument === instrument);
  const steps = market && {
    tickSize: market.tickSize,
    quantityStep: market.stepSize,
  };
  const limit = entryLimit(rules, market);
  const effects: Effect[] = [
    {
      label: "Allocation",
      value: usdt(draft.allocation),
      detail:
        "Caps every entry it holds, pending and open, together. It never borrows another strategy's allocation.",
    },
    {
      label: "Most it can commit at once",
      value: usdt(maximumCommitment(rules)),
      detail:
        rules.kind === "ai_managed"
          ? "The position limit in each market it may trade."
          : "Every entry its rules can make, pending or open together.",
    },
    {
      label: "Entries at once",
      value: String(limit),
      detail: market
        ? `The lower of its rules' ${ruleLimits(rules).maxProtectedEntries} and the ${market.maxStopOrders} open stop orders Binance allows on ${pair(market.instrument)}, shared with your other orders there. An entry that could not be protected waits.`
        : "At most the stop orders Binance allows on the symbol.",
    },
    {
      label: "Loss limits",
      value: `${usdt(rules.lossLimits.daily)} a day, ${usdt(rules.lossLimits.total)} in total`,
      detail:
        "Realized and unrealized results and fees, the day from midnight UTC. Reaching either cancels its pending entries, sells its open ones at market and pauses it until you resume it. It does not guarantee a maximum loss.",
    },
    {
      label: "Holding period",
      value: formatDuration(rules.holdingPeriodSeconds),
      detail:
        "From each entry's first fill. At its deadline the worker cancels what is left of the entry and sells what it holds.",
    },
  ];
  const entries: EffectEntry[] = [];
  const warnings: string[] = [];
  switch (rules.kind) {
    case "grid": {
      const levels = gridLevels(rules);
      effects.push({
        label: "Grid",
        value: `${rules.levelCount} levels from ${rules.lowerPrice} to ${rules.upperPrice}, ${new Decimal(levels[1]).minus(levels[0]).toFixed()} apart`,
        detail: `Buys ${usdt(rules.amountPerLevel)} at each level below the top, only below the market, nearest first, and takes profit at the next level up. Every entry's stop loss is the range stop at ${rules.rangeStopPrice}. If the market reaches the range stop or rises above ${rules.upperPrice}, it cancels its buys, sells what it holds and completes. It opens no entries after ${formatTime(rules.entryExpiresAt)}.`,
      });
      const price = market?.lastPrice;
      if (price) {
        const position = gridRangePosition(rules, price);
        if (position !== "in_range")
          warnings.push(
            position === "range_stop"
              ? `${pair(rules.instrument)} is at ${price}, at or below the range stop: the grid would close and complete at once.`
              : `${pair(rules.instrument)} is at ${price}, above the range: the grid would complete at once.`,
          );
      }
      let resting = 0;
      for (let level = rules.levelCount - 2; level >= 0; level--) {
        const entry = steps && gridLevelEntry(rules, level, steps);
        const below = price && new Decimal(levels[level]).lessThan(price);
        const now = Boolean(below && entry && resting < limit);
        if (now) resting++;
        entries.push(
          entry
            ? {
                label: `Level ${level + 1}`,
                quantity: entry.quantity,
                price: entry.entryPrice,
                cost: new Decimal(entry.quantity)
                  .times(entry.entryPrice)
                  .toFixed(),
                takeProfit: entry.takeProfitPrice,
                stopLoss: entry.stopLossPrice,
                now,
                note: now
                  ? "Rests now"
                  : below
                    ? "Waits for a free stop order"
                    : "Above the market",
              }
            : {
                label: `Level ${level + 1}`,
                quantity: "—",
                price: levels[level],
                cost: "—",
                takeProfit: levels[level + 1],
                stopLoss: rules.rangeStopPrice,
                note: steps
                  ? "Not traded: it cannot be protected at Binance's steps"
                  : undefined,
              },
        );
      }
      break;
    }
    case "dca": {
      const last = dcaBuyDueAt(rules, rules.maxBuys - 1);
      effects.push({
        label: "Schedule",
        value: `${rules.maxBuys} buys of ${usdt(rules.amountPerBuy)}, every ${INTERVAL_LABELS[rules.interval]}`,
        detail: `The first is due at ${formatTime(rules.startsAt)} and the last at ${last.toISOString().slice(0, 16).replace("T", " ")} UTC. Each is a limit buy at the best ask that expires when the next is due. A buy that cannot be made while it is due, such as while paused or with every stop order in use, is skipped and never made up.`,
      });
      if (rules.dip)
        effects.push({
          label: "Dip multiplier",
          value: `×${rules.dip.multiplier} when ${rules.dip.dropPercent}% below the previous buy`,
          detail: `Such a buy spends ${usdt(new Decimal(rules.amountPerBuy).times(rules.dip.multiplier))}. It never compounds.`,
        });
      effects.push({
        label: "Exits",
        value: `Stop loss ${rules.stopLossPercent}% below, take profit ${rules.takeProfitPercent}% above each buy`,
        detail: "Rounded up to the tick, so a stop never risks more.",
      });
      const ask = market?.bestAsk;
      if (ask && steps) {
        const plan = planDcaBuy(rules, {
          now: new Date(Math.max(now, Date.parse(rules.startsAt))),
          price: ask,
          steps,
          protectedEntries: 0,
          maxProtectedEntries: 1,
        });
        if (plan.action === "enter") {
          const [buy] = plan.intents;
          entries.push({
            label: "A buy at today's ask",
            quantity: buy.quantity,
            price: buy.entryPrice,
            cost: new Decimal(buy.quantity).times(buy.entryPrice).toFixed(),
            takeProfit: buy.takeProfitPrice,
            stopLoss: buy.stopLossPrice,
            now: Date.parse(rules.startsAt) <= now,
            note:
              Date.parse(rules.startsAt) <= now
                ? "Placed when it starts"
                : "Example at the ask now",
          });
        } else if (plan.action === "wait" && plan.reason === "unprotectable")
          warnings.push(
            `${usdt(rules.amountPerBuy)} buys less than Binance's lot step at ${ask}, or its stop or target rounds to the entry price.`,
          );
      }
      if (rules.maxBuys > limit)
        warnings.push(
          `At most ${limit} buys can be open at once; while ${limit} are open, a buy that falls due is skipped.`,
        );
      break;
    }
    case "standing_price_instruction":
      effects.push({
        label: "Entries",
        value: `${rules.entries.length} limit buy${rules.entries.length === 1 ? "" : "s"} at your prices`,
        detail: `Unfilled entries expire together at ${formatTime(rules.entryExpiresAt)}. An entry that filled anything is never placed again; one a pause cancelled before it filled is placed again on resume. The AI never changes them.`,
      });
      rules.entries.forEach((_, index) => {
        const entry = standingEntryIntent(rules, index);
        entries.push({
          label: `Entry ${index + 1}`,
          quantity: entry.quantity,
          price: entry.entryPrice,
          cost: new Decimal(entry.quantity).times(entry.entryPrice).toFixed(),
          takeProfit: entry.takeProfitPrice,
          stopLoss: entry.stopLossPrice,
          now: index < limit,
          note:
            index < limit
              ? "Placed when it starts"
              : "Waits for a free stop order",
        });
      });
      break;
    case "ai_managed":
      effects.push(
        {
          label: "Markets",
          value: rules.allowedInstruments.map(pair).join(", "),
          detail: `Long spot entries only, up to ${usdt(rules.maxPositionNotional)} in each market. The AI may tighten a stop but never loosen it or move a target.`,
        },
        {
          label: "Approval",
          value:
            draft.ai?.proposalApproval === "automatic"
              ? "Automatic, within these limits"
              : "You approve each proposal",
          detail:
            draft.ai?.proposalApproval === "automatic"
              ? "Each proposal that passes the execution checks is placed at once."
              : "Each proposal waits on Activity. Approving runs every execution check again before anything is sent.",
        },
        {
          label: "Analysis",
          value: `Every ${formatDuration((draft.ai?.analysisIntervalMinutes ?? 60) * 60)}`,
          detail:
            "The worker asks the AI for one proposal or a decision not to trade, and records it with the model and its inputs.",
        },
      );
      break;
  }
  return { effects, entries, warnings };
}

const INTERVAL_LABELS: Record<DcaInterval, string> = {
  "1h": "hour",
  "4h": "4 hours",
  "12h": "12 hours",
  "1d": "day",
  "1w": "week",
};

/** Like "2 days 4 hours", "90 minutes". */
export function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  if (!Number.isInteger(hours)) return `${minutes} minutes`;
  if (hours < 24 || hours % 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? "" : "s"}`;
}

function formatTime(iso: string) {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The backtest form for these rules, so the backtest runs them over past
 * candles. A backtest runs a period of its own: a DCA starts, and a grid's or
 * instruction's entries expire, with that period. An AI-managed strategy
 * replays the recorded proposals.
 */
export function backtestFormFor(draft: StrategyDraft): BacktestForm {
  const { rules } = draft;
  const hours = Math.max(1, Math.ceil(rules.holdingPeriodSeconds / 3600));
  const form: BacktestForm = {
    ...DEFAULT_BACKTEST_FORM,
    allocation: draft.allocation,
    dailyLossLimit: rules.lossLimits.daily,
    totalLossLimit: rules.lossLimits.total,
    holdingHours: String(hours),
  };
  switch (rules.kind) {
    case "grid":
      return {
        ...form,
        choice: "grid",
        instrument: rules.instrument,
        grid: {
          lowerPrice: rules.lowerPrice,
          upperPrice: rules.upperPrice,
          levelCount: String(rules.levelCount),
          amountPerLevel: rules.amountPerLevel,
          rangeStopPrice: rules.rangeStopPrice,
        },
      };
    case "dca":
      return {
        ...form,
        choice: "dca",
        instrument: rules.instrument,
        dca: {
          amountPerBuy: rules.amountPerBuy,
          interval: rules.interval,
          maxBuys: String(rules.maxBuys),
          stopLossPercent: rules.stopLossPercent,
          takeProfitPercent: rules.takeProfitPercent,
          dipDropPercent: rules.dip?.dropPercent ?? "",
          dipMultiplier: rules.dip?.multiplier ?? "",
        },
      };
    case "standing_price_instruction":
      return {
        ...form,
        choice: "standing_price_instruction",
        instrument: rules.instrument,
        standing: rules.entries.map((entry) => ({ ...entry })),
      };
    case "ai_managed":
      return { ...form, choice: "recorded_proposals" };
  }
}
