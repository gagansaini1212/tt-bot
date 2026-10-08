import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { Database } from "@crypto-trading/database";
import {
  dcaBuyIndexAt,
  planDcaBuy,
  planGridEntries,
  planStandingEntries,
  utcDayStart,
  type AiManagedRules,
  type EntryIntent,
  type EntryPlan,
  type LossLimitStatus,
} from "@crypto-trading/domain";
import {
  BinanceTestnetError,
  protectedEntryFilterIssues,
  protectedLeg,
  STOP_REASON_LABELS,
  testnetInstrumentSchema,
  type AiSource,
  type ManualOrderOutcome,
  type StrategiesState,
  type StrategyMarket,
  type StrategyMeasure,
  type StrategyView,
  type SymbolRules,
  type TestnetInstrument,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import {
  contentId,
  RECORDED_FIXTURE_MODEL,
  type DecisionSource,
} from "./ai-decisions";
import {
  ProtectedEntrySender,
  serializer,
  type Serializer,
} from "./manual-orders";
import type { OrderIntentStore } from "./order-intents";
import { PassReads, type ExecutionExchange } from "./pass-reads";
import {
  dayStartInstruments,
  measureLossLimits,
  strategyPnl,
  UnmeasurableError,
  type MeasuredEntry,
  type MeasuredFill,
  type StrategyPnl,
} from "./strategy-pnl";
import {
  ENDED_LABELS,
  isRunning,
  isUnclosed,
  StrategyStore,
  type EntryCandidate,
  type StrategyEntry,
  type StrategyRecord,
} from "./strategy-store";
import {
  strategyEntryClientOrderId,
  type TradeProposalStore,
} from "./trade-proposals";

/**
 * Binance's MAX_NUM_ALGO_ORDERS was 5 for BTCUSDT on the testnet on
 * 2026-10-08 (ADR 0004). Used only if exchangeInfo stops reporting it.
 */
export const DEFAULT_MAX_STOP_ORDERS = 5;
// Binance's order types that count against MAX_NUM_ALGO_ORDERS.
const STOP_TYPES = new Set([
  "STOP_LOSS",
  "STOP_LOSS_LIMIT",
  "TAKE_PROFIT",
  "TAKE_PROFIT_LIMIT",
]);
const RULES_TTL_MS = 5 * 60_000;
const HOUR_MS = 60 * 60 * 1000;

/** A strategy's results, measured, or why they could not be. */
type Measured =
  | {
      status: "measured";
      pnl: StrategyPnl;
      limits: LossLimitStatus;
      committed: string;
      reserved: string;
    }
  | { status: "unmeasured"; reason: string };

type Submission =
  | { status: "sent"; outcome: ManualOrderOutcome }
  | { status: "skipped"; reason: string; checksRefused?: boolean };

/** What one pass, or one request, has read and decided so far. */
class PassContext {
  readonly reads: PassReads;
  readonly sender: ProtectedEntrySender;
  readonly now: Date;

  constructor(reads: PassReads, sender: ProtectedEntrySender, now: Date) {
    this.reads = reads;
    this.sender = sender;
    this.now = now;
  }
}

/**
 * Runs every strategy on the worker's execution loop (ADR 0004). On each
 * pass, for each customer, it:
 *
 * 1. measures every strategy's daily and total loss limits with the
 *    domain's `lossLimitStatus`. A strategy that reached one is paused, its
 *    pending entries cancelled and its open entries sold, with a critical
 *    notification. A strategy that cannot be measured opens nothing;
 * 2. measures the portfolio's daily drawdown, every strategy's result since
 *    midnight UTC against their allocations together, and pauses every
 *    strategy when it reaches the customer's limit;
 * 3. stops entries sent since a pause or close all was requested, and
 *    cancels entries past their entry expiry;
 * 4. plans each running strategy's next protected entries with the domain's
 *    planners, or asks the AI on an AI-managed strategy's schedule, and
 *    submits each: Binance's filters and test order, then
 *    `authorizeTradeProposal` with the strategy's version, allocation,
 *    reserved budget and limits, reserving its budget in the same
 *    transaction that saves its order intent, then the OPOCO order list,
 *    exactly as a dashboard order is sent. An entry Binance could not
 *    protect, because its stop-order limit for the symbol is full, waits;
 * 5. completes a strategy whose rules open no more entries once it holds
 *    nothing.
 *
 * Everything it decides is in PostgreSQL, so a restarted worker carries on,
 * and two workers cannot make the same entry: the reservation locks the
 * strategy's row, and each entry key is made once.
 */
export class StrategyRunner {
  readonly store: StrategyStore;
  readonly #proposals: Pick<
    TradeProposalStore,
    "record" | "find" | "reject" | "expire"
  >;
  readonly #intents: Pick<OrderIntentStore, "settle" | "recordOrders">;
  readonly #decisions: DecisionSource;
  readonly #now: () => Date;
  readonly #onChange: () => void;
  readonly #log: (message: string) => void;
  readonly #exclusive: Serializer;
  readonly #dayStartPrices = new Map<string, Promise<string>>();
  #rules?: { fetchedAt: number; value: Promise<SymbolRules[]> };
  #lastLogged?: string;

  constructor(options: {
    database: Database;
    proposals: Pick<
      TradeProposalStore,
      "record" | "find" | "reject" | "expire"
    >;
    intents: Pick<OrderIntentStore, "settle" | "recordOrders">;
    decisions: DecisionSource;
    now?: () => Date;
    onChange?: () => void;
    log?: (message: string) => void;
    // Shared with the dashboard's order desks, so placements on an account
    // run one at a time.
    exclusive?: Serializer;
  }) {
    this.store = new StrategyStore(options.database);
    this.#proposals = options.proposals;
    this.#intents = options.intents;
    this.#decisions = options.decisions;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => {});
    this.#log = options.log ?? ((message) => console.error(message));
    this.#exclusive = options.exclusive ?? serializer();
  }

  get aiSource(): AiSource {
    return this.#decisions.source;
  }

  #context(exchange: ExecutionExchange, reads = new PassReads(exchange)) {
    return new PassContext(
      reads,
      new ProtectedEntrySender({
        exchange,
        intents: this.#intents,
        onChange: this.#onChange,
      }),
      this.#now(),
    );
  }

  /** One pass over the account's strategies. The execution loop calls it. */
  async run(scope: AccountScope, reads: PassReads) {
    const context = this.#context(reads.exchange, reads);
    const today = todays(await this.store.list(scope), context.now);
    if (!today.length) return;
    const strategies = today.filter(
      (strategy) => strategy.status !== "retired",
    );
    const entries = await this.store.entries(
      scope,
      today.map((strategy) => strategy.id),
    );
    const notes = new Map<string, string>();
    // Whatever their losses, entries sent since a pause or close all are
    // stopped, entries past their expiry are cancelled, and a strategy
    // whose rules ended completes once it holds nothing.
    for (const strategy of strategies) {
      const note = await this.#upkeep(
        scope,
        context,
        strategy,
        entries.get(strategy.id) ?? [],
      );
      if (note) notes.set(strategy.id, note);
    }
    const measured = await this.#measureAll(scope, context, today, entries);
    let stopped = false;
    for (const strategy of strategies) {
      if (notes.get(strategy.id)?.startsWith("Completed")) continue;
      const result = measured.get(strategy.id)!;
      if (result.status === "unmeasured") {
        if (isRunning(strategy.status))
          notes.set(
            strategy.id,
            `Opens no entries: the worker cannot measure its losses. ${result.reason}`,
          );
        continue;
      }
      if (result.limits.breached) {
        const which = result.limits.total.reached ? "total" : "daily";
        const measure = result.limits[which];
        if (
          await this.store.lossLimitReached(scope, strategy.id, {
            limit: which,
            loss: measure.loss,
            amount: measure.limit,
          })
        ) {
          stopped = true;
          this.#onChange();
        }
        notes.set(
          strategy.id,
          `Its ${which} loss limit is reached: ${measure.loss} of ${measure.limit} USDT lost${which === "daily" ? " since midnight UTC" : ""}.`,
        );
        continue;
      }
    }
    if (!stopped) {
      const portfolio = await this.#portfolio(scope, today, measured);
      if (portfolio.blocked) {
        for (const strategy of strategies)
          if (isRunning(strategy.status) && !notes.has(strategy.id))
            notes.set(strategy.id, portfolio.blocked);
      } else
        for (const strategy of strategies) {
          const result = measured.get(strategy.id)!;
          if (
            !isRunning(strategy.status) ||
            notes.has(strategy.id) ||
            result.status !== "measured" ||
            // Upkeep may have just completed or stopped it.
            strategy.rulesEndedAt
          )
            continue;
          try {
            notes.set(
              strategy.id,
              await this.#step(
                scope,
                context,
                strategy,
                entries.get(strategy.id) ?? [],
                result,
              ),
            );
          } catch (error) {
            this.#warn(
              `Could not run strategy ${strategy.id}: ${describe(error)}`,
            );
            notes.set(
              strategy.id,
              `The worker could not run it on its last pass: ${describe(error)}`,
            );
          }
        }
    }
    for (const strategy of strategies) {
      const note =
        notes.get(strategy.id) ??
        (strategy.status === "paused"
          ? `Paused: ${STOP_REASON_LABELS[strategy.pauseReason ?? ""] ?? "paused"}. ${
              strategy.exitRequest && strategy.exitRequest !== "pause"
                ? "Its entries are being closed."
                : "Open entries keep their exits."
            }`
          : "");
      if (note) await this.store.note(scope, strategy.id, note);
    }
  }

  /**
   * What every strategy that has not completed needs on each pass, whether
   * or not it can be measured: its reservations settled, its exit request
   * applied to entries sent since it was made, unfilled entries past their
   * entry expiry cancelled, and completion once its rules ended and it
   * holds nothing. Resolves a note when its rules have ended.
   */
  async #upkeep(
    scope: AccountScope,
    context: PassContext,
    strategy: StrategyRecord,
    entries: StrategyEntry[],
  ): Promise<string | undefined> {
    await this.store.settleReservations(scope, strategy.id);
    if (strategy.exitRequest)
      await this.store.applyExitRequest(
        scope,
        strategy.id,
        strategy.exitRequest,
      );
    const unclosed = entries.filter(isUnclosed);
    const expired = unclosed.filter(
      (entry) =>
        entry.orderIntentId !== null &&
        entry.intentStatus === "acknowledged" &&
        entry.exitReason === null &&
        entry.entryExpiresAt.getTime() <= context.now.getTime() &&
        new Decimal(entry.filled).lt(entry.quantity),
    );
    if (
      await this.store.expire(
        scope,
        expired.map((entry) => entry.orderIntentId!),
      )
    )
      this.#onChange();
    if (!strategy.rulesEndedAt) return undefined;
    if (await this.store.complete(scope, strategy.id)) {
      await this.store.settleReservations(scope, strategy.id);
      this.#onChange();
      return "Completed: its rules open no more entries and it holds nothing.";
    }
    const reason =
      ENDED_LABELS[strategy.rulesEndedReason ?? ""] ?? "its rules ended";
    return `Opens no more entries (${reason}). Waiting for ${plural(unclosed.length, "entry", "entries")} to finish.`;
  }

  /**
   * The portfolio's daily drawdown. Pauses every strategy when it reaches
   * the limit. Resolves why no strategy may open entries now, if one is.
   */
  async #portfolio(
    scope: AccountScope,
    strategies: StrategyRecord[],
    measured: Map<string, Measured>,
  ): Promise<{ blocked?: string }> {
    const limit = (await this.store.portfolioLimits(scope)).current;
    if (!limit)
      return {
        blocked:
          "Opens no entries until you set the portfolio's daily drawdown limit in Settings → Risk limits.",
      };
    const today = portfolioToday(
      strategies,
      measured,
      limit.maxDailyDrawdownPercent,
    );
    if (!today)
      return {
        blocked:
          "Opens no entries: the worker cannot measure every strategy, so it cannot measure the portfolio's drawdown.",
      };
    if (!today.reached) return {};
    if (
      await this.store.drawdownReached(scope, {
        drawdownPercent: today.drawdownPercent,
        limitPercent: limit.maxDailyDrawdownPercent,
        pnl: today.pnl,
      })
    )
      this.#onChange();
    return {
      blocked: `The portfolio has lost ${today.drawdownPercent}% since midnight UTC, reaching its ${limit.maxDailyDrawdownPercent}% daily drawdown limit.`,
    };
  }

  /** One running strategy's turn. Resolves its note. */
  async #step(
    scope: AccountScope,
    context: PassContext,
    strategy: StrategyRecord,
    entries: StrategyEntry[],
    measured: Extract<Measured, { status: "measured" }>,
  ): Promise<string> {
    const { now } = context;
    const unclosed = entries.filter(isUnclosed);
    const { rules } = strategy;
    if (rules.kind === "ai_managed")
      return this.#analyse(scope, context, strategy, rules, unclosed, measured);
    const instrument = rules.instrument as TestnetInstrument;
    const symbol = await this.#symbolRules(instrument, context.reads.exchange);
    const steps = { tickSize: symbol.tickSize, quantityStep: symbol.stepSize };
    const free = await this.#freeStopOrders(scope, context, instrument, symbol);
    const limit = (rulesLimit: number) =>
      Math.min(rulesLimit, unclosed.length + Math.max(free, 0));
    let plan: EntryPlan;
    let once = false;
    switch (rules.kind) {
      case "grid":
        plan = planGridEntries(rules, {
          now,
          price: await context.reads.lastPrice(instrument),
          steps,
          occupiedLevels: unclosed.flatMap((entry) =>
            entry.key?.startsWith("level:") ? [Number(entry.key.slice(6))] : [],
          ),
          maxProtectedEntries: limit(rules.levelCount - 1),
        });
        break;
      case "dca": {
        const ask = await context.reads.bestAsk(instrument);
        if (!ask) return "Waiting: Binance's order book has no ask.";
        const latest = entries
          .filter(
            (entry) =>
              entry.key?.startsWith("buy:") && entry.orderIntentId !== null,
          )
          .at(-1);
        plan = planDcaBuy(rules, {
          now,
          price: ask,
          steps,
          previousBuy: latest && {
            index: dcaBuyIndexAt(rules, latest.createdAt),
            entryPrice: latest.entryPrice,
          },
          protectedEntries: unclosed.length,
          maxProtectedEntries: limit(rules.maxBuys),
        });
        once = true;
        break;
      }
      case "standing_price_instruction":
        plan = planStandingEntries(rules, {
          now,
          entries: entries
            .filter(
              (entry) =>
                entry.version === strategy.version &&
                entry.key?.startsWith("entry:") &&
                entry.orderIntentId !== null,
            )
            .map((entry) => ({
              index: Number(entry.key!.slice(6)),
              filledQuantity: entry.filled,
              closed: !isUnclosed(entry),
            })),
          maxProtectedEntries: limit(rules.entries.length),
        });
        break;
    }
    switch (plan.action) {
      case "no_more_entries":
        await this.store.endRules(scope, strategy.id, plan.reason);
        return `Opens no more entries (${ENDED_LABELS[plan.reason]}).`;
      case "close_and_complete":
        await this.store.endRules(scope, strategy.id, plan.reason, plan.reason);
        this.#onChange();
        return `Closing: ${ENDED_LABELS[plan.reason]}. Pending entries are cancelled and open entries sold.`;
      case "wait":
        return waitNote(plan, instrument, free, symbol);
      case "enter": {
        const sent: string[] = [];
        const skipped: string[] = [];
        for (const intent of plan.intents) {
          const result = await this.#submit(scope, context, {
            strategyId: strategy.id,
            key: intent.key,
            once,
            intent,
            proposalId: randomUUID(),
            rationale: entryRationale(intent),
            // The plan's input: the rules' intent at this time.
            sourceSnapshotId: contentId({ intent, at: now.toISOString() }),
          });
          if (result.status === "sent") sent.push(describeKey(intent.key));
          else skipped.push(`${describeKey(intent.key)}: ${result.reason}`);
        }
        return [
          sent.length ? `Placed ${sent.join(", ")}.` : "",
          skipped.length ? `Skipped ${skipped.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      }
    }
  }

  /**
   * Asks the AI on the strategy's schedule. A proposal waits for the
   * customer, or, if they chose so, is submitted at once within the
   * strategy's limits. Resolves the strategy's note.
   */
  async #analyse(
    scope: AccountScope,
    context: PassContext,
    strategy: StrategyRecord,
    rules: AiManagedRules,
    unclosed: StrategyEntry[],
    measured: Extract<Measured, { status: "measured" }>,
  ): Promise<string> {
    const { now } = context;
    const ai = strategy.ai!;
    const next = strategy.nextAnalysisAt;
    // The last analysis's note stays until the next one.
    if (next && next.getTime() > now.getTime())
      return strategy.runnerNote || `Next analysis at ${utc(next)}.`;
    if (
      !(await this.store.claimAnalysis(
        scope,
        strategy.id,
        now,
        ai.analysisIntervalMinutes,
      ))
    )
      return strategy.runnerNote;
    const markets = [];
    for (const instrument of rules.allowedInstruments) {
      const parsed = testnetInstrumentSchema.safeParse(instrument);
      if (!parsed.success) continue;
      const symbol = await this.#symbolRules(
        parsed.data,
        context.reads.exchange,
      );
      markets.push({
        instrument: parsed.data,
        lastPrice: await context.reads.lastPrice(parsed.data),
        bestAsk: (await context.reads.bestAsk(parsed.data)) ?? null,
        tickSize: symbol.tickSize,
        stepSize: symbol.stepSize,
        minNotional: symbol.minNotional,
      });
    }
    const available = Decimal.max(
      new Decimal(strategy.allocation)
        .minus(measured.committed)
        .minus(measured.reserved),
      0,
    ).toFixed();
    const slot = Math.floor(
      now.getTime() / (ai.analysisIntervalMinutes * 60_000),
    );
    let decision;
    try {
      decision = await this.#decisions.decide({
        strategy: { id: strategy.id, name: strategy.name, rules },
        markets,
        entries: unclosed.map((entry) => ({
          instrument: entry.instrument,
          quantity: entry.quantity,
          entryPrice: entry.entryPrice,
        })),
        availableAllocation: available,
        now,
        sequence: await this.store.decisionCount(scope, strategy.id),
      });
    } catch (error) {
      this.#warn(
        `The AI could not decide for ${strategy.id}: ${describe(error)}`,
      );
      return `The AI could not be asked at ${utc(now)}: ${describe(error)} It is asked again at the next analysis.`;
    }
    const saved = await this.#proposals.record(
      scope,
      { ...decision, idempotencyKey: `strategy:${strategy.id}:${slot}` },
      now,
      { strategyId: strategy.id, strategyVersion: strategy.version },
    );
    const proposal = saved.proposal;
    const label =
      decision.model === RECORDED_FIXTURE_MODEL ? " (recorded fixture)" : "";
    if (!proposal || proposal.status !== "draft")
      return `The AI decided not to trade${label} at ${utc(now)}.`;
    const summary = `Buy ${proposal.quantity} ${proposal.instrument.split("-")[0]} at ${proposal.entryPrice}, stop loss ${proposal.stopLossPrice}, take profit ${proposal.takeProfitPrice}${label}.`;
    if (ai.proposalApproval === "required") {
      await this.store.awaitingApproval(scope, strategy, {
        id: proposal.id,
        summary: `The AI proposes: ${summary}`,
      });
      return `The AI proposed a trade${label}, which waits for your approval on Activity.`;
    }
    const result = await this.#submitDraft(
      scope,
      context,
      strategy,
      proposal.id,
      "execution_checks",
    );
    return result.status === "sent"
      ? `Placed the AI's proposal${label}: ${summary}`
      : `The AI's proposal${label} was not placed: ${result.reason}`;
  }

  /**
   * Places a saved AI proposal of the strategy, decided by the customer or,
   * in automatic mode, by the execution checks. A proposal the checks
   * refuse is rejected with the reason.
   */
  async #submitDraft(
    scope: AccountScope,
    context: PassContext,
    strategy: StrategyRecord,
    proposalId: string,
    decidedBy: "customer" | "execution_checks",
  ): Promise<Submission> {
    const proposal = await this.#proposals.find(scope, proposalId);
    if (!proposal || proposal.strategyId !== strategy.id)
      return { status: "skipped", reason: "There is no such proposal." };
    const instrument = testnetInstrumentSchema.safeParse(proposal.instrument);
    if (!instrument.success)
      return {
        status: "skipped",
        reason: "The proposal's market is not traded here.",
      };
    const result = await this.#submit(scope, context, {
      strategyId: strategy.id,
      key: "ai",
      once: false,
      proposalId,
      draft: { decidedBy },
      rationale: proposal.rationale,
      sourceSnapshotId: proposal.sourceSnapshotId,
      intent: {
        key: "ai",
        instrument: instrument.data,
        marketKind: proposal.marketKind,
        direction: proposal.direction,
        leverage: proposal.leverage,
        quantity: proposal.quantity,
        entryPrice: proposal.entryPrice,
        stopLossPrice: proposal.stopLossPrice,
        takeProfitPrice: proposal.takeProfitPrice,
        entryExpiresAt: proposal.entryExpiresAt.toISOString(),
        holdingPeriodSeconds: strategy.rules.holdingPeriodSeconds,
      },
    });
    // Nothing was sent either way. If saving the rejection fails, the draft
    // stays a draft and the checks refuse it again when next approved.
    if (result.status === "skipped" && result.checksRefused)
      await this.#proposals
        .reject(
          scope,
          proposalId,
          { by: "execution_checks", reason: result.reason },
          context.now,
        )
        .catch(() => false);
    return result;
  }

  /**
   * Checks one entry and, if it passes, reserves its budget, saves it and
   * sends it, in the dashboard's queue. Binance's filters, the free balance
   * and the stop-order limit come first, then Binance's test order, then
   * `StrategyStore.reserve`, which runs `authorizeTradeProposal` and saves
   * the order intent before anything is sent.
   */
  async #submit(
    scope: AccountScope,
    context: PassContext,
    candidate: Omit<EntryCandidate, "freeStopOrders">,
  ): Promise<Submission> {
    const { reads } = context;
    const { intent } = candidate;
    const instrument = intent.instrument as TestnetInstrument;
    const symbol = await this.#symbolRules(instrument, reads.exchange);
    const order = {
      instrument,
      quantity: intent.quantity,
      price: intent.entryPrice,
      timeInForce: "GTC" as const,
      takeProfitPrice: intent.takeProfitPrice,
      stopLossPrice: intent.stopLossPrice,
    };
    const issues = protectedEntryFilterIssues(order, symbol);
    if (issues.length)
      return {
        status: "skipped",
        reason: issues.join(" "),
        checksRefused: true,
      };
    return this.#exclusive(async () => {
      // Measured again right before the entry, as before every entry.
      const losses = await this.#measureNow(
        scope,
        context,
        candidate.strategyId,
      );
      if (losses.status === "unmeasured")
        return {
          status: "skipped",
          reason: `The worker cannot measure its losses now. ${losses.reason}`,
        };
      if (losses.limits.breached)
        return {
          status: "skipped",
          reason: "A loss limit is reached, so it opens no entries.",
        };
      const free = await this.#freeStopOrders(
        scope,
        context,
        instrument,
        symbol,
      );
      if (free <= 0)
        return {
          status: "skipped",
          reason: `Binance allows ${maxStopOrders(symbol)} open stop orders on ${pair(instrument)} and all are in use, so it waits.`,
        };
      const notional = new Decimal(intent.quantity).times(intent.entryPrice);
      const usdt = await reads.balance("USDT");
      if (notional.gt(usdt.free))
        return {
          status: "skipped",
          reason: `It needs ${notional.toFixed()} USDT and ${new Decimal(usdt.free).toFixed()} USDT is free.`,
        };
      const entry = {
        ...order,
        listClientOrderId: strategyEntryClientOrderId(candidate.proposalId),
      };
      try {
        await reads.exchange.testProtectedEntry(entry);
      } catch (error) {
        if (error instanceof BinanceTestnetError && error.kind === "rejected")
          return {
            status: "skipped",
            reason: `Binance rejected the entry: ${error.reason ?? error.message}`,
            checksRefused: true,
          };
        throw error;
      }
      const reservation = await this.store.reserve(
        scope,
        { ...candidate, freeStopOrders: free },
        this.#now(),
      );
      if (reservation.status === "refused")
        return {
          status: "skipped",
          reason: reservation.reason,
          checksRefused: !reservation.waits,
        };
      reads.forgetBalance();
      reads.forgetOpenOrders(instrument);
      const outcome = await context.sender.send(scope, reservation.entry);
      this.#onChange();
      return { status: "sent", outcome };
    });
  }

  /**
   * How many more stop orders Binance would take on the symbol: its limit,
   * less the protected entries open there, each of whose stop loss holds or
   * will hold one, less entries being sent that Binance has not shown yet.
   */
  async #freeStopOrders(
    scope: AccountScope,
    context: PassContext,
    instrument: TestnetInstrument,
    symbol: SymbolRules,
  ) {
    const open = [...(await context.reads.openOrders(instrument)).values()];
    const used = new Set<string>();
    const visible = new Set<string>();
    for (const order of open) {
      const list = protectedLeg(order.clientOrderId)?.listClientOrderId;
      if (list) visible.add(list);
      if (
        order.orderListId >= 0 &&
        (order.side === "BUY" || STOP_TYPES.has(order.type))
      )
        used.add(`list:${order.orderListId}`);
      else if (STOP_TYPES.has(order.type)) used.add(`order:${order.orderId}`);
    }
    const inFlight = (
      await this.store.inFlightEntries(scope, instrument)
    ).filter((id) => !visible.has(id));
    return maxStopOrders(symbol) - used.size - inFlight.length;
  }

  // The rules are public, so any account's client reads them.
  async #symbolRules(
    instrument: TestnetInstrument,
    exchange: ExecutionExchange,
  ) {
    const now = this.#now().getTime();
    if (!this.#rules || now - this.#rules.fetchedAt > RULES_TTL_MS) {
      const value = exchange.getSymbolRules();
      this.#rules = { fetchedAt: now, value };
      value.catch(() => {
        this.#rules = undefined;
      });
    }
    const rules = (await this.#rules.value).find(
      (entry) => entry.instrument === instrument,
    );
    if (!rules)
      throw new Error(`Binance's rules for ${instrument} are missing.`);
    return rules;
  }

  /** One strategy's results and loss limits, read afresh. */
  async #measureNow(
    scope: AccountScope,
    context: PassContext,
    strategyId: string,
  ): Promise<Measured> {
    const strategy = await this.store.get(scope, strategyId);
    if (!strategy)
      return { status: "unmeasured", reason: "There is no such strategy." };
    const measured = await this.#measureAll(
      scope,
      context,
      [strategy],
      await this.store.entries(scope, [strategyId]),
    );
    return measured.get(strategyId)!;
  }

  /** Measures every strategy's results and loss limits. */
  async #measureAll(
    scope: AccountScope,
    context: PassContext,
    strategies: StrategyRecord[],
    entries: Map<string, StrategyEntry[]>,
  ) {
    const all = strategies.flatMap(
      (strategy) => entries.get(strategy.id) ?? [],
    );
    let fills: MeasuredFill[] = [];
    let failure: string | undefined;
    try {
      fills = await this.store.fills(
        scope,
        all.flatMap((entry) => entry.orderIntentId ?? []),
      );
    } catch (error) {
      failure = `Its fills could not be read: ${describe(error)}`;
    }
    const measured = new Map<string, Measured>();
    for (const strategy of strategies)
      measured.set(
        strategy.id,
        failure
          ? { status: "unmeasured", reason: failure }
          : await this.#measure(
              context,
              strategy,
              entries.get(strategy.id) ?? [],
              fills,
            ),
      );
    return measured;
  }

  async #measure(
    context: PassContext,
    strategy: StrategyRecord,
    entries: StrategyEntry[],
    fills: MeasuredFill[],
  ): Promise<Measured> {
    const { now } = context;
    const placed = entries.filter((entry) => entry.orderIntentId !== null);
    const measuredEntries: MeasuredEntry[] = [];
    try {
      for (const entry of placed)
        measuredEntries.push({
          orderIntentId: entry.orderIntentId!,
          instrument: entry.instrument,
          holding: entry.state !== "handed_over" && entry.state !== "missing",
          stepSize: (
            await this.#symbolRules(entry.instrument, context.reads.exchange)
          ).stepSize,
        });
    } catch (error) {
      return {
        status: "unmeasured",
        reason: `Binance's rules could not be read: ${describe(error)}`,
      };
    }
    const own = fills.filter((fill) =>
      measuredEntries.some(
        (entry) => entry.orderIntentId === fill.orderIntentId,
      ),
    );
    try {
      const marks = new Map<TestnetInstrument, string>();
      for (const instrument of new Set(
        placed
          .filter(
            (entry) => isUnclosed(entry) || new Decimal(entry.filled).gt(0),
          )
          .map((entry) => entry.instrument),
      ))
        marks.set(instrument, await context.reads.lastPrice(instrument));
      const dayStartMarks = new Map<TestnetInstrument, string>();
      for (const instrument of dayStartInstruments(measuredEntries, own, now))
        dayStartMarks.set(
          instrument,
          await this.#dayStartPrice(instrument, now, context.reads.exchange),
        );
      const pnl = strategyPnl(measuredEntries, own, {
        now,
        marks,
        dayStartMarks,
      });
      let committed = new Decimal(0);
      let reserved = new Decimal(0);
      for (const entry of entries.filter(isUnclosed)) {
        const notional = new Decimal(entry.quantity).times(entry.entryPrice);
        if (new Decimal(entry.filled).gt(0))
          committed = committed.plus(notional);
        else reserved = reserved.plus(notional);
      }
      return {
        status: "measured",
        pnl,
        limits: measureLossLimits(pnl, strategy.rules.lossLimits, now),
        committed: committed.toFixed(),
        reserved: reserved.toFixed(),
      };
    } catch (error) {
      return {
        status: "unmeasured",
        reason:
          error instanceof UnmeasurableError
            ? error.message
            : `Binance's prices could not be read: ${describe(error)}`,
      };
    }
  }

  /** The open of the hourly candle at the latest midnight UTC. */
  #dayStartPrice(
    instrument: TestnetInstrument,
    now: Date,
    exchange: ExecutionExchange,
  ) {
    const dayStart = utcDayStart(now).getTime();
    const key = `${instrument}@${dayStart}`;
    let price = this.#dayStartPrices.get(key);
    if (!price) {
      const hours = Math.floor((now.getTime() - dayStart) / HOUR_MS) + 1;
      price = exchange
        .getKlines(instrument, "1h", Math.min(hours + 1, 30))
        .then((candles) => {
          const candle = candles.find((entry) => entry.openTime === dayStart);
          if (!candle)
            throw new UnmeasurableError(
              `Binance has no ${pair(instrument)} candle for midnight UTC.`,
            );
          return candle.open;
        });
      this.#dayStartPrices.clear();
      this.#dayStartPrices.set(key, price);
      price.catch(() => this.#dayStartPrices.delete(key));
    }
    return price;
  }

  /**
   * What the Strategies page shows: each strategy with its results, the
   * portfolio's drawdown today, and each market's prices and stop orders.
   */
  async state(
    scope: AccountScope,
    exchange: ExecutionExchange,
  ): Promise<StrategiesState> {
    const context = this.#context(exchange);
    const strategies = await this.store.list(scope);
    const ids = strategies.map((strategy) => strategy.id);
    const [entries, limits, decisions] = await Promise.all([
      this.store.entries(scope, ids),
      this.store.portfolioLimits(scope),
      this.store.latestDecisions(scope, ids),
    ]);
    const measured = await this.#measureAll(
      scope,
      context,
      strategies,
      entries,
    );
    const markets: StrategyMarket[] = [];
    for (const instrument of testnetInstrumentSchema.options) {
      try {
        const symbol = await this.#symbolRules(instrument, exchange);
        const [lastPrice, bestAsk, free] = await Promise.all([
          context.reads.lastPrice(instrument).catch(() => null),
          context.reads.bestAsk(instrument).catch(() => undefined),
          this.#freeStopOrders(scope, context, instrument, symbol).catch(
            () => null,
          ),
        ]);
        markets.push({
          instrument,
          lastPrice,
          bestAsk: bestAsk ?? null,
          tickSize: plainText(symbol.tickSize),
          stepSize: plainText(symbol.stepSize),
          minNotional: plainText(symbol.minNotional),
          maxStopOrders: maxStopOrders(symbol),
          stopOrdersInUse:
            free === null ? null : Math.max(maxStopOrders(symbol) - free, 0),
        });
      } catch {
        // Left out: the page says the market's rules are unavailable.
      }
    }
    const live = todays(strategies, context.now);
    const today = limits.current
      ? portfolioToday(live, measured, limits.current.maxDailyDrawdownPercent)
      : portfolioToday(live, measured, "100");
    return {
      strategies: strategies.map((strategy) =>
        strategyView(
          strategy,
          entries.get(strategy.id) ?? [],
          measured.get(strategy.id)!,
          decisions.get(strategy.id),
          context.now,
        ),
      ),
      limits,
      today: today
        ? { ...today, reached: limits.current ? today.reached : false }
        : null,
      markets,
      aiSource: this.aiSource,
    };
  }

  /**
   * Why a paused strategy may not resume now: a loss limit still reached,
   * the portfolio's drawdown limit, or losses the worker cannot measure.
   */
  async resumeProblem(
    scope: AccountScope,
    exchange: ExecutionExchange,
    strategyId: string,
  ): Promise<string | undefined> {
    const context = this.#context(exchange);
    const strategies = todays(await this.store.list(scope), context.now);
    const strategy = strategies.find(
      (entry) => entry.id === strategyId && entry.status !== "retired",
    );
    if (!strategy) return undefined;
    const entries = await this.store.entries(
      scope,
      strategies.map((entry) => entry.id),
    );
    const measured = await this.#measureAll(
      scope,
      context,
      strategies,
      entries,
    );
    const result = measured.get(strategyId)!;
    if (result.status === "unmeasured")
      return `The worker cannot measure its losses now, so it cannot resume. ${result.reason}`;
    const { daily, total } = result.limits;
    if (total.reached)
      return `Its total loss limit is reached: ${total.loss} of ${total.limit} USDT. Save a new version with a higher total loss limit to resume it.`;
    if (daily.reached)
      return `Its daily loss limit is still reached today: ${daily.loss} of ${daily.limit} USDT since midnight UTC. Resume it after midnight UTC, or save a new version with a higher daily loss limit.`;
    const limit = (await this.store.portfolioLimits(scope)).current;
    const today = limit
      ? portfolioToday(strategies, measured, limit.maxDailyDrawdownPercent)
      : undefined;
    if (limit && !today)
      return "The worker cannot measure every strategy, so it cannot measure the portfolio's drawdown.";
    if (today?.reached)
      return `The portfolio has lost ${today.drawdownPercent}% since midnight UTC, reaching its ${limit!.maxDailyDrawdownPercent}% daily drawdown limit. Resume after midnight UTC, or raise the limit in Settings → Risk limits.`;
    return undefined;
  }

  /**
   * Places an AI-managed strategy's proposal the customer approved, after
   * measuring the strategy's loss limits and running every check again.
   * A proposal the checks refuse is rejected with the reason.
   */
  async approve(
    scope: AccountScope,
    exchange: ExecutionExchange,
    proposalId: string,
  ): Promise<ManualOrderOutcome> {
    const now = this.#now();
    const proposal = await this.#proposals.find(scope, proposalId);
    if (!proposal?.strategyId)
      return {
        status: "invalid",
        message: "There is no such proposal, so nothing was sent.",
      };
    if (proposal.status !== "draft")
      return {
        status:
          proposal.status === "approved" || proposal.status === "authorized"
            ? "duplicate"
            : "rejected",
        message:
          proposal.status === "approved" || proposal.status === "authorized"
            ? "This proposal was already approved, so it was not sent again."
            : `This proposal was ${proposal.status}, so nothing was sent.`,
      };
    if (proposal.entryExpiresAt.getTime() <= now.getTime()) {
      // Only bookkeeping: an expired draft can never be approved, whether
      // or not its status is saved now.
      await this.#proposals.expire(scope, proposalId, now).catch(() => false);
      return {
        status: "rejected",
        message:
          "This proposal expired before it was approved, so nothing was sent.",
      };
    }
    const strategy = await this.store.get(scope, proposal.strategyId);
    if (!strategy)
      return {
        status: "invalid",
        message: "Its strategy is gone, so nothing was sent.",
      };
    const problem = isRunning(strategy.status)
      ? await this.resumeProblem(scope, exchange, strategy.id)
      : `${strategy.name} is ${strategy.status === "paused" ? "paused" : "completed"}, so it opens no entries. Nothing was sent.`;
    if (problem) return { status: "rejected", message: problem };
    const result = await this.#submitDraft(
      scope,
      this.#context(exchange),
      strategy,
      proposalId,
      "customer",
    );
    return result.status === "sent"
      ? result.outcome
      : {
          status: "rejected",
          message: (result.checksRefused
            ? `The execution checks refused this proposal, so it was rejected: ${result.reason}`
            : `Nothing was sent, and the proposal still waits for your approval until it expires: ${result.reason}`
          ).slice(0, 500),
        };
  }

  #warn(message: string) {
    if (message === this.#lastLogged) return;
    this.#lastLogged = message;
    this.#log(message);
  }
}

/**
 * The strategies that count today: every one not completed, and those that
 * completed since midnight UTC, whose results today still count against the
 * portfolio's drawdown.
 */
function todays(strategies: StrategyRecord[], now: Date) {
  const dayStart = utcDayStart(now).getTime();
  return strategies.filter(
    (strategy) =>
      strategy.status !== "retired" ||
      (strategy.completedAt?.getTime() ?? 0) >= dayStart,
  );
}

/** Every strategy's result since midnight UTC against their allocations. */
function portfolioToday(
  strategies: StrategyRecord[],
  measured: Map<string, Measured>,
  limitPercent: string,
) {
  let pnl = new Decimal(0);
  let allocation = new Decimal(0);
  for (const strategy of strategies) {
    const result = measured.get(strategy.id);
    if (!result || result.status !== "measured") return undefined;
    pnl = pnl.plus(result.limits.daily.pnl);
    allocation = allocation.plus(strategy.allocation);
  }
  const drawdown = allocation.gt(0)
    ? Decimal.max(pnl.negated(), 0).dividedBy(allocation).times(100)
    : new Decimal(0);
  return {
    pnl: pnl.toFixed(),
    allocation: allocation.toFixed(),
    drawdownPercent: drawdown.toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(),
    reached: allocation.gt(0) && drawdown.gte(limitPercent),
  };
}

function strategyView(
  strategy: StrategyRecord,
  entries: StrategyEntry[],
  measured: Measured,
  decision:
    | { at: Date; kind: "trade_proposal" | "no_trade"; model: string }
    | undefined,
  now: Date,
): StrategyView {
  const unclosed = entries.filter(isUnclosed);
  let measure: StrategyMeasure;
  if (measured.status === "measured") {
    const { pnl, limits } = measured;
    measure = {
      status: "measured",
      measuredAt: now.toISOString(),
      realizedPnl: pnl.realizedPnl,
      fees: pnl.fees,
      unrealizedPnl: pnl.unrealizedPnl,
      currentValue: new Decimal(strategy.allocation)
        .plus(pnl.realizedPnl)
        .minus(pnl.fees)
        .plus(pnl.unrealizedPnl)
        .toFixed(),
      committed: measured.committed,
      reserved: measured.reserved,
      daily: limits.daily,
      total: limits.total,
    };
  } else
    measure = { status: "unmeasured", reason: measured.reason.slice(0, 300) };
  return {
    id: strategy.id,
    name: strategy.name,
    status: strategy.status,
    version: strategy.version,
    createdAt: strategy.createdAt.toISOString(),
    rules: strategy.rules,
    ai: strategy.ai,
    allocation: strategy.allocation,
    pauseReason: strategy.pauseReason,
    pausedAt: strategy.pausedAt?.toISOString() ?? null,
    exitRequest: strategy.exitRequest,
    rulesEnded:
      strategy.rulesEndedAt && strategy.rulesEndedReason
        ? {
            at: strategy.rulesEndedAt.toISOString(),
            reason: strategy.rulesEndedReason,
          }
        : null,
    completedAt: strategy.completedAt?.toISOString() ?? null,
    runnerNote: strategy.runnerNote,
    runnerCheckedAt: strategy.runnerCheckedAt?.toISOString() ?? null,
    nextAnalysisAt: strategy.nextAnalysisAt?.toISOString() ?? null,
    entries: {
      pending: unclosed.filter((entry) => new Decimal(entry.filled).isZero())
        .length,
      open: unclosed.filter((entry) => new Decimal(entry.filled).gt(0)).length,
      awaitingApproval: entries.filter(
        (entry) =>
          entry.orderIntentId === null &&
          entry.proposalStatus === "draft" &&
          entry.entryExpiresAt.getTime() > now.getTime(),
      ).length,
    },
    measure,
    latestDecision: decision
      ? {
          at: decision.at.toISOString(),
          kind: decision.kind,
          model: decision.model,
          fixture: decision.model === RECORDED_FIXTURE_MODEL,
        }
      : null,
  };
}

function maxStopOrders(symbol: SymbolRules) {
  return symbol.maxStopOrders ?? DEFAULT_MAX_STOP_ORDERS;
}

function waitNote(
  plan: Extract<EntryPlan, { action: "wait" }>,
  instrument: TestnetInstrument,
  freeStops: number,
  symbol: SymbolRules,
) {
  const until = plan.until ? ` until ${utc(plan.until)}` : "";
  switch (plan.reason) {
    case "not_started":
      return `Waiting for its first buy, due at ${utc(plan.until!)}.`;
    case "buy_made":
      return `This interval's buy is made; the next is due at ${utc(plan.until!)}.`;
    case "entry_limit":
      return freeStops <= 0
        ? `Waiting: Binance allows ${maxStopOrders(symbol)} open stop orders on ${pair(instrument)} and all are in use, so no further entry could be protected${plan.until ? `; a buy due now is skipped` : ""}.`
        : `At its entry limit${until}.`;
    case "entries_pending":
      return "Every entry is placed.";
    case "no_free_level":
      return "Every grid level below the market holds an entry.";
    case "unprotectable":
      return `Waiting${until}: the next entry cannot be protected at Binance's tick and lot sizes, or is too small to buy.`;
  }
}

function entryRationale(intent: EntryIntent) {
  const what = describeKey(intent.key);
  return `${what[0].toUpperCase()}${what.slice(1)}: buy ${intent.quantity} at ${intent.entryPrice}, take profit ${intent.takeProfitPrice}, stop loss ${intent.stopLossPrice}.`;
}

function describeKey(key: string) {
  const [kind, index] = key.split(":");
  const number = Number(index);
  switch (kind) {
    case "level":
      return `the buy at grid level ${number + 1}`;
    case "buy":
      return `buy ${number + 1}`;
    case "entry":
      return `entry ${number + 1}`;
    default:
      return "the AI's entry";
  }
}

/** Like "2026-10-08 13:05 UTC". */
function utc(time: Date | string) {
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function pair(instrument: TestnetInstrument) {
  return instrument.replace("-", "/");
}

function plainText(value: string) {
  return new Decimal(value).toFixed();
}

/** A message safe to log: never request URLs, signatures or credentials. */
function describe(error: unknown) {
  if (error instanceof BinanceTestnetError) return error.message;
  if (error instanceof Error && error.name === "PostgresError")
    return `PostgreSQL: ${error.message}`;
  if (
    error instanceof Error &&
    (error.constructor === Error || error instanceof UnmeasurableError)
  )
    return error.message;
  return "unexpected error";
}
