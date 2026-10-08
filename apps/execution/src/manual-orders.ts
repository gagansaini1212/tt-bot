import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import {
  binanceSymbol,
  BinanceTestnetError,
  cancelImpact,
  listClientOrderIdSchema,
  manualCancelRequestSchema,
  manualExposure,
  manualOrderRequestSchema,
  manualTestnetPolicy,
  manualTradingConfigSchema,
  planManualOrder,
  protectedEntrySchema,
  protectedLeg,
  protectedLegIds,
  testnetInstrumentSchema,
  type BinanceSpotTestnet,
  type ManualOrderOutcome,
  type ManualOrderTicket,
  type ManualTradingConfig,
  type ProtectedEntry,
  type SymbolRules,
  type TestnetInstrument,
  type TestnetOrder,
  type TestnetOrderList,
  type TestnetOrderListReport,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import {
  UNCONFIRMED_GRACE_MS,
  type OrderIntentStore,
  type Settlement,
} from "./order-intents";

export type ManualOrderExchange = Pick<
  BinanceSpotTestnet,
  | "getAccount"
  | "getOpenOrders"
  | "getOpenOrderLists"
  | "getOrder"
  | "getOrderList"
  | "getSymbolRules"
  | "getDepth"
  | "testProtectedEntry"
  | "placeProtectedEntry"
  | "cancelOrderList"
  | "cancelOrderById"
>;

const decimalPattern = /^\d+(\.\d+)?$/;
const MAX_MARKET_SLIPPAGE_PERCENT = 5;

/**
 * Reads the manual-trading limits. Every limit must be set explicitly: a
 * missing value turns dashboard orders off instead of falling back.
 */
export function loadManualTradingConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; config: ManualTradingConfig } | { ok: false; message: string } {
  const off = (message: string) => ({ ok: false as const, message });
  const instruments = (env.TESTNET_MANUAL_INSTRUMENTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !instruments.length ||
    !instruments.every(
      (value) => testnetInstrumentSchema.safeParse(value).success,
    )
  )
    return off(
      "Set TESTNET_MANUAL_INSTRUMENTS to BTC-USDT, ETH-USDT or both in the execution worker to place orders from the dashboard.",
    );
  const allocation = env.TESTNET_MANUAL_ALLOCATION_USDT ?? "";
  if (!decimalPattern.test(allocation) || !new Decimal(allocation).gt(0))
    return off(
      "Set a positive TESTNET_MANUAL_ALLOCATION_USDT in the execution worker to place orders from the dashboard.",
    );
  const cap = env.TESTNET_MAX_ORDER_NOTIONAL_USDT ?? "";
  if (!decimalPattern.test(cap) || !new Decimal(cap).gt(0))
    return off(
      "Set a positive TESTNET_MAX_ORDER_NOTIONAL_USDT in the execution worker to place orders from the dashboard.",
    );
  const slippage = env.TESTNET_MARKET_MAX_SLIPPAGE_PERCENT?.trim();
  if (
    slippage &&
    (!decimalPattern.test(slippage) ||
      !new Decimal(slippage).gt(0) ||
      new Decimal(slippage).gt(MAX_MARKET_SLIPPAGE_PERCENT))
  )
    return off(
      `TESTNET_MARKET_MAX_SLIPPAGE_PERCENT must be above 0 and at most ${MAX_MARKET_SLIPPAGE_PERCENT}. Leave it empty to turn market orders off.`,
    );
  return {
    ok: true,
    config: manualTradingConfigSchema.parse({
      allowedInstruments: [...new Set(instruments)],
      allocation,
      maxOrderNotional: cap,
      marketSlippage: slippage
        ? new Decimal(slippage).dividedBy(100).toFixed()
        : null,
    }),
  };
}

// Binance's code for an order or order list that does not exist.
const NO_SUCH_ORDER = -2013;
const RULES_TTL_MS = 5 * 60_000;

/**
 * Places, looks up and cancels dashboard orders. The browser's preview is
 * advisory: every placement re-runs the account limits, the per-order cap and
 * Binance's filters against fresh account data. Placements and cancels run
 * one at a time, so two orders cannot both claim the same allocation. Each
 * call acts for the customer who owns `scope`'s exchange account, and keeps
 * its order intents in that customer's scope.
 */
export class ManualOrderDesk {
  readonly #exchange: ManualOrderExchange;
  readonly #config: ManualTradingConfig;
  readonly #intents: OrderIntentStore;
  readonly #now: () => Date;
  readonly #onChange: () => void;
  #rules?: { fetchedAt: number; value: SymbolRules[] };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    exchange: ManualOrderExchange;
    config: ManualTradingConfig;
    intents: OrderIntentStore;
    now?: () => Date;
    // Called after anything that may have changed the account.
    onChange?: () => void;
  }) {
    this.#exchange = options.exchange;
    this.#config = options.config;
    this.#intents = options.intents;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => {});
  }

  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #symbolRules() {
    const now = this.#now().getTime();
    if (!this.#rules || now - this.#rules.fetchedAt > RULES_TTL_MS)
      this.#rules = {
        fetchedAt: now,
        value: await this.#exchange.getSymbolRules(),
      };
    return this.#rules.value;
  }

  /** Fresh account limits, balances and market rules for an order. */
  async ticket(scope: AccountScope): Promise<ManualOrderTicket> {
    const [account, orders, rules, asks] = await Promise.all([
      this.#exchange.getAccount(),
      Promise.all(
        testnetInstrumentSchema.options.map((instrument) =>
          this.#exchange.getOpenOrders(instrument),
        ),
      ).then((lists) => lists.flat()),
      this.#symbolRules(),
      Promise.all(
        this.#config.allowedInstruments.map(
          async (instrument) =>
            [
              instrument,
              // A reference price. Without one, only market entries stop.
              await this.#exchange
                .getDepth(instrument, 5)
                .then((book) => book.asks[0]?.price ?? null)
                .catch(() => null),
            ] as const,
        ),
      ).then((entries) => new Map(entries)),
    ]);
    const entryPrices = await this.#intents.entryPrices(scope, [
      ...new Set(
        orders.flatMap(
          (order) => protectedLeg(order.clientOrderId)?.listClientOrderId ?? [],
        ),
      ),
    ]);
    const exposure = manualExposure(orders, (id) => entryPrices.get(id));
    // Stop-limit entries the worker holds will spend their value when they
    // trigger, so they reserve it now.
    const held = (await this.#intents.pendingTriggers(scope)).reduce(
      (total, intent) =>
        intent.order.kind === "protected_entry"
          ? total.plus(
              new Decimal(intent.order.entry.quantity).times(
                intent.order.entry.price,
              ),
            )
          : total,
      new Decimal(0),
    );
    const policy = manualTestnetPolicy(
      this.#config,
      {
        committedCapital: exposure.committedCapital,
        reservedBudget: held.plus(exposure.reservedBudget).toFixed(),
      },
      scope,
    );
    return {
      capturedAt: this.#now().toISOString(),
      policy,
      maxOrderNotional: this.#config.maxOrderNotional,
      marketSlippage: this.#config.marketSlippage,
      freeUsdt:
        account.balances.find((balance) => balance.asset === "USDT")?.free ??
        "0",
      markets: rules
        .filter((rule) => policy.allowedInstruments.includes(rule.instrument))
        .map((rule) => ({
          rules: rule,
          bestAsk: asks.get(rule.instrument) ?? null,
        })),
    };
  }

  place(scope: AccountScope, raw: unknown): Promise<ManualOrderOutcome> {
    const parsed = manualOrderRequestSchema.safeParse(raw);
    if (!parsed.success)
      return Promise.resolve({
        status: "invalid",
        message:
          "The order is incomplete or invalid. Enter a quantity, a stop loss and a take profit.",
      });
    const request = parsed.data;
    const id = request.listClientOrderId;
    return this.#exclusive(async () => {
      let ticket: ManualOrderTicket;
      try {
        ticket = await this.ticket(scope);
      } catch (error) {
        // Such as the database failing while it reads entry prices.
        if (!(error instanceof BinanceTestnetError))
          return {
            status: "rejected",
            message:
              "The worker could not check this order, so nothing was sent. Check the execution worker and try again.",
          };
        return failure(error, "Binance rejected the account lookup.");
      }
      const plan = planManualOrder(request, ticket, this.#now(), {
        proposalId: randomUUID(),
        sourceSnapshotId: randomUUID(),
      });
      if (!plan.passed || !plan.entry)
        return {
          status: "rejected",
          message: "The worker's checks rejected this order. Nothing was sent.",
          checks: plan.checks,
        };
      const entry = protectedEntrySchema.parse(plan.entry);
      try {
        await this.#exchange.testProtectedEntry(entry);
      } catch (error) {
        return failure(error, "Binance rejected the entry. Nothing was sent.");
      }
      if (request.type === "stop_limit")
        return this.#hold(scope, entry, request.stopPrice);
      let recorded: boolean;
      try {
        recorded = await this.#intents.record(
          scope,
          { kind: "protected_entry", entry },
          "dashboard",
        );
      } catch {
        return {
          status: "rejected",
          message:
            "The order could not be saved, so nothing was sent. Check the execution worker's database and try again.",
        };
      }
      if (!recorded)
        return {
          status: "duplicate",
          listClientOrderId: id,
          message:
            "This order ID was used before, so it was not sent again. Check its status before placing another order.",
        };
      return this.#send(scope, entry);
    });
  }

  /** Saves a stop-limit entry for the worker to send once its stop trades. */
  async #hold(
    scope: AccountScope,
    entry: ProtectedEntry,
    stopPrice: string,
  ): Promise<ManualOrderOutcome> {
    const id = entry.listClientOrderId;
    let held: boolean;
    try {
      held = await this.#intents.hold(
        scope,
        { kind: "protected_entry", entry, trigger: { stopPrice } },
        "dashboard",
      );
    } catch {
      return {
        status: "rejected",
        message:
          "The stop-limit entry could not be saved, so the worker is not holding it. Check the execution worker's database and try again.",
      };
    }
    if (!held)
      return {
        status: "duplicate",
        listClientOrderId: id,
        message:
          "This order ID was used before, so it was not saved again. Check its status before placing another order.",
      };
    this.#onChange();
    return heldOutcome(entry, stopPrice);
  }

  /**
   * Sends a stop-limit entry whose stop price has traded. Only one worker can
   * claim it. Every check runs again with fresh account data first; if one
   * fails, nothing is sent and the entry is rejected. If the checks cannot
   * run, it is held again and the error is thrown. Resolves undefined if the
   * entry was no longer pending.
   */
  submitTrigger(
    scope: AccountScope,
    listClientOrderId: string,
  ): Promise<ManualOrderOutcome | undefined> {
    return this.#exclusive(async () => {
      const intent = await this.#intents.claimTrigger(scope, listClientOrderId);
      if (intent?.order.kind !== "protected_entry") return undefined;
      const { entry } = intent.order;
      let plan: ReturnType<typeof planManualOrder>;
      try {
        plan = planManualOrder(
          {
            type: "limit",
            instrument: entry.instrument,
            quantity: entry.quantity,
            price: entry.price,
            takeProfitPrice: entry.takeProfitPrice,
            stopLossPrice: entry.stopLossPrice,
            listClientOrderId,
          },
          await this.ticket(scope),
          this.#now(),
          { proposalId: randomUUID(), sourceSnapshotId: randomUUID() },
        );
      } catch (error) {
        // Nothing was sent, so the entry waits for a later pass. If even
        // this fails, reconciliation finds it unsent and rejects it.
        await this.#intents.releaseTrigger(scope, listClientOrderId);
        throw error;
      }
      if (!plan.passed) {
        const failed = plan.checks.filter((check) => !check.passed);
        await this.#settle(scope, listClientOrderId, {
          status: "rejected",
          reason: failed.map((check) => check.detail).join(" "),
        });
        return {
          status: "rejected",
          listClientOrderId,
          message:
            "The stop price traded, but the entry failed the worker's checks, so nothing was sent.",
          checks: plan.checks,
        };
      }
      return this.#send(scope, entry);
    });
  }

  /** Cancels a stop-limit entry the worker holds. */
  cancelTrigger(
    scope: AccountScope,
    listClientOrderId: unknown,
  ): Promise<ManualOrderOutcome> {
    const id = listClientOrderIdSchema.safeParse(listClientOrderId);
    if (!id.success)
      return Promise.resolve({
        status: "invalid",
        message: "The order ID is invalid.",
      });
    return this.#exclusive(async () => {
      if (await this.#intents.cancelTrigger(scope, id.data)) {
        this.#onChange();
        return {
          status: "cancelled",
          listClientOrderId: id.data,
          message:
            "Cancelled the stop-limit entry. Nothing had been sent to Binance.",
        };
      }
      return {
        status: "not_open",
        listClientOrderId: id.data,
        message:
          "This stop-limit entry is no longer held. If its stop price traded, it is on Binance now: refresh and cancel it from the Open orders table.",
      };
    });
  }

  /** Sends a saved entry and records Binance's answer. */
  async #send(
    scope: AccountScope,
    entry: ProtectedEntry,
  ): Promise<ManualOrderOutcome> {
    const id = entry.listClientOrderId;
    let list: TestnetOrderList | TestnetOrderListReport | undefined;
    try {
      list = await this.#exchange.placeProtectedEntry(entry);
    } catch (error) {
      // Binance refused the request outright, so nothing was placed.
      if (
        error instanceof BinanceTestnetError &&
        (error.kind === "rejected" || error.kind === "rate_limited")
      ) {
        await this.#settle(scope, id, {
          status: "rejected",
          reason: error.message,
        });
        return failure(
          error,
          "Binance rejected the order. Nothing was placed.",
        );
      }
      if (!(error instanceof BinanceTestnetError)) {
        await this.#settle(scope, id, { status: "unknown" });
        throw error;
      }
      // Never resubmit. Look the order up by its client ID instead.
      list = await this.#find(id).catch(() => undefined);
    }
    this.#onChange();
    if (!list) {
      await this.#settle(scope, id, { status: "unknown" });
      return {
        status: "unknown",
        listClientOrderId: id,
        message:
          "Binance did not confirm the order, so it may or may not have been placed. Check its status before placing another order.",
      };
    }
    await this.#settle(scope, id, {
      status: "acknowledged",
      orderListId: list.orderListId,
      orders: "orderReports" in list ? list.orderReports : undefined,
    });
    return this.#describe(scope, entry);
  }

  /**
   * Records Binance's answer. The saved intent already blocks its client ID,
   * so a failure here cannot lead to a second submission; an unsettled intent
   * stays due for reconciliation.
   */
  async #settle(
    scope: AccountScope,
    listClientOrderId: string,
    settlement: Settlement,
  ) {
    try {
      await this.#intents.settle(scope, listClientOrderId, settlement);
    } catch {
      console.error(
        `Could not record Binance's answer for ${listClientOrderId}. Its intent stays due for reconciliation.`,
      );
    }
  }

  /** Keeps Binance's report of each order. A failure leaves only a log line. */
  async #recordOrders(
    scope: AccountScope,
    orders: TestnetOrder[],
    event?: "order.cancelled",
  ) {
    try {
      await this.#intents.recordOrders(scope, orders, event);
    } catch {
      console.error(
        `Could not record Binance's report of ${orders.map((order) => order.clientOrderId).join(", ")}.`,
      );
    }
  }

  /** Looks an order up by the client ID it was submitted with. */
  async status(
    scope: AccountScope,
    listClientOrderId: unknown,
  ): Promise<ManualOrderOutcome> {
    const id = listClientOrderIdSchema.safeParse(listClientOrderId);
    if (!id.success)
      return { status: "invalid", message: "The order ID is invalid." };
    // Waits for a placement still in flight, so it cannot report that order
    // as missing while it is being sent.
    return this.#exclusive(() => this.#status(scope, id.data));
  }

  async #status(
    scope: AccountScope,
    listClientOrderId: string,
  ): Promise<ManualOrderOutcome> {
    const intent = await this.#intents.find(scope, listClientOrderId);
    if (intent?.order.kind !== "protected_entry")
      return {
        status: "not_found",
        listClientOrderId,
        message: "This dashboard has no record of that order.",
      };
    if (intent.status === "pending" && intent.order.trigger)
      return heldOutcome(intent.order.entry, intent.order.trigger.stopPrice);
    if (intent.status === "cancelled")
      return {
        status: "cancelled",
        listClientOrderId,
        message:
          "The stop-limit entry was cancelled before its stop price traded, so nothing was sent.",
      };
    let list: TestnetOrderList | undefined;
    try {
      list = await this.#find(listClientOrderId);
    } catch {
      return {
        status: "unknown",
        listClientOrderId,
        message:
          "Binance could not be reached, so the order's status is still unknown. Try again shortly.",
      };
    }
    // Binance can still be executing a submission it did not confirm, so a
    // recent one is not called missing yet.
    const unconfirmed =
      intent.status === "submitting" || intent.status === "unknown";
    if (
      !list &&
      unconfirmed &&
      this.#now().getTime() - intent.createdAt.getTime() < UNCONFIRMED_GRACE_MS
    )
      return {
        status: "unknown",
        listClientOrderId,
        message:
          "Binance has no record of this order yet. Check again in a minute before placing another order.",
      };
    // The intent stays as it is: its ID remains used, and only a
    // reconciliation may decide that an unknown outcome was a failure.
    if (!list)
      return {
        status: "not_found",
        listClientOrderId,
        message:
          "Binance has no order with this ID, so it was not placed. You can place a new order.",
      };
    if (unconfirmed)
      await this.#settle(scope, listClientOrderId, {
        status: "acknowledged",
        orderListId: list.orderListId,
      });
    return this.#describe(scope, intent.order.entry);
  }

  async #find(listClientOrderId: string) {
    try {
      return await this.#exchange.getOrderList(listClientOrderId);
    } catch (error) {
      // Only "does not exist" proves Binance has no such list. Any other
      // rejection, such as a signature or clock error, leaves it unknown.
      if (
        error instanceof BinanceTestnetError &&
        error.kind === "rejected" &&
        error.code === NO_SUCH_ORDER
      )
        return undefined;
      throw error;
    }
  }

  /**
   * Reports the entry's state and confirms its exits on the exchange. It runs
   * after Binance accepted the order, so a failed read must never look like a
   * failed placement.
   */
  async #describe(
    scope: AccountScope,
    entry: ProtectedEntry,
  ): Promise<ManualOrderOutcome> {
    try {
      return await this.#read(scope, entry);
    } catch {
      return {
        listClientOrderId: entry.listClientOrderId,
        status: "unverified",
        message:
          "Binance accepted the order, but its status could not be read. Check the Open orders table before placing another order.",
      };
    }
  }

  async #read(
    scope: AccountScope,
    entry: ProtectedEntry,
  ): Promise<ManualOrderOutcome> {
    const legs = protectedLegIds(entry.listClientOrderId);
    const amount = (value: string) => new Decimal(value).toFixed();
    // Keeps each leg's latest state. The order is on Binance either way, so
    // a failed write must not hide that.
    const order = async (clientOrderId: string) => {
      const read = await this.#exchange.getOrder(
        entry.instrument,
        clientOrderId,
      );
      await this.#recordOrders(scope, [read]);
      return read;
    };
    const base = { listClientOrderId: entry.listClientOrderId };
    const working = await order(legs.entry);
    if (working.status === "NEW")
      return {
        ...base,
        status: "working",
        message:
          "The entry is on the book. Binance places the take profit and stop loss when it fills completely.",
      };
    if (working.status === "PARTIALLY_FILLED")
      return {
        ...base,
        status: "working",
        unprotectedQuantity: amount(working.executedQty),
        message: `The entry has partly filled. The ${amount(working.executedQty)} bought so far has no exits until the entry fills completely.`,
      };
    if (working.status !== "FILLED")
      return {
        ...base,
        status: "not_filled",
        message:
          entry.timeInForce === "FOK"
            ? `Nothing was bought: the order could not fill completely at or below ${entry.price}.`
            : `The entry was ${working.status.toLowerCase().replace(/_/g, " ")} before it filled, so nothing is held.`,
      };
    // An entry that fills at once can report its exits before Binance
    // places them, so read them again.
    let exits = await Promise.all([
      order(legs.takeProfit),
      order(legs.stopLoss),
    ]);
    if (exits.some((exit) => exit.status === "PENDING_NEW"))
      exits = await Promise.all([order(legs.takeProfit), order(legs.stopLoss)]);
    if (exits.every((exit) => exit.status === "NEW"))
      return {
        ...base,
        status: "protected",
        message: `Bought ${amount(working.executedQty)}. The take profit at ${entry.takeProfitPrice} and stop loss at ${entry.stopLossPrice} are on Binance.`,
      };
    if (exits.some((exit) => exit.status === "FILLED"))
      return {
        ...base,
        status: "closed",
        message:
          "The entry filled and one of its exits has already closed the position.",
      };
    if (
      exits.some(
        (exit) =>
          exit.status === "PENDING_NEW" || exit.status === "PARTIALLY_FILLED",
      )
    )
      return {
        ...base,
        status: "unverified",
        unprotectedQuantity: amount(working.executedQty),
        message: `Bought ${amount(working.executedQty)}, but Binance has not confirmed both exits yet. Check the Open orders table now.`,
      };
    return {
      ...base,
      status: "protection_failed",
      unprotectedQuantity: amount(working.executedQty),
      message: `Bought ${amount(working.executedQty)}, but Binance did not place the take profit and stop loss (${exits.map((exit) => exit.status).join(", ")}). This position has no exits. Sell it now, for example with pnpm exchange place-order, or set exits yourself.`,
    };
  }

  cancel(scope: AccountScope, raw: unknown): Promise<ManualOrderOutcome> {
    const parsed = manualCancelRequestSchema.safeParse(raw);
    if (!parsed.success)
      return Promise.resolve({
        status: "invalid",
        message: "The cancel request is invalid.",
      });
    const request = parsed.data;
    return this.#exclusive(async () => {
      const [open, lists] = await Promise.all([
        this.#exchange.getOpenOrders(request.instrument),
        this.#exchange.getOpenOrderLists(),
      ]);
      const target = resolveTarget(
        request.instrument,
        request.orderId,
        open,
        lists,
      );
      if (!target)
        return {
          status: "not_open",
          message:
            "This order is no longer open. Refresh to see its latest state.",
        };
      const { unprotectedQuantity } = cancelImpact(target, open);
      if (new Decimal(unprotectedQuantity).gt(0) && !request.acceptUnprotected)
        return {
          status: "confirmation_required",
          unprotectedQuantity,
          message: `Cancelling this order list leaves ${unprotectedQuantity} without a take profit or stop loss. Confirm to cancel anyway.`,
        };
      // Noted first, so the worker's loop never mistakes this cancel for a
      // failure and sells what the customer chose to keep.
      const listClientOrderId = new Decimal(unprotectedQuantity).gt(0)
        ? protectedLeg(target.clientOrderId)?.listClientOrderId
        : undefined;
      if (listClientOrderId)
        await this.#intents.noteCustomerCancel(
          scope,
          listClientOrderId,
          unprotectedQuantity,
        );
      let cancelled: TestnetOrder[];
      try {
        cancelled =
          target.orderListId >= 0
            ? (
                await this.#exchange.cancelOrderList(
                  request.instrument,
                  target.orderListId,
                )
              ).orderReports
            : [
                await this.#exchange.cancelOrderById(
                  request.instrument,
                  target.orderId,
                ),
              ];
      } catch (error) {
        this.#onChange();
        if (
          listClientOrderId &&
          error instanceof BinanceTestnetError &&
          error.kind !== "unknown_outcome"
        )
          await this.#intents
            .noteCustomerCancel(scope, listClientOrderId, null)
            .catch(() => {});
        return failure(
          error,
          "Binance did not cancel the order. It may have filled or been cancelled already.",
          "Binance did not confirm the cancel. Refresh to see whether the order is still open.",
        );
      }
      this.#onChange();
      await this.#recordOrders(scope, cancelled, "order.cancelled");
      return {
        status: "cancelled",
        unprotectedQuantity,
        message:
          target.orderListId >= 0
            ? new Decimal(unprotectedQuantity).gt(0)
              ? `Cancelled the order list. ${unprotectedQuantity} is held without exits.`
              : "Cancelled every order in the list."
            : "Cancelled the order.",
      };
    });
  }
}

function heldOutcome(
  entry: ProtectedEntry,
  stopPrice: string,
): ManualOrderOutcome {
  return {
    status: "held",
    listClientOrderId: entry.listClientOrderId,
    message: `The worker holds this stop-limit entry. When ${entry.instrument.replace("-", "/")} trades at or above ${new Decimal(stopPrice).toFixed()}, it checks the order again and sends a limit buy at ${new Decimal(entry.price).toFixed()} with its take profit and stop loss.`,
  };
}

function resolveTarget(
  instrument: TestnetInstrument,
  orderId: number,
  open: TestnetOrder[],
  lists: TestnetOrderList[],
) {
  const order = open.find((entry) => entry.orderId === orderId);
  if (order) return order;
  // A leg Binance holds back until the entry fills may not be listed as open.
  const list = lists.find(
    (entry) =>
      entry.symbol === binanceSymbol(instrument) &&
      entry.orders.some((leg) => leg.orderId === orderId),
  );
  return list && open.find((entry) => entry.orderListId === list.orderListId);
}

function failure(
  error: unknown,
  rejected: string,
  unknown = "Binance did not confirm the request. Refresh before trying again.",
): ManualOrderOutcome {
  if (!(error instanceof BinanceTestnetError)) throw error;
  switch (error.kind) {
    case "rejected":
      return {
        status: "rejected",
        message: error.reason
          ? `${rejected} Binance: ${error.reason}`
          : rejected,
      };
    case "rate_limited":
      return {
        status: "rejected",
        message: `Binance is limiting requests, so nothing was sent. Try again in ${error.retryAfterSeconds ?? 60} seconds.`,
      };
    case "unavailable":
      return {
        status: "rejected",
        message:
          "Binance could not be reached, so nothing was sent. Try again shortly.",
      };
    case "unknown_outcome":
      return { status: "unknown", message: unknown };
  }
}
