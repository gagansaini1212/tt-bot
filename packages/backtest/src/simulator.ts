import Decimal from "decimal.js";

import {
  authorizeTradeProposal,
  ceilToStep,
  dcaBuyDueAt,
  dcaBuyIndexAt,
  entryIntentProposal,
  floorToStep,
  gridRangePosition,
  instrumentAssets,
  lossLimitStatus,
  planDcaBuy,
  planGridEntries,
  planStandingEntries,
  ruleLimits,
  unrealizedPnl,
  type EntryIntent,
  type EntryPlan,
  type ExecutionPolicy,
  type Instrument,
  type PnlBooking,
  type StrategyRules,
} from "@crypto-trading/domain";
import { protectedEntryFilterIssues } from "@crypto-trading/exchanges/order-rules";

import { HOUR_MS, type Candle } from "./candles";
import type { BacktestAssumptions, BacktestMarket } from "./market";
import type { RecordedProposal } from "./recorded-proposals";

export type BacktestInput = {
  rules: StrategyRules;
  // The market the candles are from. The rules must allow it.
  instrument: Instrument;
  // Closed hourly candles, oldest first.
  candles: readonly Candle[];
  // The strategy's allocation, in USDT, the accounting currency.
  allocation: string;
  market: BacktestMarket;
  assumptions: BacktestAssumptions;
  // An AI-managed strategy's recorded proposals, in time order.
  proposals?: readonly RecordedProposal[];
};

export type ExitReason =
  | "take_profit"
  | "stop_loss"
  | "holding_deadline"
  | "loss_limit"
  | "range_exit";

/** One protected entry that filled, with its exit if it closed. */
export type BacktestTrade = {
  key: string;
  entryAt: string;
  entryPrice: string;
  quantity: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  exit?: { at: string; price: string; reason: ExitReason };
  // Entry and exit fees.
  fees: string;
  // Net of fees. An open trade is valued at the last close, without an exit fee.
  pnl: string;
};

export type EquityPoint = {
  // Milliseconds since the epoch: the first candle's open, then each close.
  time: number;
  equity: string;
};

export type StrategyState = "running" | "paused" | "completed";

export type BacktestNotice = { at: string; message: string };

export type SimulationResult = {
  trades: BacktestTrade[];
  equity: EquityPoint[];
  state: StrategyState;
  notices: BacktestNotice[];
  // Entries the execution checks or the exchange's filters turned away, by code.
  rejections: Record<string, number>;
  fees: string;
  realizedPnl: string;
  unrealizedPnl: string;
  finalEquity: string;
  // The most protected entries held at once: the rules' limit or the
  // exchange's stop-order limit, whichever is lower.
  entryLimit: number;
};

type SimEntry = {
  intent: EntryIntent;
  status: "pending" | "open" | "closed" | "cancelled";
  fillPrice?: Decimal;
  filledAt?: number;
  entryFee?: Decimal;
  deadline?: number;
  // Filled after its candle opened, so that candle may have reached its take
  // profit before the fill: it takes profit from the next candle on.
  filledMidCandle?: boolean;
  exit?: { at: number; price: Decimal; fee: Decimal; reason: ExitReason };
};

// Stand-ins for the identifiers a live proposal carries. The checks compare
// them with the policy, which uses the same ones.
const SCOPE = {
  customerId: "00000000-0000-4000-8000-00000000b001",
  exchangeAccountId: "00000000-0000-4000-8000-00000000b002",
  strategyId: "00000000-0000-4000-8000-00000000b003",
  strategyVersion: 1,
  sourceSnapshotId: "00000000-0000-4000-8000-00000000b004",
} as const;

const iso = (time: number) => new Date(time).toISOString();

/** "level:3" → "grid level 4", for notices. */
export function entryLabel(key: string) {
  const [kind, index] = key.split(":");
  const number = Number(index) + 1;
  switch (kind) {
    case "level":
      return `grid level ${number}`;
    case "buy":
      return `DCA buy ${number}`;
    case "entry":
      return `entry ${number}`;
    case "proposal":
      return `proposal ${number}`;
    default:
      return key;
  }
}

/**
 * Replays a strategy's rules over hourly candles on a virtual clock. At each
 * candle's open it enforces holding deadlines and loss limits, then asks the
 * strategy's planner for entries and passes each through the exchange's
 * filters and `authorizeTradeProposal`, as the worker does live. During the
 * candle it fills orders the price traded through, taking the worst order the
 * candle allows. Deterministic: the same input always gives the same result.
 */
export function simulate(input: BacktestInput): SimulationResult {
  const { rules, instrument, candles, market, assumptions } = input;
  if (candles.length === 0) throw new RangeError("A backtest needs candles.");
  const limits = ruleLimits(rules);
  if (rules.marketKind !== "spot" || limits.marketKind !== "spot")
    throw new RangeError("Backtests cover spot strategies only.");
  if (!limits.allowedInstruments.includes(instrument))
    throw new RangeError(`The rules do not trade ${instrument}.`);
  if (input.proposals?.some((proposal) => proposal.instrument !== instrument))
    throw new RangeError(
      `Recorded proposals must all be for ${instrument}, the backtested market.`,
    );

  const maker = new Decimal(assumptions.makerFeePercent).dividedBy(100);
  const taker = new Decimal(assumptions.takerFeePercent).dividedBy(100);
  const slippage = new Decimal(assumptions.slippagePercent).dividedBy(100);
  const tick = market.rules.tickSize;
  const steps = { tickSize: tick, quantityStep: market.rules.stepSize };
  const entryLimit = Math.min(limits.maxProtectedEntries, market.maxStopOrders);
  // The backtest replays history, so today's trading status does not apply.
  const filterRules = {
    ...market.rules,
    trading: true,
    protectedEntryAllowed: true,
  };

  /** What a taker buy pays: the price plus slippage, up to the tick. */
  const takerBuyPrice = (price: Decimal.Value) =>
    ceilToStep(new Decimal(price).times(new Decimal(1).plus(slippage)), tick);
  /** What a taker sell receives: the price less slippage, down to the tick. */
  const takerSellPrice = (price: Decimal.Value) =>
    floorToStep(new Decimal(price).times(new Decimal(1).minus(slippage)), tick);

  let cash = new Decimal(input.allocation);
  let fees = new Decimal(0);
  let realized = new Decimal(0);
  const bookings: PnlBooking[] = [];
  const entries: SimEntry[] = [];
  const notices: BacktestNotice[] = [];
  const rejections: Record<string, number> = {};
  const equity: EquityPoint[] = [
    { time: candles[0].openTime, equity: cash.toFixed() },
  ];
  let state: StrategyState = "running";
  // Set once the rules will open no more entries. The strategy completes when
  // it then holds none.
  let noMoreEntries: string | undefined;
  let dayStartUnrealized = new Decimal(0);
  // DCA bookkeeping: the latest buy submitted, and why each due buy waited.
  let previousBuy: { index: number; entryPrice: string } | undefined;
  const dcaWaits = new Map<number, string>();
  let nextProposal = 0;

  const active = () =>
    entries.filter(
      (entry) => entry.status === "pending" || entry.status === "open",
    );
  const open = () => entries.filter((entry) => entry.status === "open");
  const notify = (at: number, message: string) =>
    notices.push({ at: iso(at), message });

  function fill(
    entry: SimEntry,
    price: Decimal,
    at: number,
    fee: Decimal,
    midCandle: boolean,
  ) {
    const notional = price.times(entry.intent.quantity);
    const paid = notional.times(fee);
    cash = cash.minus(notional).minus(paid);
    fees = fees.plus(paid);
    bookings.push({ at: iso(at), kind: "fee", amount: paid.toFixed() });
    // A fill during a candle came at some time before its close. The holding
    // period starts from the close, so the entry never closes early.
    const firstFill = midCandle ? at + HOUR_MS : at;
    Object.assign(entry, {
      status: "open",
      fillPrice: price,
      filledAt: at,
      entryFee: paid,
      deadline: firstFill + entry.intent.holdingPeriodSeconds * 1000,
      filledMidCandle: midCandle,
    });
  }

  function close(
    entry: SimEntry,
    price: Decimal,
    at: number,
    fee: Decimal,
    reason: ExitReason,
  ) {
    const quantity = new Decimal(entry.intent.quantity);
    const proceeds = price.times(quantity);
    const paid = proceeds.times(fee);
    const result = price.minus(entry.fillPrice!).times(quantity);
    cash = cash.plus(proceeds).minus(paid);
    fees = fees.plus(paid);
    realized = realized.plus(result);
    bookings.push(
      { at: iso(at), kind: "realized", amount: result.toFixed() },
      { at: iso(at), kind: "fee", amount: paid.toFixed() },
    );
    entry.status = "closed";
    entry.exit = { at, price, fee: paid, reason };
  }

  /** Cancels pending entries and sells open ones at a taker price. */
  function closeEntries(price: Decimal.Value, at: number, reason: ExitReason) {
    for (const entry of active()) {
      if (entry.status === "pending") entry.status = "cancelled";
      else close(entry, takerSellPrice(price), at, taker, reason);
    }
  }

  function policy(): ExecutionPolicy {
    const held = active();
    const notional = (entry: SimEntry) =>
      (entry.fillPrice ?? new Decimal(entry.intent.entryPrice)).times(
        entry.intent.quantity,
      );
    const sum = (list: SimEntry[]) =>
      list.reduce(
        (total, entry) => total.plus(notional(entry)),
        new Decimal(0),
      );
    return {
      ...SCOPE,
      // The replayed account trades and accounts in the market's quote.
      accountAccess: "trade",
      accountingCurrency: instrumentAssets(instrument).quote,
      tradingMode: "simulation",
      strategyStatus: "simulation",
      liveTradingEnabled: false,
      allowedInstruments: limits.allowedInstruments,
      allocation: input.allocation,
      committedCapital: sum(
        held.filter((entry) => entry.status === "open"),
      ).toFixed(),
      reservedBudget: sum(
        held.filter((entry) => entry.status === "pending"),
      ).toFixed(),
      maxPositionNotional: limits.maxPositionNotional,
      maxLeverage: limits.maxLeverage,
      marketKind: limits.marketKind,
      allowedDirections: limits.allowedDirections,
      maxProtectedEntries: entryLimit,
      protectedEntries: held.length,
      positionNotionalByInstrument: { [instrument]: sum(held).toFixed() },
    };
  }

  // Planners offer a turned-away entry again at every open, so each entry
  // counts once per reason.
  const turnedAway = new Set<string>();
  function reject(key: string, code: string, at: number, reason: string) {
    // A DCA buy is retried while it is due, so it is reported once skipped.
    if (rules.kind === "dca") dcaWaits.set(Number(key.split(":")[1]), code);
    if (turnedAway.has(`${key} ${code}`)) return;
    turnedAway.add(`${key} ${code}`);
    rejections[code] = (rejections[code] ?? 0) + 1;
    if (rules.kind !== "dca")
      notify(at, `${capitalize(entryLabel(key))} was turned away: ${reason}`);
  }

  /** Submits an entry through the execution checks, then the exchange's filters. */
  function submit(intent: EntryIntent, candle: Candle) {
    const now = candle.openTime;
    const result = authorizeTradeProposal(
      entryIntentProposal(intent, {
        ...SCOPE,
        proposalId: SCOPE.sourceSnapshotId,
        rationale: `Backtest ${intent.key}`,
      }),
      policy(),
      new Date(now),
    );
    if (!result.allowed)
      return reject(intent.key, result.code, now, result.reason);
    const [issue] = protectedEntryFilterIssues(
      {
        quantity: intent.quantity,
        price: intent.entryPrice,
        stopLossPrice: intent.stopLossPrice,
        takeProfitPrice: intent.takeProfitPrice,
      },
      filterRules,
    );
    if (issue) return reject(intent.key, "exchange_filter", now, issue);

    const entry: SimEntry = { intent, status: "pending" };
    entries.push(entry);
    if (rules.kind === "dca")
      previousBuy = {
        index: Number(intent.key.split(":")[1]),
        entryPrice: intent.entryPrice,
      };
    // A buy at or above the ask takes from the book at once, at the ask.
    const ask = takerBuyPrice(candle.open);
    if (new Decimal(intent.entryPrice).greaterThanOrEqualTo(ask))
      fill(entry, ask, now, taker, false);
  }

  function plan(candle: Candle): EntryPlan {
    const now = new Date(candle.openTime);
    const held = active();
    switch (rules.kind) {
      case "grid":
        return planGridEntries(rules, {
          now,
          price: candle.open,
          steps,
          occupiedLevels: held.map((entry) =>
            Number(entry.intent.key.split(":")[1]),
          ),
          maxProtectedEntries: entryLimit,
        });
      case "dca":
        return planDcaBuy(rules, {
          now,
          price: takerBuyPrice(candle.open).toFixed(),
          steps,
          previousBuy,
          protectedEntries: held.length,
          maxProtectedEntries: entryLimit,
        });
      case "standing_price_instruction":
        return planStandingEntries(rules, {
          now,
          entries: entries.map((entry) => ({
            index: Number(entry.intent.key.split(":")[1]),
            filledQuantity: entry.fillPrice ? entry.intent.quantity : "0",
            closed: entry.status === "closed" || entry.status === "cancelled",
          })),
          maxProtectedEntries: entryLimit,
        });
      case "ai_managed": {
        const proposals = input.proposals ?? [];
        const intents: EntryIntent[] = [];
        while (
          nextProposal < proposals.length &&
          Date.parse(proposals[nextProposal].at) <= candle.openTime
        ) {
          intents.push(proposalIntent(proposals[nextProposal], nextProposal));
          nextProposal++;
        }
        return intents.length
          ? { action: "enter", intents }
          : { action: "wait", reason: "entries_pending" };
      }
    }
  }

  function proposalIntent(
    proposal: RecordedProposal,
    index: number,
  ): EntryIntent {
    return {
      key: `proposal:${index}`,
      instrument: proposal.instrument,
      marketKind: proposal.marketKind,
      direction: proposal.direction,
      leverage: proposal.leverage,
      quantity: proposal.quantity,
      entryPrice: proposal.entryPrice,
      stopLossPrice: proposal.stopLossPrice,
      takeProfitPrice: proposal.takeProfitPrice,
      entryExpiresAt: proposal.entryExpiresAt,
      holdingPeriodSeconds:
        rules.kind === "ai_managed" ? rules.holdingPeriodSeconds : 0,
    };
  }

  /** Open entries valued at `markPrice`, for the loss limits. */
  const marks = (markPrice: string) =>
    open().map((entry) => ({
      direction: "long" as const,
      quantity: entry.intent.quantity,
      entryPrice: entry.fillPrice!.toFixed(),
      markPrice,
    }));

  /**
   * Measures the loss limits at `measuredAt`, with open entries at `price`.
   * Reaching either cancels pending entries, sells open ones at `price` less
   * slippage, and pauses the strategy, which a backtest never resumes.
   */
  function enforceLossLimits(measuredAt: number, at: number, price: string) {
    if (state !== "running") return;
    const status = lossLimitStatus({
      now: new Date(measuredAt),
      limits: rules.lossLimits,
      bookings,
      openEntries: marks(price),
      dayStartUnrealizedPnl: dayStartUnrealized.toFixed(),
    });
    if (!status.breached) return;
    const which = status.total.reached ? "total" : "daily";
    const measure = status[which];
    closeEntries(price, at, "loss_limit");
    state = "paused";
    notify(
      at,
      `The ${which} loss limit of ${measure.limit} USDT was reached with a loss of ${new Decimal(measure.loss).toFixed(2)} USDT. Pending entries were cancelled, open entries closed, and the strategy paused. A backtest does not resume it.`,
    );
  }

  function complete(at: number, reason: string) {
    state = "completed";
    notify(at, `The strategy completed: ${reason}.`);
  }

  for (const candle of candles) {
    const now = candle.openTime;
    const openPrice = new Decimal(candle.open);

    // At the open: the day's starting point for the daily loss limit, expired
    // entries, holding deadlines, loss limits, then new entries.
    if (now % (24 * HOUR_MS) === 0)
      dayStartUnrealized = marks(candle.open).reduce(
        (total, entry) => total.plus(unrealizedPnl(entry)),
        new Decimal(0),
      );
    for (const entry of active())
      if (
        entry.status === "pending" &&
        Date.parse(entry.intent.entryExpiresAt) <= now
      )
        entry.status = "cancelled";
    for (const entry of open())
      if (entry.deadline! <= now)
        close(entry, takerSellPrice(openPrice), now, taker, "holding_deadline");

    enforceLossLimits(now, now, candle.open);

    if (state === "running") {
      const next = plan(candle);
      if (next.action === "enter")
        for (const intent of next.intents) submit(intent, candle);
      else if (next.action === "close_and_complete") {
        closeEntries(openPrice, now, "range_exit");
        complete(
          now,
          next.reason === "range_stop"
            ? "the price opened at or below the range stop"
            : "the price opened above the grid range",
        );
      } else if (next.action === "no_more_entries") {
        noMoreEntries ??= next.reason;
      } else if (
        rules.kind === "dca" &&
        (next.reason === "entry_limit" || next.reason === "unprotectable")
      )
        dcaWaits.set(dcaBuyIndexAt(rules, new Date(now)), next.reason);
    } else if (rules.kind === "dca") {
      const index = dcaBuyIndexAt(rules, new Date(now));
      if (!dcaWaits.has(index)) dcaWaits.set(index, state);
    }

    // During the candle, in the worst order it allows: resting entries fill
    // when the price trades through them, then stops before take profits.
    const low = new Decimal(candle.low);
    const high = new Decimal(candle.high);
    for (const entry of entries)
      if (
        entry.status === "pending" &&
        Date.parse(entry.intent.entryExpiresAt) >= now + HOUR_MS &&
        low.lessThan(entry.intent.entryPrice)
      )
        fill(entry, new Decimal(entry.intent.entryPrice), now, maker, true);
    for (const entry of open()) {
      const stop = new Decimal(entry.intent.stopLossPrice);
      if (low.lessThanOrEqualTo(stop)) {
        // A stop the market opened through sells from the open.
        const trigger =
          !entry.filledMidCandle && openPrice.lessThanOrEqualTo(stop)
            ? openPrice
            : stop;
        close(entry, takerSellPrice(trigger), now, taker, "stop_loss");
      } else if (
        !entry.filledMidCandle &&
        high.greaterThan(entry.intent.takeProfitPrice)
      )
        close(
          entry,
          new Decimal(entry.intent.takeProfitPrice),
          now,
          maker,
          "take_profit",
        );
      entry.filledMidCandle = false;
    }

    // A grid that the price left during the candle closes what remains at
    // the close, then completes.
    if (rules.kind === "grid" && state === "running") {
      const below = gridRangePosition(rules, candle.low) === "range_stop";
      const above = gridRangePosition(rules, candle.high) === "above_range";
      if (below || above) {
        closeEntries(candle.close, now, "range_exit");
        complete(
          now,
          below
            ? "the price reached the range stop"
            : "the price rose above the grid range",
        );
      }
    }
    // Measured again at the close, within the candle's UTC day, so a loss in
    // the day's last hour still counts against that day's limit.
    enforceLossLimits(now + HOUR_MS - 1, now, candle.close);
    if (state === "running" && noMoreEntries && active().length === 0)
      complete(now, completionReason(noMoreEntries));

    // Equity at the close: cash plus open entries at the closing price.
    equity.push({
      time: now + HOUR_MS,
      equity: open()
        .reduce(
          (total, entry) =>
            total.plus(new Decimal(entry.intent.quantity).times(candle.close)),
          cash,
        )
        .toFixed(),
    });
  }

  const last = candles[candles.length - 1];
  const periodEnd = last.openTime + HOUR_MS;
  if (rules.kind === "dca") reportDcaSkips(periodEnd);
  const unsent = (input.proposals ?? []).filter(
    (proposal, index) =>
      index >= nextProposal && Date.parse(proposal.at) < periodEnd,
  ).length;
  if (unsent > 0)
    notify(
      periodEnd,
      `${unsent} recorded ${unsent === 1 ? "proposal was" : "proposals were"} not submitted: ${state === "running" ? "the period ended first" : `the strategy was ${state}`}.`,
    );

  const trades = entries
    .filter((entry) => entry.fillPrice)
    .sort((a, b) => a.filledAt! - b.filledAt!)
    .map((entry) => trade(entry, last.close));
  const unrealized = open().reduce(
    (total, entry) =>
      total.plus(
        new Decimal(last.close)
          .minus(entry.fillPrice!)
          .times(entry.intent.quantity),
      ),
    new Decimal(0),
  );
  return {
    trades,
    equity,
    state,
    notices,
    rejections,
    fees: fees.toFixed(),
    realizedPnl: realized.toFixed(),
    unrealizedPnl: unrealized.toFixed(),
    finalEquity: equity[equity.length - 1].equity,
    entryLimit,
  };

  /** Reports the DCA buys whose due window ended without a buy. */
  function reportDcaSkips(periodEnd: number) {
    if (rules.kind !== "dca") return;
    const made = new Set(
      entries.map((entry) => Number(entry.intent.key.split(":")[1])),
    );
    const skipped = new Map<string, number>();
    // Only buys whose due window ended within the period: a later one may
    // still be made.
    for (let index = 0; index < rules.maxBuys; index++) {
      const ends = dcaBuyDueAt(rules, index + 1).getTime();
      if (ends > periodEnd) break;
      if (ends <= candles[0].openTime || made.has(index)) continue;
      const reason = dcaWaits.get(index) ?? "not_due";
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of skipped)
      notify(
        periodEnd,
        `${count} DCA ${count === 1 ? "buy was" : "buys were"} skipped: ${SKIP_REASONS[reason] ?? reason}.`,
      );
  }

  function trade(entry: SimEntry, lastClose: string): BacktestTrade {
    const quantity = new Decimal(entry.intent.quantity);
    const exitPrice = entry.exit?.price ?? new Decimal(lastClose);
    const paid = entry.entryFee!.plus(entry.exit?.fee ?? 0);
    return {
      key: entry.intent.key,
      entryAt: iso(entry.filledAt!),
      entryPrice: entry.fillPrice!.toFixed(),
      quantity: quantity.toFixed(),
      stopLossPrice: entry.intent.stopLossPrice,
      takeProfitPrice: entry.intent.takeProfitPrice,
      ...(entry.exit
        ? {
            exit: {
              at: iso(entry.exit.at),
              price: entry.exit.price.toFixed(),
              reason: entry.exit.reason,
            },
          }
        : {}),
      fees: paid.toFixed(),
      pnl: exitPrice
        .minus(entry.fillPrice!)
        .times(quantity)
        .minus(paid)
        .toFixed(),
    };
  }
}

const SKIP_REASONS: Record<string, string> = {
  entry_limit: "the strategy held as many entries as it may",
  unprotectable:
    "the buy was too small for one quantity step, or its stop or target rounded to the entry price",
  paused: "the strategy was paused",
  completed: "the strategy had completed",
  exchange_filter: "the buy failed the exchange's filters",
  allocation_exceeded: "the allocation was fully committed",
  position_limit_exceeded: "the position limit was reached",
  entry_limit_exceeded: "the strategy held as many entries as it may",
  not_due: "no candle opened while the buy was due",
};

function completionReason(reason: string) {
  switch (reason) {
    case "schedule_complete":
      return "the DCA schedule ended and every buy has closed";
    case "expired":
      return "its entries expired and every entry has closed";
    case "all_entries_filled":
      return "every entry filled and has closed";
    default:
      return reason;
  }
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
