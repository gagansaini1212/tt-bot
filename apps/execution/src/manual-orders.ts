import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
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
} from "@crypto-trading/exchanges";
import type { OrderJournal } from "./order-journal";

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
const journalEntrySchema = z.object({ entry: z.object({ price: z.string() }) });
const RULES_TTL_MS = 5 * 60_000;

/**
 * Places, looks up and cancels dashboard orders. The browser's preview is
 * advisory: every placement re-runs the account limits, the per-order cap and
 * Binance's filters against fresh account data. Placements and cancels run
 * one at a time, so two orders cannot both claim the same allocation.
 */
export class ManualOrderDesk {
  readonly #exchange: ManualOrderExchange;
  readonly #config: ManualTradingConfig;
  readonly #journal: OrderJournal;
  readonly #now: () => Date;
  readonly #onChange: () => void;
  #rules?: { fetchedAt: number; value: SymbolRules[] };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    exchange: ManualOrderExchange;
    config: ManualTradingConfig;
    journal: OrderJournal;
    now?: () => Date;
    // Called after anything that may have changed the account.
    onChange?: () => void;
  }) {
    this.#exchange = options.exchange;
    this.#config = options.config;
    this.#journal = options.journal;
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
  async ticket(): Promise<ManualOrderTicket> {
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
    const entryPrices = new Map<string, string>();
    for (const order of orders) {
      const leg = protectedLeg(order.clientOrderId);
      if (!leg || entryPrices.has(leg.listClientOrderId)) continue;
      const record = journalEntrySchema.safeParse(
        await this.#journal.read(leg.listClientOrderId),
      );
      if (record.success)
        entryPrices.set(leg.listClientOrderId, record.data.entry.price);
    }
    const policy = manualTestnetPolicy(
      this.#config,
      manualExposure(orders, (id) => entryPrices.get(id)),
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

  place(raw: unknown): Promise<ManualOrderOutcome> {
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
        ticket = await this.ticket();
      } catch (error) {
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
      const intent = {
        kind: "protected_entry",
        entry,
        status: "submission_pending",
        createdAt: this.#now().toISOString(),
      };
      if (!(await this.#journal.reserve(id, intent)))
        return {
          status: "duplicate",
          listClientOrderId: id,
          message:
            "This order ID was used before, so it was not sent again. Check its status before placing another order.",
        };
      let list: TestnetOrderList | undefined;
      try {
        list = await this.#exchange.placeProtectedEntry(entry);
      } catch (error) {
        // Binance refused the request outright, so nothing was placed.
        if (
          error instanceof BinanceTestnetError &&
          (error.kind === "rejected" || error.kind === "rate_limited")
        ) {
          await this.#journal
            .update(id, { ...intent, status: "rejected" })
            .catch(() => {});
          return failure(
            error,
            "Binance rejected the order. Nothing was placed.",
          );
        }
        if (!(error instanceof BinanceTestnetError)) throw error;
        // Never resubmit. Look the order up by its client ID instead.
        list = await this.#find(id).catch(() => undefined);
      }
      this.#onChange();
      if (!list)
        return {
          status: "unknown",
          listClientOrderId: id,
          message:
            "Binance did not confirm the order, so it may or may not have been placed. Check its status before placing another order.",
        };
      // The intent already blocks this ID, so a failed update is safe.
      await this.#journal
        .update(id, {
          ...intent,
          status: "acknowledged",
          orderListId: list.orderListId,
        })
        .catch(() => {});
      return this.#describe(entry);
    });
  }

  /** Looks an order up by the client ID it was submitted with. */
  async status(listClientOrderId: unknown): Promise<ManualOrderOutcome> {
    const id = listClientOrderIdSchema.safeParse(listClientOrderId);
    if (!id.success)
      return { status: "invalid", message: "The order ID is invalid." };
    return this.#status(id.data);
  }

  async #status(listClientOrderId: string): Promise<ManualOrderOutcome> {
    const record = z
      .object({ entry: protectedEntrySchema })
      .safeParse(await this.#journal.read(listClientOrderId));
    if (!record.success)
      return {
        status: "not_found",
        listClientOrderId,
        message: "This dashboard has no record of that order.",
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
    if (!list)
      return {
        status: "not_found",
        listClientOrderId,
        message:
          "Binance has no order with this ID, so it was not placed. You can place a new order.",
      };
    return this.#describe(record.data.entry);
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
  async #describe(entry: ProtectedEntry): Promise<ManualOrderOutcome> {
    try {
      return await this.#read(entry);
    } catch {
      return {
        listClientOrderId: entry.listClientOrderId,
        status: "unverified",
        message:
          "Binance accepted the order, but its status could not be read. Check the Open orders table before placing another order.",
      };
    }
  }

  async #read(entry: ProtectedEntry): Promise<ManualOrderOutcome> {
    const legs = protectedLegIds(entry.listClientOrderId);
    const amount = (value: string) => new Decimal(value).toFixed();
    const order = (clientOrderId: string) =>
      this.#exchange.getOrder(entry.instrument, clientOrderId);
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

  cancel(raw: unknown): Promise<ManualOrderOutcome> {
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
      try {
        if (target.orderListId >= 0)
          await this.#exchange.cancelOrderList(
            request.instrument,
            target.orderListId,
          );
        else
          await this.#exchange.cancelOrderById(
            request.instrument,
            target.orderId,
          );
      } catch (error) {
        this.#onChange();
        return failure(
          error,
          "Binance did not cancel the order. It may have filled or been cancelled already.",
          "Binance did not confirm the cancel. Refresh to see whether the order is still open.",
        );
      }
      this.#onChange();
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
