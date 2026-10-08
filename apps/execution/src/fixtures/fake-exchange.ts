// Test doubles for the worker's dashboard orders: an in-memory Binance and a
// ManualOrderDesk wired to it.
import assert from "node:assert/strict";
import {
  BinanceTestnetError,
  protectedLegIds,
  type ManualOrderRequest,
  type ProtectedEntry,
  type SymbolRules,
  type TestnetInstrument,
  type TestnetOrder,
  type TestnetOrderList,
  type TestnetOrderListReport,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "../accounts";
import {
  loadManualTradingConfig,
  ManualOrderDesk,
  type ManualOrderExchange,
} from "../manual-orders";
import type { OrderIntentStore } from "../order-intents";

export const rules = (instrument: TestnetInstrument): SymbolRules => ({
  instrument,
  trading: true,
  protectedEntryAllowed: true,
  minPrice: "0.01",
  maxPrice: "1000000",
  tickSize: "0.01",
  minQty: "0.00001",
  maxQty: "9000",
  stepSize: "0.00001",
  minNotional: "5",
  maxNotional: "9000000",
});
const symbol = (instrument: TestnetInstrument) => instrument.replace("-", "");

export type Behaviour =
  | "rest"
  | "fill"
  | "fill_without_exits"
  | "fok_expire"
  | "reject"
  | "timeout_placed"
  | "timeout_not_placed"
  | "lookup_refused"
  | "rate_limited";

/** An in-memory exchange that models OPOCO lists the way Binance documents them. */
export function fakeExchange(
  behaviour: Behaviour = "rest",
  // Holds a submission in flight until it resolves.
  gate: Promise<void> = Promise.resolve(),
) {
  const calls = { test: 0, place: 0, cancelList: 0, cancelOrder: 0 };
  const orders = new Map<string, TestnetOrder>();
  const lists: TestnetOrderList[] = [];
  let nextId = 100;
  const open = () =>
    [...orders.values()].filter((order) =>
      ["NEW", "PARTIALLY_FILLED"].includes(order.status),
    );
  const exchange: ManualOrderExchange = {
    getAccount: async () => ({
      canTrade: true,
      balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    }),
    getOpenOrders: async (instrument) =>
      open().filter((order) => order.symbol === symbol(instrument)),
    getOpenOrderLists: async () =>
      lists.filter((list) => list.listOrderStatus === "EXECUTING"),
    getOrder: async (_instrument, clientOrderId) => {
      const order = orders.get(clientOrderId);
      if (!order) throw new BinanceTestnetError("rejected", -2013);
      return order;
    },
    getOrderList: async (listClientOrderId) => {
      const list = lists.find(
        (entry) => entry.listClientOrderId === listClientOrderId,
      );
      if (!list)
        throw new BinanceTestnetError(
          "rejected",
          behaviour === "lookup_refused" ? -1022 : -2013,
        );
      return list;
    },
    getSymbolRules: async () => [rules("BTC-USDT"), rules("ETH-USDT")],
    getDepth: async () => ({
      lastUpdateId: 1,
      bids: [{ price: "59999.00", quantity: "1" }],
      asks: [{ price: "60000.00", quantity: "1" }],
    }),
    testProtectedEntry: async () => {
      calls.test++;
    },
    placeProtectedEntry: async (entry: ProtectedEntry) => {
      calls.place++;
      await gate;
      if (behaviour === "reject")
        throw new BinanceTestnetError(
          "rejected",
          -2010,
          undefined,
          "Account has insufficient balance for requested action.",
        );
      if (behaviour === "timeout_not_placed" || behaviour === "lookup_refused")
        throw new BinanceTestnetError("unknown_outcome");
      if (behaviour === "rate_limited")
        throw new BinanceTestnetError("rate_limited", -1015, 30);
      const orderListId = nextId++;
      const ids = protectedLegIds(entry.listClientOrderId);
      const filled = ["fill", "fill_without_exits"].includes(behaviour);
      const leg = (
        clientOrderId: string,
        fields: Partial<TestnetOrder>,
      ): TestnetOrder => ({
        symbol: symbol(entry.instrument),
        orderId: nextId++,
        clientOrderId,
        price: "0",
        origQty: "0",
        executedQty: "0",
        cummulativeQuoteQty: "0",
        status: "PENDING_NEW",
        type: "LIMIT_MAKER",
        side: "SELL",
        orderListId,
        ...fields,
      });
      const legs = [
        leg(ids.entry, {
          side: "BUY",
          type: "LIMIT",
          price: entry.price,
          origQty: entry.quantity,
          executedQty: filled ? entry.quantity : "0",
          status:
            behaviour === "fok_expire" ? "EXPIRED" : filled ? "FILLED" : "NEW",
        }),
        leg(ids.takeProfit, { price: entry.takeProfitPrice }),
        leg(ids.stopLoss, {
          type: "STOP_LOSS",
          stopPrice: entry.stopLossPrice,
        }),
      ];
      for (const order of legs) orders.set(order.clientOrderId, order);
      const list = {
        orderListId,
        contingencyType: "OTO",
        listStatusType: "EXEC_STARTED",
        listOrderStatus: behaviour === "fok_expire" ? "ALL_DONE" : "EXECUTING",
        listClientOrderId: entry.listClientOrderId,
        symbol: symbol(entry.instrument),
        orders: legs.map(({ symbol, orderId, clientOrderId }) => ({
          symbol,
          orderId,
          clientOrderId,
        })),
      };
      lists.push(list);
      // Binance places or drops the exits just after reporting the fill.
      if (filled)
        for (const exit of legs.slice(1))
          orders.set(exit.clientOrderId, {
            ...exit,
            origQty: "0.00099",
            status: behaviour === "fill" ? "NEW" : "EXPIRED",
          });
      if (behaviour === "fok_expire")
        for (const exit of legs.slice(1))
          orders.set(exit.clientOrderId, { ...exit, status: "EXPIRED" });
      if (behaviour === "timeout_placed")
        throw new BinanceTestnetError("unknown_outcome");
      return { ...list, orderReports: legs } as TestnetOrderListReport;
    },
    cancelOrderList: async (_instrument, orderListId) => {
      calls.cancelList++;
      const list = lists.find((entry) => entry.orderListId === orderListId)!;
      list.listOrderStatus = "ALL_DONE";
      for (const { clientOrderId } of list.orders)
        orders.set(clientOrderId, {
          ...orders.get(clientOrderId)!,
          status: "CANCELED",
        });
      return {
        ...list,
        orderReports: list.orders.map(({ clientOrderId }) =>
          orders.get(clientOrderId)!,
        ),
      } as TestnetOrderListReport;
    },
    cancelOrderById: async (_instrument, orderId) => {
      calls.cancelOrder++;
      const order = [...orders.values()].find(
        (entry) => entry.orderId === orderId,
      )!;
      orders.set(order.clientOrderId, { ...order, status: "CANCELED" });
      return order;
    },
  };
  return { exchange, calls, orders };
}

/**
 * A desk on a fake exchange, acting for `scope`. Its methods take no scope;
 * use `desk.as(other)` to act for another customer.
 */
export function deskFixture({
  behaviour,
  env = {},
  intents,
  scope,
  gate,
}: {
  behaviour?: Behaviour;
  env?: Record<string, string>;
  intents: OrderIntentStore;
  scope: AccountScope;
  gate?: Promise<void>;
}) {
  const loaded = loadManualTradingConfig({
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
    TESTNET_MAX_ORDER_NOTIONAL_USDT: "100",
    TESTNET_MARKET_MAX_SLIPPAGE_PERCENT: "0.5",
    ...env,
  });
  assert.ok(loaded.ok);
  const fake = fakeExchange(behaviour, gate);
  let changes = 0;
  let offset = 0;
  const desk = new ManualOrderDesk({
    exchange: fake.exchange,
    config: loaded.config,
    intents,
    now: () => new Date(Date.now() + offset),
    onChange: () => changes++,
  });
  const as = (customer: AccountScope) => ({
    place: (request: unknown) => desk.place(customer, request),
    status: (id: unknown) => desk.status(customer, id),
    cancel: (request: unknown) => desk.cancel(customer, request),
    ticket: () => desk.ticket(customer),
  });
  return {
    ...fake,
    changes: () => changes,
    desk: { ...as(scope), as },
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

export const limit = (id: string, overrides = {}): ManualOrderRequest => ({
  type: "limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  price: "60000",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: id,
  ...overrides,
});

export const market = (id: string): ManualOrderRequest => ({
  type: "market",
  instrument: "BTC-USDT",
  quantity: "0.001",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: id,
});
