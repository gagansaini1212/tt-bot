// Browser-safe: the order drawer runs this plan as an advisory preview, and
// the worker runs it again with fresh account data before every submission.
import Decimal from "decimal.js";
import { z } from "zod";
import {
  authorizeTradeProposal,
  executionPolicySchema,
  type ExecutionPolicy,
} from "@crypto-trading/domain";
import type { TestnetOrder } from "./binance-spot-testnet";
import {
  floorToStep,
  listClientOrderIdSchema,
  protectedEntryFilterIssues,
  protectedLeg,
  symbolRulesSchema,
  testnetInstrumentSchema,
  type ProtectedEntry,
} from "./order-rules";

const decimal = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+)?$/);
const amount = decimal.refine((value) => /[1-9]/.test(value));

const orderFields = {
  instrument: testnetInstrumentSchema,
  quantity: amount,
  stopLossPrice: amount,
  takeProfitPrice: amount,
  // Chosen by the browser once per order, so a repeated request cannot
  // place a second order.
  listClientOrderId: listClientOrderIdSchema,
};
/** A buy from the order drawer. Spot is long only, so there is no side. */
export const manualOrderRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("limit"), price: amount, ...orderFields }),
  z.strictObject({ type: z.literal("market"), ...orderFields }),
]);
export type ManualOrderRequest = z.infer<typeof manualOrderRequestSchema>;

export const manualCancelRequestSchema = z.strictObject({
  instrument: testnetInstrumentSchema,
  orderId: z.number().int().nonnegative().refine(Number.isSafeInteger),
  // Required when the cancel leaves a filled quantity without exits.
  acceptUnprotected: z.boolean(),
});
export type ManualCancelRequest = z.infer<typeof manualCancelRequestSchema>;

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
  checks: z
    .array(
      z.object({
        name: z.enum(["price", "limits", "cap", "filters", "balance"]),
        label: z.string(),
        passed: z.boolean(),
        detail: z.string(),
      }),
    )
    .optional(),
});
export type ManualOrderOutcome = z.infer<typeof manualOrderOutcomeSchema>;

// Fixed identifiers for the single local manual-trading scope. They grant
// nothing: every limit comes from the worker's configuration.
export const MANUAL_TESTNET_SCOPE = {
  customerId: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a01",
  exchangeAccountId: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a02",
  strategyId: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a03",
  strategyVersion: 1,
} as const;

export const manualTradingConfigSchema = z.object({
  allowedInstruments: z.array(testnetInstrumentSchema).min(1),
  allocation: amount,
  maxOrderNotional: amount,
  // Share of the best ask a market entry may pay above it. Null turns
  // market entries off.
  marketSlippage: decimal.nullable(),
});
export type ManualTradingConfig = z.infer<typeof manualTradingConfigSchema>;

export function manualTestnetPolicy(
  config: ManualTradingConfig,
  exposure: { committedCapital: string; reservedBudget: string },
): ExecutionPolicy {
  return executionPolicySchema.parse({
    ...MANUAL_TESTNET_SCOPE,
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
 * order journal. Holdings with no open order are outside the allocation.
 */
export function manualExposure(
  orders: TestnetOrder[],
  entryPriceOf: (listClientOrderId: string) => string | undefined,
) {
  let reserved = new Decimal(0);
  let committed = new Decimal(0);
  const exits = new Map<string, TestnetOrder[]>();
  for (const order of orders) {
    if (order.side === "BUY") {
      const price = Decimal.max(order.price, order.stopPrice ?? "0");
      const filled = new Decimal(order.executedQty);
      reserved = reserved.plus(
        new Decimal(order.origQty).minus(filled).times(price),
      );
      committed = committed.plus(filled.times(price));
    } else if (order.orderListId >= 0 && order.status !== "PENDING_NEW") {
      const key = `${order.symbol}:${order.orderListId}`;
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
  maxOrderNotional: amount,
  marketSlippage: decimal.nullable(),
  freeUsdt: decimal,
  // The best ask is the market entry's reference and the preview's price hint.
  markets: z.array(
    z.object({ rules: symbolRulesSchema, bestAsk: amount.nullable() }),
  ),
});
export type ManualOrderTicket = z.infer<typeof manualOrderTicketSchema>;

export type ManualOrderCheck = {
  name: "price" | "limits" | "cap" | "filters" | "balance";
  label: string;
  passed: boolean;
  detail: string;
};

export type ManualOrderPlan = {
  passed: boolean;
  checks: ManualOrderCheck[];
  entry?: ProtectedEntry;
  notional?: string;
};

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
  if (request.type === "limit") {
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
    // Floored to the tick, so the bound never exceeds the configured slippage.
    price = floorToStep(
      new Decimal(market.bestAsk).times(
        new Decimal(1).plus(ticket.marketSlippage),
      ),
      market.rules.tickSize,
    ).toFixed();
    checks.push({
      name: "price",
      label: "Market price",
      passed: true,
      detail: `Pays at most ${price} USDT, ${new Decimal(ticket.marketSlippage).times(100).toFixed()}% above the best ask of ${market.bestAsk}. It fills completely now or not at all.`,
    });
  }
  const entry: ProtectedEntry = {
    instrument: request.instrument,
    quantity: request.quantity,
    price,
    timeInForce: request.type === "limit" ? "GTC" : "FOK",
    takeProfitPrice: request.takeProfitPrice,
    stopLossPrice: request.stopLossPrice,
    listClientOrderId: request.listClientOrderId,
  };
  const notional = new Decimal(entry.quantity).times(entry.price);
  const { policy } = ticket;
  const authorization = authorizeTradeProposal(
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
    policy,
    now,
  );
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
  const capPassed = notional.lessThanOrEqualTo(ticket.maxOrderNotional);
  checks.push({
    name: "cap",
    label: "Per-order cap",
    passed: capPassed,
    detail: capPassed
      ? `${notional.toFixed()} USDT is within the ${ticket.maxOrderNotional} USDT cap.`
      : `${notional.toFixed()} USDT is over the ${ticket.maxOrderNotional} USDT cap set by TESTNET_MAX_ORDER_NOTIONAL_USDT.`,
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
 * What cancelling an open order does. Binance cancels a whole order list when
 * any order in it is cancelled. If that list's entry has filled, even partly,
 * the filled quantity is left without a take profit or stop loss.
 */
export function cancelImpact(target: TestnetOrder, orders: TestnetOrder[]) {
  const cancels =
    target.orderListId < 0
      ? [target]
      : orders.filter(
          (order) =>
            order.symbol === target.symbol &&
            order.orderListId === target.orderListId,
        );
  const entry = cancels.find((order) => order.side === "BUY");
  const activeExits = cancels.filter(
    (order) => order.side === "SELL" && order.status !== "PENDING_NEW",
  );
  const unprotected =
    target.orderListId < 0
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
