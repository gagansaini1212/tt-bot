import Decimal from "decimal.js";
import {
  listCustomerIds,
  withCustomerScope,
  type Database,
  type JSONValue,
} from "@crypto-trading/database";
import {
  BinanceTestnetError,
  closeOrderId,
  floorToStep,
  protectedLegIds,
  type BinanceSpotTestnet,
  type ExecutionState,
  type ManualOrderOutcome,
  type SymbolRules,
  type TestnetFill,
  type TestnetInstrument,
  type TestnetMarketSell,
  type TestnetOrder,
} from "@crypto-trading/exchanges";
import type { AccountResolver, AccountScope } from "./accounts";
import {
  assessEntry,
  CANCEL_ONLY_REASONS,
  isOpen,
  TERMINAL_STATES,
  type CloseState,
  type EntryAssessment,
  type EntryObservation,
  type LegState,
} from "./entry-assessment";
import {
  ExecutionStore,
  pauseStrategyInDatabase,
  type DeadlineEntry,
  type StrategyPauser,
  type TrackedEntry,
  type TransitionEffects,
} from "./execution-store";
import type { ManualOrderDesk } from "./manual-orders";
import {
  raiseNotification,
  recentNotifications,
  type NewNotification,
} from "./notifications";
import {
  RECONCILE_TOPIC,
  type ManualOrder,
  type OrderIntentStore,
  type PostgresOrderIntents,
  type ProtectedEntryOrder,
} from "./order-intents";
import { claimDueJobs, completeJob, retryDelay, retryJob } from "./outbox";

/** What the loop asks Binance. */
export type ExecutionExchange = Pick<
  BinanceSpotTestnet,
  | "getAccount"
  | "getOpenOrders"
  | "getOrder"
  | "getOrderList"
  | "getOrderFills"
  | "getLastPrice"
  | "getSymbolRules"
  | "cancelOrderList"
  | "placeMarketSell"
>;

/** Sends a stop-limit entry whose stop price traded; see ManualOrderDesk. */
export type TriggerDesk = Pick<ManualOrderDesk, "submitTrigger">;

/** How often the worker checks every customer's orders. */
export const PASS_INTERVAL_MS = 5_000;
/** Market sells the worker tries for one entry before asking the customer. */
export const MAX_CLOSE_ATTEMPTS = 3;
// closeOrderId numbers an entry's sells 1 to 9.
const MAX_SELL_IDS = 9;
// Binance's code for an order or order list that does not exist.
const NO_SUCH_ORDER = -2013;
const RULES_TTL_MS = 5 * 60_000;
// The dashboard lists notifications from this long ago at most.
const NOTIFICATIONS_SHOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * The worker's execution loop (ADR 0002). Each pass visits every customer
 * whose exchange account the worker trades on, and for each one:
 *
 * 1. settles submissions whose outcome was unknown, from due
 *    `order_intent.reconcile` jobs, by looking each order up by client ID;
 * 2. sends stop-limit entries whose stop price has traded;
 * 3. starts the exit of entries past their holding deadline;
 * 4. reconciles every open protected entry with Binance, keeping its orders
 *    and fills, and sells quantity no stop loss protects;
 * 5. marks exits still held after their deadline overdue.
 *
 * Everything it acts on is in PostgreSQL, so a restarted worker carries on
 * where it stopped. Two workers can run at once: an advisory lock gives each
 * customer's pass to one of them, and every action is guarded on its own as
 * well. Each order is saved as an intent before it is sent, and state
 * changes lock their row. Alerts about an entry's state are raised in the
 * same transaction as the change; notices of a stop-limit entry being sent
 * follow the send, so a crash between them loses only the notice.
 */
export class ExecutionLoop {
  readonly #database: Database;
  readonly #exchange: ExecutionExchange;
  readonly #accounts: AccountResolver;
  readonly #intents: OrderIntentStore &
    Pick<PostgresOrderIntents, "resolveMissing">;
  readonly #store: ExecutionStore;
  readonly #desk?: TriggerDesk;
  readonly #now: () => Date;
  readonly #onChange: () => void;
  readonly #pause: StrategyPauser;
  readonly #log: (message: string) => void;
  readonly #lockCustomers: boolean;
  readonly #lastPass = new Map<string, Date>();
  #rules?: { fetchedAt: number; value: Promise<SymbolRules[]> };
  #running?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #stopped = false;
  #lastLogged?: string;

  constructor(options: {
    database: Database;
    exchange: ExecutionExchange;
    accounts: AccountResolver;
    intents: OrderIntentStore & Pick<PostgresOrderIntents, "resolveMissing">;
    // Without one, stop-limit entries wait; dashboard orders are off.
    desk?: TriggerDesk;
    now?: () => Date;
    // Called after anything that may have changed the account.
    onChange?: () => void;
    pauseStrategy?: StrategyPauser;
    log?: (message: string) => void;
    // Tests turn this off to prove each action is guarded on its own.
    lockCustomers?: boolean;
  }) {
    this.#database = options.database;
    this.#exchange = options.exchange;
    this.#accounts = options.accounts;
    this.#intents = options.intents;
    this.#store = new ExecutionStore(options.database);
    this.#desk = options.desk;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => {});
    this.#pause = options.pauseStrategy ?? pauseStrategyInDatabase;
    this.#log = options.log ?? ((message) => console.error(message));
    this.#lockCustomers = options.lockCustomers ?? true;
  }

  get store() {
    return this.#store;
  }

  /** When this worker last finished a pass over the customer's orders. */
  lastPassAt(customerId: string) {
    return this.#lastPass.get(customerId);
  }

  /**
   * What the dashboard shows: entries that hold quantity the worker is
   * selling or must, stop-limit entries it holds, and the week's latest
   * notifications.
   */
  async state(scope: AccountScope): Promise<ExecutionState> {
    const since = new Date(this.#now().getTime() - NOTIFICATIONS_SHOWN_MS);
    const [alerts, triggers, notifications] = await Promise.all([
      this.#store.alerts(scope),
      this.#intents.pendingTriggers(scope),
      withCustomerScope(this.#database, scope.customerId, (tx) =>
        recentNotifications(tx, { limit: 10, since }),
      ),
    ]);
    return {
      checkedAt: this.#lastPass.get(scope.customerId)?.toISOString() ?? null,
      alerts,
      triggers: triggers.flatMap(({ order, createdAt }) =>
        order.kind === "protected_entry" && order.trigger
          ? [
              {
                listClientOrderId: order.entry.listClientOrderId,
                instrument: order.entry.instrument,
                stopPrice: order.trigger.stopPrice,
                price: order.entry.price,
                quantity: order.entry.quantity,
                takeProfitPrice: order.entry.takeProfitPrice,
                stopLossPrice: order.entry.stopLossPrice,
                createdAt: createdAt.toISOString(),
              },
            ]
          : [],
      ),
      notifications,
    };
  }

  /** Runs one pass. A call during a pass waits for that pass instead. */
  runPass(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Runs a pass now and then every `intervalMs` until `stop`. */
  start(intervalMs = PASS_INTERVAL_MS) {
    this.#stopped = false;
    const tick = async () => {
      await this.runPass().catch((error: unknown) =>
        this.#warn(`The execution loop failed: ${describe(error)}`),
      );
      if (!this.#stopped) this.#timer = setTimeout(tick, intervalMs);
    };
    this.#timer = setTimeout(tick, 0);
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  async #pass() {
    for (const customerId of await listCustomerIds(this.#database)) {
      if (this.#stopped) return;
      try {
        const scope = await this.#accounts(customerId);
        if (!scope) continue;
        if (await this.#exclusively(customerId, () => this.#customer(scope)))
          this.#lastPass.set(customerId, this.#now());
      } catch (error) {
        this.#warn(
          `The execution loop could not check a customer's orders: ${describe(error)}`,
        );
      }
    }
  }

  /**
   * Runs `work` unless another worker is checking this customer. The lock is
   * held by a session, not a transaction, so no row stays locked while the
   * pass waits on Binance.
   */
  async #exclusively(customerId: string, work: () => Promise<void>) {
    if (!this.#lockCustomers) {
      await work();
      return true;
    }
    const key = `execution-loop:${customerId}`;
    const connection = await this.#database.reserve();
    try {
      const [{ locked }] = await connection<{ locked: boolean }[]>`
        select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked
      `;
      if (!locked) return false;
      try {
        await work();
        return true;
      } finally {
        await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
      }
    } finally {
      connection.release();
    }
  }

  async #customer(scope: AccountScope) {
    const reads = new PassReads(this.#exchange);
    await this.#settleUnknownOutcomes(scope);
    await this.#sendTriggeredEntries(scope, reads);
    await this.#store.startDueExits(scope, this.#now(), deadlineReached);
    for (const entry of await this.#store.trackedEntries(scope)) {
      try {
        await this.#reconcile(scope, entry, reads);
      } catch (error) {
        this.#warn(
          `Could not reconcile ${entry.listClientOrderId}: ${describe(error)}`,
        );
      }
    }
    await this.#store.markOverdueExits(scope, this.#now(), exitOverdue);
  }

  /**
   * Looks up each submission whose outcome is still unknown once its grace
   * period is over. Only "does not exist" proves Binance never took it;
   * any other failure leaves it for a later pass. Nothing is resubmitted.
   */
  async #settleUnknownOutcomes(scope: AccountScope) {
    const now = this.#now();
    const jobs = await claimDueJobs(
      this.#database,
      scope.customerId,
      RECONCILE_TOPIC,
      now,
    );
    for (const job of jobs) {
      const intent = await this.#store.intent(
        scope,
        String(job.payload.orderIntentId),
      );
      if (!intent || !["submitting", "unknown"].includes(intent.status)) {
        await completeJob(this.#database, scope.customerId, job.id);
        continue;
      }
      try {
        const found = await this.#lookUp(intent);
        if (found) {
          await this.#intents.settle(scope, intent.clientOrderId, {
            status: "acknowledged",
            ...found,
          });
          await completeJob(this.#database, scope.customerId, job.id);
          this.#onChange();
          continue;
        }
        const order = intent.order;
        await this.#intents.resolveMissing(
          scope,
          intent.clientOrderId,
          async (tx) => {
            if (order?.kind === "protected_entry" && order.trigger)
              await raiseNotification(
                tx,
                scope.customerId,
                triggerInterrupted(order, intent.clientOrderId),
              );
          },
        );
      } catch (error) {
        await retryJob(
          this.#database,
          scope.customerId,
          job.id,
          describe(error),
          { now, delayMs: retryDelay(job.attempts) },
        );
      }
    }
  }

  async #lookUp(intent: {
    clientOrderId: string;
    order: ManualOrder | null;
  }): Promise<{ orderListId?: number; orders?: TestnetOrder[] } | undefined> {
    const order = intent.order;
    if (!order || order.kind === "protected_entry") {
      const list = await absentIfMissing(
        this.#exchange.getOrderList(intent.clientOrderId),
      );
      return list && { orderListId: list.orderListId };
    }
    const found = await absentIfMissing(
      this.#exchange.getOrder(order.order.instrument, intent.clientOrderId),
    );
    return found && { orders: [found] };
  }

  /** Sends each stop-limit entry whose stop price has traded. */
  async #sendTriggeredEntries(scope: AccountScope, reads: PassReads) {
    const triggers = await this.#intents.pendingTriggers(scope);
    if (!triggers.length) return;
    if (!this.#desk) {
      this.#warn(
        "Stop-limit entries are waiting, but dashboard orders are off in the execution worker, so none can be sent.",
      );
      return;
    }
    for (const trigger of triggers) {
      const order = trigger.order;
      if (order.kind !== "protected_entry" || !order.trigger) continue;
      try {
        const price = await reads.lastPrice(order.entry.instrument);
        if (new Decimal(price).lt(order.trigger.stopPrice)) continue;
        const outcome = await this.#desk.submitTrigger(
          scope,
          trigger.clientOrderId,
        );
        if (!outcome) continue;
        this.#onChange();
        await this.#store.notify(scope, triggerSent(order, price, outcome));
      } catch (error) {
        this.#warn(
          `Could not check stop-limit entry ${trigger.clientOrderId}: ${describe(error)}`,
        );
      }
    }
  }

  async #reconcile(
    scope: AccountScope,
    tracked: TrackedEntry,
    reads: PassReads,
  ) {
    const now = this.#now();
    const { instrument } = tracked.entry;
    const ids = protectedLegIds(tracked.listClientOrderId);
    const open = await reads.openOrders(instrument);
    const reports: TestnetOrder[] = [];
    // A leg Binance reported final is read from the database; others from
    // the open orders, or one by one.
    const read = async (
      clientOrderId: string,
    ): Promise<LegState | undefined> => {
      const known = tracked.legs.get(clientOrderId);
      if (known?.final) return known;
      const live =
        open.get(clientOrderId) ??
        (await absentIfMissing(
          this.#exchange.getOrder(instrument, clientOrderId),
        ));
      if (!live) return undefined;
      reports.push(live);
      return toLeg(live);
    };

    const entryLeg = await read(ids.entry);
    if (!entryLeg) return this.#missing(scope, tracked);
    let takeProfit: LegState | undefined;
    let stopLoss: LegState | undefined;
    if (entryLeg.status === "FILLED") {
      takeProfit = (await read(ids.takeProfit)) ?? missingLeg(ids.takeProfit);
      stopLoss = (await read(ids.stopLoss)) ?? missingLeg(ids.stopLoss);
    }
    const closes: CloseState[] = [];
    for (const close of tracked.closes)
      closes.push({
        clientOrderId: close.clientOrderId,
        intentStatus: close.status,
        leg:
          close.status === "acknowledged"
            ? await read(close.clientOrderId)
            : undefined,
      });
    await this.#store.recordOrders(scope, reports);
    // Including legs already final, such as an entry that filled when it
    // was placed, whose fills nothing has read yet.
    await this.#keepFills(scope, tracked, [
      entryLeg,
      takeProfit,
      stopLoss,
      ...closes.map((close) => close.leg),
    ]);

    let facts = this.#fillFacts(tracked);
    const rules = await this.#symbolRules(instrument);
    const observation: EntryObservation = {
      entry: entryLeg,
      takeProfit,
      stopLoss,
      closes,
      baseFee: facts.baseFee,
      stepSize: rules.stepSize,
      lastFillAt: facts.lastFillAt,
      stopLossPrice: tracked.entry.stopLossPrice,
      lastPrice:
        entryLeg.status === "PARTIALLY_FILLED"
          ? await reads.lastPrice(instrument)
          : undefined,
      customerAccepted: tracked.reconciliation?.customerAccepted ?? null,
      exitReason: tracked.reconciliation?.exitReason ?? null,
      wasUnprotected: tracked.reconciliation?.state === "unprotected",
      now,
    };
    let assessment = assessEntry(observation);

    // Decided now: saved, notified and paused before anything is sent, so
    // a crash cannot lose the decision or repeat its notification.
    if (
      assessment.exitReason &&
      assessment.exitReason !== observation.exitReason
    ) {
      const previous = await this.#store.transition(
        scope,
        tracked,
        this.#update(assessment, facts.firstFillAt),
        this.#exitStarted(scope, tracked, assessment),
      );
      // Another worker finished the entry since this pass read it.
      if (previous && TERMINAL_STATES.includes(previous.state)) return;
      observation.exitReason = previous?.exitReason ?? assessment.exitReason;
      assessment = { ...assessment, exitReason: observation.exitReason };
    }

    if (assessment.cancelList) {
      const cancelled = await this.#cancelList(
        scope,
        tracked,
        [entryLeg, takeProfit, stopLoss],
        assessment.exitReason,
      );
      if (cancelled) {
        const leg = (current: LegState | undefined) => {
          const report = cancelled.find(
            (order) => order.clientOrderId === current?.clientOrderId,
          );
          return report ? toLeg(report) : current;
        };
        observation.entry = leg(observation.entry)!;
        observation.takeProfit = leg(observation.takeProfit);
        observation.stopLoss = leg(observation.stopLoss);
        facts = this.#fillFacts(tracked);
        observation.baseFee = facts.baseFee;
        observation.lastFillAt = facts.lastFillAt;
        assessment = assessEntry(observation);
      }
    }

    let sale: Sale | undefined;
    if (assessment.sell) {
      sale = await this.#sell(scope, tracked, assessment, reads);
      if (sale.kind === "sent") {
        observation.closes.push(sale.close);
        await this.#keepFills(scope, tracked, [sale.close.leg]);
        assessment = assessEntry(observation);
        // Its exits are cancelled and Binance refused the sale, so what it
        // holds now has no stop loss, whatever the reason for the exit.
        if (
          sale.close.intentStatus === "rejected" &&
          !sale.rateLimited &&
          assessment.state === "exiting"
        )
          assessment = { ...assessment, state: "unprotected" };
      } else if (sale.kind === "dust" || sale.kind === "gone") {
        // Nothing is left that the worker can sell, so it is done.
        assessment = { ...assessment, state: "closed" };
      }
    }

    await this.#store.transition(
      scope,
      tracked,
      {
        ...this.#update(assessment, facts.firstFillAt),
        closeBlocked: sale?.kind === "blocked",
        rateLimitedSells: sale?.kind === "sent" && sale.rateLimited ? 1 : 0,
        // A sale that stopped or cannot happen replaces "selling".
        detail:
          sale && sale.kind !== "sent" && sale.kind !== "waiting"
            ? sale.note
            : [assessment.finding, sale?.note].filter(Boolean).join(" "),
      },
      this.#settled(scope, tracked, assessment, sale),
    );
  }

  /** Keeps the fills of every order that has filled more than recorded. */
  async #keepFills(
    scope: AccountScope,
    tracked: TrackedEntry,
    legs: (LegState | undefined)[],
  ) {
    for (const leg of legs) {
      if (!leg || leg.orderId === null) continue;
      const recorded = tracked.fills
        .filter((fill) => fill.clientOrderId === leg.clientOrderId)
        .reduce((total, fill) => total.plus(fill.quantity), new Decimal(0));
      if (new Decimal(leg.executedQty).lte(recorded)) continue;
      const fills = await this.#exchange.getOrderFills(
        tracked.entry.instrument,
        leg.orderId,
      );
      await this.#store.recordFills(scope, leg.clientOrderId, fills);
      tracked.fills = tracked.fills
        .filter((fill) => fill.clientOrderId !== leg.clientOrderId)
        .concat(fills.map((fill) => toFill(leg.clientOrderId, fill)));
    }
  }

  #fillFacts(tracked: TrackedEntry) {
    const entryId = protectedLegIds(tracked.listClientOrderId).entry;
    const base = baseAsset(tracked.entry.instrument);
    const fills = tracked.fills.filter(
      (fill) => fill.clientOrderId === entryId,
    );
    const times = fills.map((fill) => fill.at.getTime());
    return {
      baseFee: fills
        .filter((fill) => fill.feeAsset === base)
        .reduce((total, fill) => total.plus(fill.fee), new Decimal(0))
        .toFixed(),
      lastFillAt: times.length ? new Date(Math.max(...times)) : null,
      firstFillAt: times.length ? new Date(Math.min(...times)) : null,
    };
  }

  #update(assessment: EntryAssessment, firstFillAt: Date | null) {
    return {
      state: assessment.state,
      filled: assessment.filled,
      held: assessment.held,
      // The first fill's own time. Binance reports an order's fills, so the
      // worker's clock stands in only if it reports none for a filled order.
      firstFillAt: new Decimal(assessment.filled).gt(0)
        ? (firstFillAt ?? this.#now())
        : null,
      exitReason: assessment.exitReason,
      detail: assessment.finding,
    };
  }

  /** Cancels an order list. Resolves its reports, or undefined if it failed. */
  async #cancelList(
    scope: AccountScope,
    tracked: TrackedEntry,
    legs: (LegState | undefined)[],
    exitReason: string | null,
  ) {
    const orderListId = legs.find(
      (leg) =>
        isOpen(leg) && leg?.orderListId !== undefined && leg.orderListId >= 0,
    )?.orderListId;
    if (orderListId === undefined) return undefined;
    let orderReports: TestnetOrder[];
    try {
      ({ orderReports } = await this.#exchange.cancelOrderList(
        tracked.entry.instrument,
        orderListId,
      ));
    } catch (error) {
      // Such as the list finishing first. The next pass reads it again.
      this.#warn(
        `Could not cancel order list ${tracked.listClientOrderId}: ${describe(error)}`,
      );
      return undefined;
    }
    this.#onChange();
    await this.#store.audit(scope, tracked.orderIntentId, "order.cancelled", {
      orderListId,
      reason: exitReason,
    });
    await this.#store.recordOrders(scope, orderReports);
    await this.#keepFills(scope, tracked, orderReports.map(toLeg));
    return orderReports;
  }

  /**
   * Sells what the entry holds at market, as a new exit intent saved before
   * it is sent. The quantity is capped at what the account holds and is free
   * to sell, and rounded down to Binance's step.
   */
  async #sell(
    scope: AccountScope,
    tracked: TrackedEntry,
    assessment: EntryAssessment,
    reads: PassReads,
  ): Promise<Sale> {
    const { instrument } = tracked.entry;
    const base = baseAsset(instrument);
    const [rules, price, balance] = await Promise.all([
      this.#symbolRules(instrument),
      reads.lastPrice(instrument),
      reads.balance(base),
    ]);
    const sellable = (quantity: Decimal.Value) => {
      const amount = floorToStep(quantity, rules.stepSize);
      return (
        amount.gt(0) &&
        amount.gte(rules.minQty) &&
        amount.times(price).gte(rules.minNotional)
      );
    };
    const held = new Decimal(assessment.sell!);
    if (!sellable(held))
      return {
        kind: "dust",
        note: `${held.toFixed()} ${base} is left, below Binance's minimum order size, so it cannot be sold.`,
      };
    // Sells refused for a rate limit are retried without counting, up to
    // the nine IDs an entry's sells can have.
    const attempt = tracked.closes.length + 1;
    const counted =
      tracked.closes.length - (tracked.reconciliation?.rateLimitedSells ?? 0);
    if (
      tracked.reconciliation?.closeBlockedAt ||
      counted >= MAX_CLOSE_ATTEMPTS ||
      attempt > MAX_SELL_IDS
    )
      // The worker has stopped selling, so no sale of its own explains a
      // lower balance: the customer sold it outside the worker.
      return sellable(new Decimal(balance.free).plus(balance.locked))
        ? { kind: "blocked", note: blockedNote(base) }
        : {
            kind: "gone",
            note: `The account no longer holds it, so it was sold outside the worker.`,
          };
    // Another worker's sale may have lowered the balance since this pass
    // read the entry, so a shortfall waits for the next pass.
    const quantity = floorToStep(
      Decimal.min(held, balance.free),
      rules.stepSize,
    );
    if (!sellable(quantity))
      return {
        kind: "waiting",
        note: `Only ${new Decimal(balance.free).toFixed()} ${base} is free to sell; other orders lock the rest, or it was sold elsewhere.`,
      };
    const order: TestnetMarketSell = {
      instrument,
      quantity: quantity.toFixed(),
      clientOrderId: closeOrderId(tracked.listClientOrderId, attempt),
    };
    const recorded = await this.#intents.record(
      scope,
      {
        kind: "exit",
        closes: tracked.listClientOrderId,
        reason: assessment.exitReason ?? "protection_failed",
        order,
      },
      "worker",
    );
    // Another worker took this attempt.
    if (!recorded) return { kind: "waiting", note: "" };
    reads.forgetBalance();
    const close = (
      intentStatus: CloseState["intentStatus"],
      placed?: TestnetOrder,
      rateLimited = false,
    ): Sale => ({
      kind: "sent",
      close: {
        clientOrderId: order.clientOrderId,
        intentStatus,
        leg: placed && toLeg(placed),
      },
      rateLimited,
      note: "",
    });
    let placed: TestnetOrder;
    try {
      placed = await this.#exchange.placeMarketSell(order);
    } catch (error) {
      const refused =
        error instanceof BinanceTestnetError &&
        (error.kind === "rejected" || error.kind === "rate_limited");
      await this.#intents
        .settle(
          scope,
          order.clientOrderId,
          refused
            ? { status: "rejected", reason: describe(error) }
            : { status: "unknown", reason: describe(error) },
        )
        .catch(() =>
          this.#warn(
            `Could not record Binance's answer for ${order.clientOrderId}.`,
          ),
        );
      this.#warn(
        `Could not sell for ${tracked.listClientOrderId}: ${describe(error)}`,
      );
      return close(
        refused ? "rejected" : "unknown",
        undefined,
        error instanceof BinanceTestnetError && error.kind === "rate_limited",
      );
    }
    this.#onChange();
    await this.#intents
      .settle(scope, order.clientOrderId, {
        status: "acknowledged",
        orders: [placed],
      })
      .catch(() =>
        this.#warn(
          `Could not record Binance's answer for ${order.clientOrderId}.`,
        ),
      );
    return close("acknowledged", placed);
  }

  async #symbolRules(instrument: TestnetInstrument) {
    const now = this.#now().getTime();
    if (!this.#rules || now - this.#rules.fetchedAt > RULES_TTL_MS) {
      const value = this.#exchange.getSymbolRules();
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

  /** Binance has no record of an acknowledged entry, as after a testnet reset. */
  #missing(scope: AccountScope, tracked: TrackedEntry) {
    return this.#store.transition(
      scope,
      tracked,
      {
        state: "missing",
        filled: tracked.reconciliation?.filledQuantity ?? "0",
        held: tracked.reconciliation?.heldQuantity ?? "0",
        firstFillAt: null,
        exitReason: null,
        detail:
          "Binance has no record of this order, which happens when the testnet is reset. The worker stopped watching it.",
      },
      async (tx, previous) => {
        if (previous?.state === "missing") return;
        await raiseNotification(tx, scope.customerId, {
          kind: "order_missing",
          severity: "warning",
          title: "Binance has no record of an order",
          body: `Binance has no record of order ${tracked.listClientOrderId} on ${pair(tracked.entry.instrument)}. The testnet resets about once a month and drops its orders. The worker stopped watching it; check your balances.`,
          data: entryData(tracked),
        });
      },
    );
  }

  /** Notifies that an exit has started and, if protection failed, pauses. */
  #exitStarted(
    scope: AccountScope,
    tracked: TrackedEntry,
    assessment: EntryAssessment,
  ): TransitionEffects {
    return async (tx, previous) => {
      if (
        previous?.exitReason &&
        !CANCEL_ONLY_REASONS.includes(previous.exitReason)
      )
        return;
      const base = baseAsset(tracked.entry.instrument);
      const held = `${new Decimal(assessment.held).toFixed()} ${base}`;
      const data = entryData(tracked, { held: assessment.held });
      if (assessment.exitReason === "protection_failed") {
        const strategy = tracked.strategy;
        if (strategy)
          await this.#pause(
            tx,
            scope,
            strategy.strategyId,
            `Protection failed for entry ${tracked.listClientOrderId}.`,
          );
        await raiseNotification(tx, scope.customerId, {
          kind: "protection_failed",
          severity: "critical",
          title: `${held} has no stop loss`,
          body: `${assessment.finding} The worker is cancelling what is left of order ${tracked.listClientOrderId} and selling the ${held} at market.${strategy ? " Its strategy is paused until you resume it." : ""}`,
          data,
        });
        return;
      }
      const kinds: Record<string, Omit<NewNotification, "data">> = {
        stop_loss: {
          kind: "stop_loss_reached",
          severity: "warning",
          title: `A partly filled entry reached its stop loss`,
          body: `${assessment.finding} The worker is cancelling the rest of order ${tracked.listClientOrderId} and selling the ${held} it bought.`,
        },
        take_profit: {
          kind: "exit_started",
          severity: "info",
          title: `Finishing a partly filled take profit`,
          body: `${assessment.finding} The worker is selling the ${held} left from order ${tracked.listClientOrderId} at market.`,
        },
      };
      await raiseNotification(tx, scope.customerId, {
        ...(kinds[assessment.exitReason!] ?? {
          kind: "exit_started",
          severity: "info",
          title: `Closing an entry: ${assessment.exitReason!.replace(/_/g, " ")}`,
          body: `The worker is cancelling order ${tracked.listClientOrderId} and selling what it holds at market.`,
        }),
        data,
      });
    };
  }

  /** Notifies of a sale finishing, failing, or the customer taking over. */
  #settled(
    scope: AccountScope,
    tracked: TrackedEntry,
    assessment: EntryAssessment,
    sale: Sale | undefined,
  ): TransitionEffects {
    return async (tx, previous) => {
      const base = baseAsset(tracked.entry.instrument);
      const data = entryData(tracked, { held: assessment.held });
      const list = tracked.listClientOrderId;
      const notify = (notification: Omit<NewNotification, "data">) =>
        raiseNotification(tx, scope.customerId, { ...notification, data });
      if (sale?.kind === "blocked" && !previous?.closeBlockedAt)
        return void (await notify({
          kind: "close_failed",
          severity: "critical",
          title: `Could not sell ${new Decimal(assessment.held).toFixed()} ${base}`,
          body: `The worker tried ${MAX_CLOSE_ATTEMPTS} market sells for order ${list} and none sold everything it holds. It has no stop loss. Sell it yourself on Binance Spot Testnet.`,
        }));
      if (previous?.state === assessment.state) return;
      if (
        assessment.state === "unprotected" &&
        assessment.exitReason !== "protection_failed"
      ) {
        if (tracked.strategy)
          await this.#pause(
            tx,
            scope,
            tracked.strategy.strategyId,
            `Binance refused the sale of entry ${list} after its exits were cancelled.`,
          );
        return void (await notify({
          kind: "protection_failed",
          severity: "critical",
          title: `${new Decimal(assessment.held).toFixed()} ${base} has no stop loss`,
          body: `The worker cancelled the exits of order ${list} to sell it (${(assessment.exitReason ?? "").replace(/_/g, " ")}), and Binance refused the sale. It has no stop loss until it is sold; the worker keeps trying.${tracked.strategy ? " Its strategy is paused until you resume it." : ""}`,
        }));
      }
      if (assessment.state === "handed_over")
        return void (await notify({
          kind: "handed_over",
          severity: "warning",
          title: `${new Decimal(assessment.held).toFixed()} ${base} is held without exits`,
          body: `You cancelled order ${list} after part of it filled, so the ${new Decimal(assessment.held).toFixed()} ${base} it bought has no take profit or stop loss. The worker leaves it to you.`,
        }));
      if (sale?.kind === "dust")
        return void (await notify({
          kind: "dust_left",
          severity: "warning",
          title: `${base} too small to sell is left`,
          body: `${sale.note} It came from order ${list} and has no stop loss.`,
        }));
      if (sale?.kind === "gone")
        return void (await notify({
          kind: "position_closed",
          severity: "info",
          title: `Order ${list} holds nothing any more`,
          body: `${sale.note} The worker stopped watching order ${list}.`,
        }));
      if (assessment.state === "closed" && assessment.exitReason)
        await notify({
          kind: "position_closed",
          severity: "info",
          title: `Sold what order ${list} held`,
          body: `The worker sold the ${base} that order ${list} held${assessment.exitReason === "holding_deadline" ? " at its holding deadline" : ""}. Check Activity for the fills.`,
        });
    };
  }

  #warn(message: string) {
    // A failing exchange or database repeats every pass, so say it once.
    if (message === this.#lastLogged) return;
    this.#lastLogged = message;
    this.#log(message);
  }
}

type Sale =
  | { kind: "sent"; close: CloseState; rateLimited: boolean; note: string }
  | { kind: "dust" | "gone" | "waiting" | "blocked"; note: string };

/** What a pass reads from Binance once, however many entries need it. */
class PassReads {
  readonly #exchange: ExecutionExchange;
  readonly #open = new Map<
    TestnetInstrument,
    Promise<Map<string, TestnetOrder>>
  >();
  readonly #prices = new Map<TestnetInstrument, Promise<string>>();
  #account?: ReturnType<ExecutionExchange["getAccount"]>;

  constructor(exchange: ExecutionExchange) {
    this.#exchange = exchange;
  }

  openOrders(instrument: TestnetInstrument) {
    let orders = this.#open.get(instrument);
    if (!orders) {
      orders = this.#exchange
        .getOpenOrders(instrument)
        .then(
          (list) => new Map(list.map((order) => [order.clientOrderId, order])),
        );
      this.#open.set(instrument, orders);
    }
    return orders;
  }

  lastPrice(instrument: TestnetInstrument) {
    let price = this.#prices.get(instrument);
    if (!price) {
      price = this.#exchange.getLastPrice(instrument);
      this.#prices.set(instrument, price);
    }
    return price;
  }

  async balance(asset: string) {
    this.#account ??= this.#exchange.getAccount();
    const found = (await this.#account).balances.find(
      (balance) => balance.asset === asset,
    );
    return { free: found?.free ?? "0", locked: found?.locked ?? "0" };
  }

  /** A sale changes the balance, so read it again before the next. */
  forgetBalance() {
    this.#account = undefined;
  }
}

function toLeg(order: TestnetOrder): LegState {
  return {
    clientOrderId: order.clientOrderId,
    orderId: order.orderId,
    orderListId: order.orderListId,
    status: order.status,
    origQty: order.origQty,
    executedQty: order.executedQty,
  };
}

/** An exit of a filled entry that Binance has no record of. */
function missingLeg(clientOrderId: string): LegState {
  return {
    clientOrderId,
    orderId: null,
    status: "MISSING",
    origQty: "0",
    executedQty: "0",
  };
}

function toFill(clientOrderId: string, fill: TestnetFill) {
  return {
    clientOrderId,
    quantity: fill.qty,
    fee: fill.commission,
    feeAsset: fill.commissionAsset,
    at: new Date(fill.time),
  };
}

/** Resolves undefined if Binance says the order does not exist. */
async function absentIfMissing<T>(request: Promise<T>) {
  try {
    return await request;
  } catch (error) {
    if (
      error instanceof BinanceTestnetError &&
      error.kind === "rejected" &&
      error.code === NO_SUCH_ORDER
    )
      return undefined;
    throw error;
  }
}

/** BTC-USDT → BTC */
function baseAsset(instrument: TestnetInstrument) {
  return instrument.split("-")[0];
}

function pair(instrument: TestnetInstrument) {
  return instrument.replace("-", "/");
}

function entryData(
  tracked: TrackedEntry,
  extra: Record<string, JSONValue> = {},
): Record<string, JSONValue> {
  return {
    orderIntentId: tracked.orderIntentId,
    listClientOrderId: tracked.listClientOrderId,
    instrument: tracked.entry.instrument,
    strategyId: tracked.strategy?.strategyId ?? null,
    ...extra,
  };
}

function blockedNote(base: string) {
  return `The worker stopped after ${MAX_CLOSE_ATTEMPTS} attempts to sell. Sell the ${base} yourself.`;
}

function deadlineReached(entry: DeadlineEntry): NewNotification {
  return {
    kind: "holding_deadline_reached",
    severity: "info",
    title: "An entry reached its holding deadline",
    body: `Order ${entry.listClientOrderId} reached its holding deadline at ${entry.deadlineAt.toISOString()}. The worker is cancelling what is left of it and selling what it holds.`,
    data: {
      orderIntentId: entry.orderIntentId,
      listClientOrderId: entry.listClientOrderId,
    },
  };
}

function exitOverdue(entry: DeadlineEntry): NewNotification {
  return {
    kind: "exit_overdue",
    severity: "critical",
    title: "An exit is overdue",
    body: `Order ${entry.listClientOrderId} passed its holding deadline at ${entry.deadlineAt.toISOString()} and still holds quantity. The worker keeps trying to sell it; check Open orders and sell it yourself if it stays.`,
    data: {
      orderIntentId: entry.orderIntentId,
      listClientOrderId: entry.listClientOrderId,
    },
  };
}

function triggerSent(
  order: ProtectedEntryOrder,
  price: string,
  outcome: ManualOrderOutcome,
): NewNotification {
  const { entry } = order;
  const data = {
    listClientOrderId: entry.listClientOrderId,
    instrument: entry.instrument,
    lastPrice: price,
    outcome: outcome.status,
  };
  if (["rejected", "invalid", "unknown"].includes(outcome.status))
    return {
      kind: "stop_limit_failed",
      severity: "warning",
      title: `Stop-limit entry on ${pair(entry.instrument)} was not sent`,
      body: `${pair(entry.instrument)} traded at ${new Decimal(price).toFixed()}, reaching the stop price, but: ${outcome.message}`,
      data,
    };
  return {
    kind: "stop_limit_sent",
    severity: "info",
    title: `Stop-limit entry on ${pair(entry.instrument)} sent`,
    body: `${pair(entry.instrument)} traded at ${new Decimal(price).toFixed()}, reaching the stop price of ${new Decimal(order.trigger!.stopPrice).toFixed()}. ${outcome.message}`,
    data,
  };
}

function triggerInterrupted(
  order: ProtectedEntryOrder,
  listClientOrderId: string,
): NewNotification {
  return {
    kind: "stop_limit_failed",
    severity: "warning",
    title: `Stop-limit entry on ${pair(order.entry.instrument)} was not sent`,
    body: `Its stop price traded, but the worker stopped before Binance received the order, so nothing was placed. Place it again if you still want it.`,
    data: { listClientOrderId, instrument: order.entry.instrument },
  };
}

/** A message safe to log: never request URLs, signatures or credentials. */
function describe(error: unknown) {
  if (error instanceof BinanceTestnetError) return error.message;
  if (error instanceof Error && error.name === "PostgresError")
    return `PostgreSQL: ${error.message}`;
  if (error instanceof Error && error.constructor === Error)
    return error.message;
  return "unexpected error";
}
