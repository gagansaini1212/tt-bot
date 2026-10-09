// Browser-safe: the order drawer runs this plan as an advisory preview, and
// the worker runs it again with fresh account data before every submission.
import Decimal from "decimal.js";
import { z } from "zod";
import {
  allowedInstrumentsSchema,
  authorizeTradeProposal,
  executionPolicySchema,
  instrumentLabel,
  instrumentSchema,
  type AccountAccess,
  type ExecutionPolicy,
  type TradeProposal,
} from "@crypto-trading/domain";
import { exchangeIdSchema, type ExchangeOrder } from "./contract";
import { marketRulesSchema } from "./market-catalogue";
import {
  floorToStep,
  isStrategyListId,
  listClientOrderIdSchema,
  protectedEntryFilterIssues,
  protectedLeg,
  type ProtectedEntry,
} from "./order-rules";

const decimal = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+)?$/);
const amount = decimal.refine((value) => /[1-9]/.test(value));

const orderFields = {
  instrument: instrumentSchema,
  quantity: amount,
  stopLossPrice: amount,
  takeProfitPrice: amount,
  // Chosen by the browser once per order, so a repeated request cannot
  // place a second order. Strategies' IDs are reserved for them.
  listClientOrderId: listClientOrderIdSchema.refine(
    (id) => !isStrategyListId(id),
  ),
};
/**
 * A buy from the order drawer. Spot is long only, so there is no side. A
 * stop-limit entry is held by the worker until the market trades at or above
 * its stop price, then sent as a limit entry with its exits.
 */
export const manualOrderRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("limit"), price: amount, ...orderFields }),
  z.strictObject({ type: z.literal("market"), ...orderFields }),
  z.strictObject({
    type: z.literal("stop_limit"),
    stopPrice: amount,
    price: amount,
    ...orderFields,
  }),
]);
export type ManualOrderRequest = z.infer<typeof manualOrderRequestSchema>;

export const manualCancelRequestSchema = z.strictObject({
  instrument: instrumentSchema,
  // The venue's order ID, as the snapshot reports it.
  orderId: exchangeIdSchema,
  // Required when the cancel leaves a filled quantity without exits.
  acceptUnprotected: z.boolean(),
});
export type ManualCancelRequest = z.infer<typeof manualCancelRequestSchema>;

const manualOrderCheckSchema = z.object({
  name: z.enum(["price", "limits", "cap", "daily_risk", "filters", "balance"]),
  label: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type ManualOrderCheck = z.infer<typeof manualOrderCheckSchema>;

/** What the dashboard shows after a placement, status lookup or cancel. */
export const manualOrderOutcomeSchema = z.object({
  status: z.enum([
    // Nothing was sent.
    "invalid",
    "rejected",
    "duplicate",
    "not_found",
    "confirmation_required",
    "not_open",
    // The worker cannot tell whether Binance acted. Look the order up.
    "unknown",
    "unverified",
    // The worker holds a stop-limit entry until its stop price trades.
    "held",
    // Binance acted.
    "working",
    "protected",
    "closed",
    "not_filled",
    "protection_failed",
    "cancelled",
  ]),
  message: z.string().max(500),
  listClientOrderId: listClientOrderIdSchema.optional(),
  unprotectedQuantity: decimal.optional(),
  checks: z.array(manualOrderCheckSchema).optional(),
});
export type ManualOrderOutcome = z.infer<typeof manualOrderOutcomeSchema>;

// Manual orders belong to no strategy, so they share this fixed one. It
// grants nothing: every limit comes from the worker's configuration and the
// customer's risk limits.
export const MANUAL_TESTNET_STRATEGY = {
  strategyId: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a03",
  strategyVersion: 1,
} as const;

export const manualTradingConfigSchema = z.object({
  allowedInstruments: allowedInstrumentsSchema,
  allocation: amount,
  // From the customer's risk limits; the rest is the worker's configuration.
  maxOrderNotional: amount,
  // Share of the best ask a market entry may pay above it. Null turns
  // market entries off.
  marketSlippage: decimal.nullable(),
});
export type ManualTradingConfig = z.infer<typeof manualTradingConfigSchema>;

/**
 * The customer's limits for their manual orders, set on the Settings page.
 * Amounts are in USDT, the testnet account's accounting currency. Each change
 * is a new version; the worker reads the latest one before every order.
 */
const usdtLimit = z
  .string()
  .max(21)
  .regex(/^\d{1,12}(\.\d{1,8})?$/)
  .refine((value) => /[1-9]/.test(value));
export const manualRiskLimitsSchema = z.strictObject({
  // The largest order, which is also the largest position.
  maxOrderNotional: usdtLimit,
  // The most the day's orders may lose at their stop losses, a CLI buy,
  // which has no stop, counting in full. Reaching it refuses new orders; it
  // is not a strategy's loss limit.
  maxDailyRisk: usdtLimit,
  // The order drawer suggests a stop loss this far below the entry.
  defaultStopLossPercent: z
    .string()
    .max(5)
    .regex(/^\d{1,2}(\.\d{1,2})?$/)
    .refine((value) => /[1-9]/.test(value)),
});
export type ManualRiskLimits = z.infer<typeof manualRiskLimitsSchema>;

/** The loss if a protected entry's stop fills at its price, before fees. */
export function stopLossRisk(
  entry: Pick<ProtectedEntry, "price" | "stopLossPrice" | "quantity">,
) {
  return Decimal.max(
    new Decimal(entry.price).minus(entry.stopLossPrice),
    0,
  ).times(entry.quantity);
}

/**
 * The stop loss `percent` below `entryPrice`, rounded up to the tick so it
 * never risks more than that percentage. Undefined if that leaves no room
 * below the entry.
 */
export function defaultStopLossPrice(
  entryPrice: string,
  percent: string,
  tickSize: string,
) {
  const raw = new Decimal(entryPrice).times(
    new Decimal(1).minus(new Decimal(percent).dividedBy(100)),
  );
  const step = new Decimal(tickSize);
  const stop = step.isZero() ? raw : raw.dividedBy(step).ceil().times(step);
  return stop.greaterThan(0) && stop.lessThan(entryPrice)
    ? stop.toFixed()
    : undefined;
}

/**
 * The accounting currency of the manual allocation and risk limits. Only
 * markets quoted in it pass the checks.
 */
export const MANUAL_ACCOUNTING_CURRENCY = "USDT";

/**
 * The limits for `account`'s manual orders. `accountAccess` comes from its
 * venue: a read-only exchange account takes no orders.
 */
export function manualTestnetPolicy(
  config: ManualTradingConfig,
  exposure: { committedCapital: string; reservedBudget: string },
  account: {
    customerId: string;
    exchangeAccountId: string;
    accountAccess: AccountAccess;
  },
): ExecutionPolicy {
  return executionPolicySchema.parse({
    customerId: account.customerId,
    exchangeAccountId: account.exchangeAccountId,
    accountAccess: account.accountAccess,
    accountingCurrency: MANUAL_ACCOUNTING_CURRENCY,
    ...MANUAL_TESTNET_STRATEGY,
    // Testnet funds are virtual, so this is simulated trading. Live trading
    // stays disabled.
    tradingMode: "simulation",
    strategyStatus: "simulation",
    liveTradingEnabled: false,
    allowedInstruments: config.allowedInstruments,
    allocation: config.allocation,
    committedCapital: exposure.committedCapital,
    reservedBudget: exposure.reservedBudget,
    maxPositionNotional: config.maxOrderNotional,
    // Spot positions are unleveraged.
    maxLeverage: 1,
  });
}

/**
 * Capital the manual allocation has tied up, read from the exchange's open
 * orders. Open buys reserve their unfilled value, and any filled part is a
 * position. A list's open exits hold a position worth its entry, read from the
 * order journal. Holdings with no open order are outside the allocation, and
 * so are a strategy's entries, which its own allocation covers.
 */
export function manualExposure(
  orders: ExchangeOrder[],
  entryPriceOf: (listClientOrderId: string) => string | undefined,
) {
  let reserved = new Decimal(0);
  let committed = new Decimal(0);
  const exits = new Map<string, ExchangeOrder[]>();
  for (const order of orders) {
    const list = protectedLeg(order.clientOrderId)?.listClientOrderId;
    if (list && isStrategyListId(list)) continue;
    if (order.side === "BUY") {
      const price = Decimal.max(order.price, order.stopPrice ?? "0");
      const filled = new Decimal(order.executedQty);
      reserved = reserved.plus(
        new Decimal(order.origQty).minus(filled).times(price),
      );
      committed = committed.plus(filled.times(price));
    } else if (order.orderListId !== null && order.status !== "PENDING_NEW") {
      const key = `${order.instrument}:${order.orderListId}`;
      exits.set(key, [...(exits.get(key) ?? []), order]);
    }
  }
  for (const legs of exits.values()) {
    const remaining = Decimal.max(
      ...legs.map((leg) => new Decimal(leg.origQty).minus(leg.executedQty)),
    );
    const listClientOrderId = legs
      .map((leg) => protectedLeg(leg.clientOrderId)?.listClientOrderId)
      .find(Boolean);
    // Without a journal entry, the highest exit price bounds the entry.
    const price =
      (listClientOrderId && entryPriceOf(listClientOrderId)) ||
      Decimal.max(
        ...legs.flatMap((leg) => [leg.price, leg.stopPrice ?? "0"]),
      ).toFixed();
    committed = committed.plus(remaining.times(price));
  }
  return {
    committedCapital: committed.toFixed(),
    reservedBudget: reserved.toFixed(),
  };
}

/** Everything the order preview needs, read by the worker. */
export const manualOrderTicketSchema = z.object({
  capturedAt: z.iso.datetime(),
  policy: executionPolicySchema,
  // The customer's current risk limits, within the platform maximums.
  riskLimits: z.object({
    version: z.int().positive(),
    maxOrderNotional: amount,
    maxDailyRisk: amount,
    defaultStopLossPercent: amount,
  }),
  // What today's earlier manual entries would lose at their stops, since
  // midnight UTC.
  dailyRiskUsed: decimal,
  marketSlippage: decimal.nullable(),
  freeUsdt: decimal,
  // The best ask is the market entry's reference and the preview's price hint.
  markets: z.array(
    z.object({ rules: marketRulesSchema, bestAsk: amount.nullable() }),
  ),
});
export type ManualOrderTicket = z.infer<typeof manualOrderTicketSchema>;

export type ManualOrderPlan = {
  passed: boolean;
  checks: ManualOrderCheck[];
  entry?: ProtectedEntry;
  notional?: string;
};

/**
 * The most a market entry pays: the best ask plus the configured slippage,
 * floored to the tick so it never exceeds that slippage.
 */
export function marketEntryPrice(
  bestAsk: string,
  slippage: string,
  tickSize: string,
) {
  return floorToStep(
    new Decimal(bestAsk).times(new Decimal(1).plus(slippage)),
    tickSize,
  ).toFixed();
}

/**
 * Runs the account-limit check from `authorizeTradeProposal`, the per-order
 * notional cap, Binance's filters and the free balance. The order may be
 * submitted only when every check passes.
 */
export function planManualOrder(
  request: ManualOrderRequest,
  ticket: ManualOrderTicket,
  now: Date,
  ids: { proposalId: string; sourceSnapshotId: string },
): ManualOrderPlan {
  const market = ticket.markets.find(
    (entry) => entry.rules.instrument === request.instrument,
  );
  const checks: ManualOrderCheck[] = [];
  let price: string;
  if (request.type !== "market") {
    price = request.price;
  } else {
    const failure = (detail: string): ManualOrderPlan => ({
      passed: false,
      checks: [{ name: "price", label: "Market price", passed: false, detail }],
    });
    if (ticket.marketSlippage === null)
      return failure(
        "Market orders are off. Set TESTNET_MARKET_MAX_SLIPPAGE_PERCENT in the execution worker to allow them.",
      );
    if (!market?.bestAsk)
      return failure("No current ask price from Binance. Refresh and retry.");
    price = marketEntryPrice(
      market.bestAsk,
      ticket.marketSlippage,
      market.rules.tickSize,
    );
    checks.push({
      name: "price",
      label: "Market price",
      passed: true,
      detail: `Pays at most ${price} USDT, ${new Decimal(ticket.marketSlippage).times(100).toFixed()}% above the best ask of ${market.bestAsk}. It fills completely now or not at all.`,
    });
  }
  if (request.type === "stop_limit")
    checks.push(stopPriceCheck(request, market));
  const entry: ProtectedEntry = {
    instrument: request.instrument,
    quantity: request.quantity,
    price,
    timeInForce: request.type === "market" ? "FOK" : "GTC",
    takeProfitPrice: request.takeProfitPrice,
    stopLossPrice: request.stopLossPrice,
    listClientOrderId: request.listClientOrderId,
  };
  const { policy } = ticket;
  return checkProtectedEntry(
    entry,
    {
      proposalId: ids.proposalId,
      customerId: policy.customerId,
      exchangeAccountId: policy.exchangeAccountId,
      strategyId: policy.strategyId,
      strategyVersion: policy.strategyVersion,
      instrument: entry.instrument,
      marketKind: "spot",
      direction: "long",
      quantity: entry.quantity,
      entryPrice: entry.price,
      stopLossPrice: entry.stopLossPrice,
      takeProfitPrice: entry.takeProfitPrice,
      leverage: 1,
      // Binance Spot has no good-till-date orders, so this bounds submission
      // only. A limit entry rests until it fills or is cancelled.
      entryExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      rationale: "Manual testnet order from the dashboard.",
      sourceSnapshotId: ids.sourceSnapshotId,
    },
    ticket,
    now,
    { earlier: checks, waitsForStop: request.type === "stop_limit" },
  );
}

/**
 * Runs `authorizeTradeProposal` for `proposal` against `policy`, the
 * ticket's unless given, then the per-order cap, the daily risk limit,
 * Binance's filters and the free balance for `entry`, the order that would
 * carry it out. `earlier` holds checks already run, such as the market price.
 * An entry that `waitsForStop` buys later, so it is not checked against the
 * best ask. The entry may be submitted only when every check passes.
 */
export function checkProtectedEntry(
  entry: ProtectedEntry,
  proposal: TradeProposal,
  ticket: ManualOrderTicket,
  now: Date,
  {
    earlier = [],
    policy = ticket.policy,
    waitsForStop = false,
  }: {
    earlier?: ManualOrderCheck[];
    policy?: ExecutionPolicy;
    waitsForStop?: boolean;
  } = {},
): ManualOrderPlan {
  const checks = [...earlier];
  const market = ticket.markets.find(
    (candidate) => candidate.rules.instrument === proposal.instrument,
  );
  // A marketable entry fills at the ask, below its limit. A stop loss at or
  // above the fill price would trigger as soon as Binance placed it. A
  // stop-limit entry buys later, and its stop price check covers this.
  const stop = new Decimal(entry.stopLossPrice);
  if (
    !waitsForStop &&
    market?.bestAsk &&
    stop.lessThan(entry.price) &&
    stop.greaterThanOrEqualTo(market.bestAsk)
  )
    checks.push({
      name: "price",
      label: "Stop loss",
      passed: false,
      detail: `The stop loss must be below the best ask of ${market.bestAsk}, where this entry would fill at once.`,
    });
  const notional = new Decimal(entry.quantity).times(entry.price);
  const authorization = authorizeTradeProposal(proposal, policy, now);
  const uncommitted = new Decimal(policy.allocation)
    .minus(policy.committedCapital)
    .minus(policy.reservedBudget);
  const allocationLeft = `${Decimal.max(uncommitted, 0).toFixed()} of ${policy.allocation} USDT in the manual testnet allocation is uncommitted.`;
  checks.push({
    name: "limits",
    label: "Account limits",
    passed: authorization.allowed,
    detail: authorization.allowed
      ? `Within limits: ${allocationLeft}`
      : authorization.code === "position_limit_exceeded"
        ? `${authorization.reason} The limit is ${policy.maxPositionNotional} USDT.`
        : authorization.code === "allocation_exceeded"
          ? `${authorization.reason} ${allocationLeft}`
          : authorization.reason,
  });
  const { riskLimits } = ticket;
  const capPassed = notional.lessThanOrEqualTo(riskLimits.maxOrderNotional);
  checks.push({
    name: "cap",
    label: "Per-order cap",
    passed: capPassed,
    detail: capPassed
      ? `${notional.toFixed()} USDT is within the ${riskLimits.maxOrderNotional} USDT cap.`
      : `${notional.toFixed()} USDT is over the ${riskLimits.maxOrderNotional} USDT cap set in Settings.`,
  });
  const risk = stopLossRisk(entry);
  const dayRisk = risk.plus(ticket.dailyRiskUsed);
  const dailyPassed = dayRisk.lessThanOrEqualTo(riskLimits.maxDailyRisk);
  checks.push({
    name: "daily_risk",
    label: "Daily risk limit",
    passed: dailyPassed,
    detail: dailyPassed
      ? `At its stop loss this order loses about ${risk.toFixed()} USDT, so today's orders risk ${dayRisk.toFixed()} of the ${riskLimits.maxDailyRisk} USDT daily risk limit.`
      : `At its stop loss this order loses about ${risk.toFixed()} USDT. Today's orders since 00:00 UTC already risk ${new Decimal(ticket.dailyRiskUsed).toFixed()} USDT, so this would go over the ${riskLimits.maxDailyRisk} USDT daily risk limit set in Settings.`,
  });
  const issues = market
    ? protectedEntryFilterIssues(entry, market.rules)
    : ["Binance's rules for this market are unavailable. Refresh and retry."];
  checks.push({
    name: "filters",
    label: "Binance filters",
    passed: issues.length === 0,
    detail:
      issues.join(" ") ||
      "The entry and both exits meet Binance's price, quantity and minimum value rules.",
  });
  const free = new Decimal(ticket.freeUsdt);
  const balancePassed = notional.lessThanOrEqualTo(free);
  checks.push({
    name: "balance",
    label: "Available USDT",
    passed: balancePassed,
    detail: balancePassed
      ? `Uses ${notional.toFixed()} of ${free.toFixed()} free USDT.`
      : `Needs ${notional.toFixed()} USDT, but ${free.toFixed()} USDT is free.`,
  });
  return {
    passed: checks.every((check) => check.passed),
    checks,
    entry,
    notional: notional.toFixed(),
  };
}

/**
 * A stop-limit entry waits for the market to rise to its stop price. A stop at
 * or below the best ask would trigger at once, and a stop loss at or above the
 * stop price would sell as soon as the entry filled there.
 */
function stopPriceCheck(
  request: Extract<ManualOrderRequest, { type: "stop_limit" }>,
  market: ManualOrderTicket["markets"][number] | undefined,
): ManualOrderCheck {
  const check = (passed: boolean, detail: string): ManualOrderCheck => ({
    name: "price",
    label: "Stop price",
    passed,
    detail,
  });
  const stop = new Decimal(request.stopPrice);
  if (!market?.bestAsk)
    return check(
      false,
      "No current ask price from Binance. Refresh and retry.",
    );
  if (stop.lessThanOrEqualTo(market.bestAsk))
    return check(
      false,
      `The stop price must be above the best ask of ${market.bestAsk}, or the entry would trigger at once. Use a limit order to buy now.`,
    );
  if (stop.lessThanOrEqualTo(request.stopLossPrice))
    return check(
      false,
      "The stop loss must be below the stop price, where the entry starts to buy.",
    );
  return check(
    true,
    `The worker holds this entry and sends it with its exits once ${instrumentLabel(request.instrument)} trades at or above ${stop.toFixed()}.`,
  );
}

/**
 * What cancelling an open order does. Binance cancels a whole order list when
 * any order in it is cancelled. If that list's entry has filled, even partly,
 * the filled quantity is left without a take profit or stop loss.
 */
export function cancelImpact(target: ExchangeOrder, orders: ExchangeOrder[]) {
  const cancels =
    target.orderListId === null
      ? [target]
      : orders.filter(
          (order) =>
            order.instrument === target.instrument &&
            order.orderListId === target.orderListId,
        );
  const entry = cancels.find((order) => order.side === "BUY");
  const activeExits = cancels.filter(
    (order) => order.side === "SELL" && order.status !== "PENDING_NEW",
  );
  const unprotected =
    target.orderListId === null
      ? new Decimal(0)
      : entry
        ? new Decimal(entry.executedQty)
        : Decimal.max(
            0,
            ...activeExits.map((leg) =>
              new Decimal(leg.origQty).minus(leg.executedQty),
            ),
          );
  return { cancels, unprotectedQuantity: unprotected.toFixed() };
}
