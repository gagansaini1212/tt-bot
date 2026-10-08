// Client-safe helpers for the order drawer and the Open orders table.
import Decimal from "decimal.js";
import type { TestnetOrder, TestnetSnapshot } from "@crypto-trading/exchanges";
import {
  floorToStep,
  instrumentForSymbol,
  protectedLeg,
} from "@crypto-trading/exchanges/order-rules";

/** A new client ID for one order list. Retries of that order reuse it. */
export function newListClientOrderId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `ct_${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export function isDecimal(value: string) {
  return /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value);
}

/** The base quantity that spends `share` of the free USDT at `price`. */
export function quantityForShare(
  freeUsdt: string,
  share: number,
  price: string,
  stepSize: string,
) {
  if (!isDecimal(price)) return undefined;
  const quantity = floorToStep(
    new Decimal(freeUsdt).times(share).dividedBy(price),
    stepSize,
  );
  return quantity.greaterThan(0) ? quantity.toFixed() : undefined;
}

export const instrumentOf = instrumentForSymbol;

export function baseAsset(symbol: string) {
  return instrumentOf(symbol)?.split("-")[0] ?? symbol;
}

export type OrderRole = "Entry" | "Take profit" | "Stop loss";

export function orderRole(order: TestnetOrder): OrderRole | undefined {
  const leg = protectedLeg(order.clientOrderId)?.leg;
  if (leg)
    return { entry: "Entry", takeProfit: "Take profit", stopLoss: "Stop loss" }[
      leg
    ] as OrderRole;
  if (order.orderListId < 0) return undefined;
  if (order.type.startsWith("STOP_LOSS")) return "Stop loss";
  if (order.side === "SELL") return "Take profit";
  return "Entry";
}

const ROLE_ORDER: (OrderRole | undefined)[] = [
  "Entry",
  "Take profit",
  "Stop loss",
  undefined,
];

export type OrderGroup = {
  key: string;
  /** Set for orders that Binance cancels together. */
  orderListId?: number;
  orders: TestnetOrder[];
};

/** Standalone orders, and each order list's legs together: entry, take profit, stop loss. */
export function groupOpenOrders(
  snapshot: Pick<TestnetSnapshot, "orders" | "pendingOrders">,
): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();
  const seen = new Set<string>();
  for (const order of [...snapshot.orders, ...snapshot.pendingOrders]) {
    const id = `${order.symbol}:${order.orderId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const key =
      order.orderListId < 0 ? id : `${order.symbol}:list:${order.orderListId}`;
    const group = groups.get(key) ?? {
      key,
      ...(order.orderListId < 0 ? {} : { orderListId: order.orderListId }),
      orders: [],
    };
    group.orders.push(order);
    groups.set(key, group);
  }
  for (const group of groups.values())
    group.orders.sort(
      (a, b) =>
        ROLE_ORDER.indexOf(orderRole(a)) - ROLE_ORDER.indexOf(orderRole(b)),
    );
  return [...groups.values()];
}

const TYPE_LABELS: Record<string, string> = {
  LIMIT: "Limit",
  LIMIT_MAKER: "Limit maker",
  MARKET: "Market",
  STOP_LOSS: "Stop market",
  STOP_LOSS_LIMIT: "Stop limit",
  TAKE_PROFIT: "Take-profit market",
  TAKE_PROFIT_LIMIT: "Take-profit limit",
};

export function orderTypeLabel(order: TestnetOrder) {
  return `${TYPE_LABELS[order.type] ?? order.type} ${order.side.toLowerCase()}`;
}

export function orderPriceLabel(order: TestnetOrder) {
  const price = new Decimal(order.price);
  const stop = order.stopPrice ? new Decimal(order.stopPrice) : undefined;
  if (stop && !stop.isZero())
    return price.isZero()
      ? `Stop ${stop.toFixed()}`
      : `${price.toFixed()} · stop ${stop.toFixed()}`;
  return price.toFixed();
}

export function orderQuantityLabel(order: TestnetOrder) {
  // Binance sizes held-back exits from the entry's fill.
  if (order.status === "PENDING_NEW" && new Decimal(order.origQty).isZero())
    return "Set on fill";
  return `${new Decimal(order.executedQty).toFixed()} / ${new Decimal(order.origQty).toFixed()}`;
}

export function orderStatusLabel(order: TestnetOrder) {
  return (
    {
      NEW: "Open",
      PARTIALLY_FILLED: "Partly filled",
      PENDING_NEW: "Waiting for entry",
    }[order.status] ?? order.status
  );
}

/** How an order list protects its position, for the row above its legs. */
export function orderListSummary(orders: TestnetOrder[]): {
  text: string;
  warning: boolean;
} {
  const asset = baseAsset(orders[0]?.symbol ?? "");
  const entry = orders.find((order) => orderRole(order) === "Entry");
  const together = `Binance cancels these ${orders.length} orders together.`;
  if (entry?.status === "PARTIALLY_FILLED")
    return {
      text: `${new Decimal(entry.executedQty).toFixed()} ${asset} bought so far has no exits until the entry fills completely. ${together}`,
      warning: true,
    };
  if (entry) return { text: `Entry with exits. ${together}`, warning: false };
  const held = Decimal.max(
    0,
    ...orders
      .filter((order) => order.status !== "PENDING_NEW")
      .map((order) => new Decimal(order.origQty).minus(order.executedQty)),
  );
  return held.greaterThan(0)
    ? {
        text: `Exits for ${held.toFixed()} ${asset}. ${together}`,
        warning: false,
      }
    : { text: together, warning: false };
}
