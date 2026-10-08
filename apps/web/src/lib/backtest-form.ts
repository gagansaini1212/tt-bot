// Browser-safe: the backtest form builds and checks its request here, and
// the server checks it again before it runs.
import {
  backtestRequestSchema,
  DAY_MS,
  DEFAULT_ASSUMPTIONS,
  MAX_BACKTEST_DAYS,
  RECORDED_PROPOSAL_FIXTURES,
  type BacktestAssumptions,
  type BacktestRequest,
} from "@crypto-trading/backtest";
import {
  ceilToStep,
  floorToStep,
  quantityFor,
  type DcaInterval,
  type Instrument,
  type StrategyRules,
} from "@crypto-trading/domain";
import Decimal from "decimal.js";

export type StrategyChoice =
  "grid" | "dca" | "standing_price_instruction" | "recorded_proposals";

export const STRATEGY_CHOICES: { value: StrategyChoice; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "dca", label: "DCA" },
  {
    value: "standing_price_instruction",
    label: "Standing price instruction",
  },
  { value: "recorded_proposals", label: "AI-managed (fixture)" },
];

export const DCA_INTERVALS: { value: DcaInterval; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "12h", label: "12 hours" },
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
];

export type StandingEntryFields = {
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
};

/** What the form holds: text as typed, turned into rules on submit. */
export type BacktestForm = {
  choice: StrategyChoice;
  instrument: Instrument;
  // Inclusive UTC dates. Unset until the customer picks one.
  period?: { start: string; end: string };
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
  };
  standing: StandingEntryFields[];
  fixtureId: string;
  assumptions: BacktestAssumptions;
};

export const MAX_STANDING_ENTRIES = 10;

export const EMPTY_STANDING_ENTRY: StandingEntryFields = {
  quantity: "",
  entryPrice: "",
  stopLossPrice: "",
  takeProfitPrice: "",
};

/** Starting values. Prices come from the chosen period, once it loads. */
export const DEFAULT_FORM: BacktestForm = {
  choice: "grid",
  instrument: "BTC-USDT",
  allocation: "1000",
  dailyLossLimit: "50",
  totalLossLimit: "150",
  holdingHours: "168",
  grid: {
    lowerPrice: "",
    upperPrice: "",
    // Five buy levels, as many entries as Binance can protect at once.
    levelCount: "6",
    amountPerLevel: "100",
    rangeStopPrice: "",
  },
  dca: {
    amountPerBuy: "25",
    interval: "1d",
    maxBuys: "30",
    stopLossPercent: "5",
    takeProfitPercent: "5",
    dipDropPercent: "3",
    dipMultiplier: "1.25",
  },
  standing: [EMPTY_STANDING_ENTRY],
  fixtureId: RECORDED_PROPOSAL_FIXTURES[0]?.id ?? "",
  assumptions: DEFAULT_ASSUMPTIONS,
};

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Today's UTC date, such as "2026-10-08". */
export function utcToday(now = Date.now()) {
  return isoDate(now);
}

/** The latest 30 whole UTC days: up to yesterday. */
export function defaultPeriod(today: string) {
  const end = Date.parse(today) - DAY_MS;
  return {
    start: isoDate(end - (MAX_BACKTEST_DAYS - 1) * DAY_MS),
    end: isoDate(end),
  };
}

const LABELS: Record<string, string> = {
  allocation: "Allocation",
  "period.end": "Period",
  "period.start": "Period",
  "rules.lossLimits.daily": "Daily loss limit",
  "rules.lossLimits.total": "Total loss limit",
  "rules.holdingPeriodSeconds": "Holding period",
  "rules.lowerPrice": "Lower price",
  "rules.upperPrice": "Upper price",
  "rules.levelCount": "Levels",
  "rules.amountPerLevel": "Amount per level",
  "rules.rangeStopPrice": "Range stop",
  "rules.amountPerBuy": "Amount per buy",
  "rules.maxBuys": "Number of buys",
  "rules.stopLossPercent": "Stop loss",
  "rules.takeProfitPercent": "Take profit",
  "rules.dip.dropPercent": "Dip drop",
  "rules.dip.multiplier": "Dip multiplier",
  "assumptions.makerFeePercent": "Maker fee",
  "assumptions.takerFeePercent": "Taker fee",
  "assumptions.slippagePercent": "Slippage",
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

const text = (value: string) => value.trim();

/** The rules the form describes, before validation. */
function formRules(
  form: BacktestForm,
  period: { start: string; end: string },
): Record<string, unknown> {
  const hours = text(form.holdingHours);
  const common = {
    instrument: form.instrument,
    marketKind: "spot",
    holdingPeriodSeconds: /^\d+$/.test(hours) ? Number(hours) * 3600 : NaN,
    lossLimits: {
      daily: text(form.dailyLossLimit),
      total: text(form.totalLossLimit),
    },
  };
  const start = `${period.start}T00:00:00.000Z`;
  // Entries may open until the period ends.
  const end = new Date(Date.parse(period.end) + DAY_MS).toISOString();
  const integer = (value: string) =>
    /^\d+$/.test(text(value)) ? Number(text(value)) : NaN;
  switch (form.choice) {
    case "grid":
      return {
        kind: "grid",
        ...common,
        lowerPrice: text(form.grid.lowerPrice),
        upperPrice: text(form.grid.upperPrice),
        levelCount: integer(form.grid.levelCount),
        amountPerLevel: text(form.grid.amountPerLevel),
        rangeStopPrice: text(form.grid.rangeStopPrice),
        entryExpiresAt: end,
      };
    case "dca": {
      const drop = text(form.dca.dipDropPercent);
      const multiplier = text(form.dca.dipMultiplier);
      return {
        kind: "dca",
        ...common,
        amountPerBuy: text(form.dca.amountPerBuy),
        interval: form.dca.interval,
        startsAt: start,
        maxBuys: integer(form.dca.maxBuys),
        stopLossPercent: text(form.dca.stopLossPercent),
        takeProfitPercent: text(form.dca.takeProfitPercent),
        ...(drop || multiplier
          ? { dip: { dropPercent: drop, multiplier } }
          : {}),
      };
    }
    default:
      return {
        kind: "standing_price_instruction",
        ...common,
        direction: "long",
        leverage: 1,
        entries: form.standing.map((entry) => ({
          quantity: text(entry.quantity),
          entryPrice: text(entry.entryPrice),
          stopLossPrice: text(entry.stopLossPrice),
          takeProfitPrice: text(entry.takeProfitPrice),
        })),
        entryExpiresAt: end,
      };
  }
}

export type BuiltRequest =
  | { status: "ready"; request: BacktestRequest; rules?: StrategyRules }
  | { status: "invalid"; message: string };

/**
 * The request the form describes, or the first problem with it, named by
 * field. DCA buys start, and grid and instruction entries expire, with the
 * period.
 */
export function buildBacktestRequest(
  form: BacktestForm,
  period: { start: string; end: string },
): BuiltRequest {
  const assumptions = {
    makerFeePercent: text(form.assumptions.makerFeePercent),
    takerFeePercent: text(form.assumptions.takerFeePercent),
    slippagePercent: text(form.assumptions.slippagePercent),
  };
  const input =
    form.choice === "recorded_proposals"
      ? {
          source: "recorded_proposals",
          fixtureId: form.fixtureId,
          assumptions,
        }
      : {
          source: "rules",
          rules: formRules(form, period),
          period,
          allocation: text(form.allocation),
          assumptions,
        };
  const parsed = backtestRequestSchema.safeParse(input);
  if (parsed.success)
    return {
      status: "ready",
      request: parsed.data,
      ...(parsed.data.source === "rules" ? { rules: parsed.data.rules } : {}),
    };
  const [issue] = parsed.error.issues;
  const name = label(issue.path);
  const message =
    issue.code === "invalid_type" && issue.path.includes("holdingPeriodSeconds")
      ? "Enter a whole number of hours."
      : issue.message;
  return {
    status: "invalid",
    message: name ? `${name}: ${message}` : message,
  };
}

/** The market at the period's start, with the exchange's steps. */
export type PeriodPrices = {
  firstOpen: string;
  tickSize: string;
  stepSize: string;
};

/** The smallest of 1, 2, 2.5 and 5 times a power of ten that is at least `value`. */
export function niceStep(value: Decimal.Value) {
  const amount = new Decimal(value);
  if (!amount.greaterThan(0)) throw new RangeError("A step must be positive.");
  const power = new Decimal(10).pow(amount.log(10).floor());
  for (const factor of ["1", "2", "2.5", "5", "10"]) {
    const step = power.times(factor);
    if (step.greaterThanOrEqualTo(amount)) return step;
  }
  return power.times(10);
}

/**
 * Prices a customer could have chosen when the period began, from its first
 * open only, so the suggestion never looks ahead into the period. The grid
 * spaces its levels about 1% apart, with three below the open, and its range
 * stop one step below. The instruction buys 1% below the open, with a stop
 * 5% below and a target 3% above, for about 100 USDT.
 */
export function suggestPrices(prices: PeriodPrices) {
  const open = new Decimal(prices.firstOpen);
  const step = niceStep(open.dividedBy(100));
  const lower = open.dividedToIntegerBy(step).times(step).minus(step.times(3));
  const entryPrice = floorToStep(open.times("0.99"), prices.tickSize);
  return {
    grid: {
      lowerPrice: lower.toFixed(),
      upperPrice: lower.plus(step.times(5)).toFixed(),
      rangeStopPrice: lower.minus(step).toFixed(),
    },
    standing: {
      quantity: quantityFor("100", entryPrice, prices.stepSize).toFixed(),
      entryPrice: entryPrice.toFixed(),
      stopLossPrice: floorToStep(open.times("0.95"), prices.tickSize).toFixed(),
      takeProfitPrice: ceilToStep(
        open.times("1.03"),
        prices.tickSize,
      ).toFixed(),
    },
  };
}
