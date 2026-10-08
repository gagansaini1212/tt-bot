// A stateful in-memory Binance for the execution loop's tests. It models
// OPOCO lists the way Binance documents them: exits held back without a
// quantity until the entry fills completely, then sized from what the entry
// received after fees, one cancelling the other.
import Decimal from "decimal.js";
import {
  BinanceTestnetError,
  binanceSymbol,
  floorToStep,
  protectedLegIds,
  type ProtectedEntry,
  type TestnetFill,
  type TestnetInstrument,
  type TestnetMarketSell,
  type TestnetOrder,
  type TestnetOrderList,
  type TestnetOrderListReport,
} from "@crypto-trading/exchanges";
import type { ExecutionExchange } from "../execution-loop";
import type { ManualOrderExchange } from "../manual-orders";
import { rules } from "./fake-exchange";

const OPEN = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW"]);
// Binance's taker fee on the testnet, taken from the bought asset.
const FEE_RATE = "0.001";
const missing = () => new BinanceTestnetError("rejected", -2013);

type Failure = BinanceTestnetError | Error;
type Method = keyof (ExecutionExchange & ManualOrderExchange);

export class FakeBinance implements ExecutionExchange, ManualOrderExchange {
  readonly orders = new Map<string, TestnetOrder>();
  readonly lists = new Map<string, TestnetOrderList>();
  readonly fills = new Map<number, TestnetFill[]>();
  readonly prices = new Map<TestnetInstrument, string>([
    ["BTC-USDT", "60000"],
    ["ETH-USDT", "3000"],
  ]);
  readonly balances = new Map<string, { free: Decimal; locked: Decimal }>([
    ["USDT", { free: new Decimal(1000), locked: new Decimal(0) }],
  ]);
  // Hourly candle opens, by instrument and open time. Others open at the
  // current price.
  readonly hourOpens = new Map<string, string>();
  readonly calls: Partial<Record<Method, number>> = {};
  /** What market sells do. */
  sellBehaviour:
    "fill" | "reject" | "rate_limited" | "expire" | "unknown_placed" = "fill";
  /** What placing an order list does: fill_now fills the entry at once. */
  entryBehaviour: "place" | "fill_now" | "unknown_placed" = "place";
  #failures = new Map<Method, Failure[]>();
  #nextId = 1000;
  #nextFill = 1;
  #clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  /** Makes the next call of `method` throw `error`. */
  failNext(method: Method, error: Failure) {
    this.#failures.set(method, [...(this.#failures.get(method) ?? []), error]);
  }

  count(method: Method) {
    return this.calls[method] ?? 0;
  }

  #call(method: Method) {
    this.calls[method] = this.count(method) + 1;
    const failure = this.#failures.get(method)?.shift();
    if (failure) throw failure;
  }

  #balance(asset: string) {
    let balance = this.balances.get(asset);
    if (!balance) {
      balance = { free: new Decimal(0), locked: new Decimal(0) };
      this.balances.set(asset, balance);
    }
    return balance;
  }

  #legs(listClientOrderId: string) {
    const ids = protectedLegIds(listClientOrderId);
    return {
      entry: this.orders.get(ids.entry)!,
      takeProfit: this.orders.get(ids.takeProfit)!,
      stopLoss: this.orders.get(ids.stopLoss)!,
    };
  }

  #set(order: TestnetOrder) {
    this.orders.set(order.clientOrderId, { ...order });
  }

  #fill(order: TestnetOrder, quantity: Decimal, price: string, fee: string) {
    const fills = this.fills.get(order.orderId) ?? [];
    fills.push({
      symbol: order.symbol,
      id: this.#nextFill++,
      orderId: order.orderId,
      price,
      qty: quantity.toFixed(),
      quoteQty: quantity.times(price).toFixed(),
      commission: fee,
      commissionAsset:
        order.side === "BUY" ? order.symbol.replace(/USDT$/, "") : "USDT",
      time: this.#clock().getTime(),
      isBuyer: order.side === "BUY",
    });
    this.fills.set(order.orderId, fills);
    const executed = new Decimal(order.executedQty).plus(quantity);
    return {
      ...order,
      executedQty: executed.toFixed(),
      cummulativeQuoteQty: new Decimal(order.cummulativeQuoteQty)
        .plus(quantity.times(price))
        .toFixed(),
      status: executed.gte(order.origQty) ? "FILLED" : "PARTIALLY_FILLED",
    };
  }

  // Simulation controls.

  setPrice(instrument: TestnetInstrument, price: string) {
    this.prices.set(instrument, price);
  }

  /** Sets the open of the hourly candle starting at `at`. */
  setHourOpen(instrument: TestnetInstrument, at: Date, price: string) {
    this.hourOpens.set(`${instrument}@${at.getTime()}`, price);
  }

  /**
   * Fills `quantity` of a list's entry at its price, taking the fee from the
   * bought asset. Once it has filled completely, Binance sizes and places the
   * exits, or drops them, as when their size fails a filter.
   */
  fillEntry(
    listClientOrderId: string,
    quantity: string,
    {
      exits = "place",
    }: {
      // drop: Binance expires them; reject: it rejects them unsized;
      // pending: it has not placed them yet.
      exits?: "place" | "drop" | "reject" | "pending";
    } = {},
  ) {
    const { entry, takeProfit, stopLoss } = this.#legs(listClientOrderId);
    const amount = new Decimal(quantity);
    const fee = amount.times(FEE_RATE);
    const filled = this.#fill(entry, amount, entry.price, fee.toFixed());
    this.#set(filled);
    const base = this.#balance(entry.symbol.replace(/USDT$/, ""));
    base.free = base.free.plus(amount.minus(fee));
    const usdt = this.#balance("USDT");
    usdt.locked = usdt.locked.minus(amount.times(entry.price));
    if (filled.status !== "FILLED") return;
    const received = floorToStep(
      new Decimal(filled.executedQty).minus(
        this.fills
          .get(entry.orderId)!
          .reduce((total, fill) => total.plus(fill.commission), new Decimal(0)),
      ),
      rules("BTC-USDT").stepSize,
    );
    if (exits === "pending") return;
    for (const exit of [takeProfit, stopLoss])
      this.#set({
        ...exit,
        origQty: exits === "reject" ? "0" : received.toFixed(),
        status:
          exits === "place" ? "NEW" : exits === "drop" ? "EXPIRED" : "REJECTED",
      });
    if (exits === "place") {
      base.free = base.free.minus(received);
      base.locked = base.locked.plus(received);
    } else {
      this.lists.get(listClientOrderId)!.listOrderStatus = "ALL_DONE";
    }
  }

  /** Fills an exit completely; Binance then expires the other. */
  fillExit(listClientOrderId: string, which: "takeProfit" | "stopLoss") {
    const legs = this.#legs(listClientOrderId);
    const exit = legs[which];
    const other = which === "takeProfit" ? legs.stopLoss : legs.takeProfit;
    const price =
      which === "takeProfit" ? exit.price : (exit.stopPrice ?? exit.price);
    this.#set(this.#fill(exit, new Decimal(exit.origQty), price, "0"));
    this.#set({ ...other, status: "EXPIRED" });
    this.lists.get(listClientOrderId)!.listOrderStatus = "ALL_DONE";
    const base = this.#balance(exit.symbol.replace(/USDT$/, ""));
    base.locked = base.locked.minus(exit.origQty);
  }

  /** Cancels a list outside the worker, as on Binance's website. */
  cancelElsewhere(listClientOrderId: string) {
    const list = this.lists.get(listClientOrderId)!;
    this.#cancel(list);
  }

  /** Forgets every order, as a testnet reset does. */
  reset() {
    this.orders.clear();
    this.lists.clear();
  }

  #cancel(list: TestnetOrderList) {
    list.listOrderStatus = "ALL_DONE";
    for (const { clientOrderId } of list.orders) {
      const order = this.orders.get(clientOrderId)!;
      if (!OPEN.has(order.status)) continue;
      if (order.side === "SELL" && order.status !== "PENDING_NEW") {
        const base = this.#balance(order.symbol.replace(/USDT$/, ""));
        const left = new Decimal(order.origQty).minus(order.executedQty);
        base.locked = base.locked.minus(left);
        base.free = base.free.plus(left);
      }
      if (order.side === "BUY") {
        const usdt = this.#balance("USDT");
        const left = new Decimal(order.origQty)
          .minus(order.executedQty)
          .times(order.price);
        usdt.locked = usdt.locked.minus(left);
        usdt.free = usdt.free.plus(left);
      }
      this.#set({
        ...order,
        status: order.side === "BUY" ? "CANCELED" : "EXPIRED",
      });
    }
  }

  // ExecutionExchange and ManualOrderExchange.

  getAccount = async () => {
    this.#call("getAccount");
    return {
      canTrade: true,
      balances: [...this.balances].map(([asset, balance]) => ({
        asset,
        free: balance.free.toFixed(),
        locked: balance.locked.toFixed(),
      })),
    };
  };

  getOpenOrders = async (instrument: TestnetInstrument) => {
    this.#call("getOpenOrders");
    return [...this.orders.values()]
      .filter(
        (order) =>
          order.symbol === binanceSymbol(instrument) &&
          ["NEW", "PARTIALLY_FILLED"].includes(order.status),
      )
      .map((order) => ({ ...order }));
  };

  getOpenOrderLists = async () => {
    this.#call("getOpenOrderLists");
    return [...this.lists.values()].filter(
      (list) => list.listOrderStatus === "EXECUTING",
    );
  };

  getOrder = async (_instrument: TestnetInstrument, clientOrderId: string) => {
    this.#call("getOrder");
    const order = this.orders.get(clientOrderId);
    if (!order) throw missing();
    return { ...order };
  };

  getOrderList = async (listClientOrderId: string) => {
    this.#call("getOrderList");
    const list = this.lists.get(listClientOrderId);
    if (!list) throw missing();
    return structuredClone(list);
  };

  getOrderFills = async (_instrument: TestnetInstrument, orderId: number) => {
    this.#call("getOrderFills");
    return structuredClone(this.fills.get(orderId) ?? []);
  };

  getLastPrice = async (instrument: TestnetInstrument) => {
    this.#call("getLastPrice");
    return this.prices.get(instrument)!;
  };

  getSymbolRules = async () => {
    this.#call("getSymbolRules");
    return [rules("BTC-USDT"), rules("ETH-USDT")];
  };

  getKlines = async (
    instrument: TestnetInstrument,
    _interval: string,
    limit = 500,
  ) => {
    this.#call("getKlines");
    const hour = 60 * 60 * 1000;
    const latest = Math.floor(this.#clock().getTime() / hour) * hour;
    return Array.from({ length: limit }, (_, index) => {
      const openTime = latest - (limit - 1 - index) * hour;
      const price =
        this.hourOpens.get(`${instrument}@${openTime}`) ??
        this.prices.get(instrument)!;
      return {
        openTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: "1",
        closeTime: openTime + hour - 1,
        quoteVolume: price,
        trades: 1,
      };
    });
  };

  getDepth = async (instrument: TestnetInstrument) => {
    this.#call("getDepth");
    const price = new Decimal(this.prices.get(instrument)!);
    return {
      lastUpdateId: 1,
      bids: [{ price: price.minus(1).toFixed(2), quantity: "1" }],
      asks: [{ price: price.toFixed(2), quantity: "1" }],
    };
  };

  testProtectedEntry = async () => {
    this.#call("testProtectedEntry");
  };

  placeProtectedEntry = async (
    entry: ProtectedEntry,
  ): Promise<TestnetOrderListReport> => {
    this.#call("placeProtectedEntry");
    if (this.lists.has(entry.listClientOrderId))
      throw new BinanceTestnetError(
        "rejected",
        -2010,
        undefined,
        "Duplicate order sent.",
      );
    const orderListId = this.#nextId++;
    const ids = protectedLegIds(entry.listClientOrderId);
    const symbol = binanceSymbol(entry.instrument);
    const leg = (
      clientOrderId: string,
      fields: Partial<TestnetOrder>,
    ): TestnetOrder => ({
      symbol,
      orderId: this.#nextId++,
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
        status: "NEW",
      }),
      leg(ids.takeProfit, { price: entry.takeProfitPrice }),
      leg(ids.stopLoss, { type: "STOP_LOSS", stopPrice: entry.stopLossPrice }),
    ];
    for (const order of legs) this.#set(order);
    const usdt = this.#balance("USDT");
    const cost = new Decimal(entry.quantity).times(entry.price);
    usdt.free = usdt.free.minus(cost);
    usdt.locked = usdt.locked.plus(cost);
    const list: TestnetOrderList = {
      orderListId,
      contingencyType: "OTO",
      listStatusType: "EXEC_STARTED",
      listOrderStatus: "EXECUTING",
      listClientOrderId: entry.listClientOrderId,
      symbol,
      orders: legs.map(({ symbol, orderId, clientOrderId }) => ({
        symbol,
        orderId,
        clientOrderId,
      })),
    };
    this.lists.set(entry.listClientOrderId, list);
    if (this.entryBehaviour === "unknown_placed")
      throw new BinanceTestnetError("unknown_outcome");
    if (this.entryBehaviour === "fill_now") {
      this.fillEntry(entry.listClientOrderId, entry.quantity);
      return {
        ...structuredClone(list),
        orderReports: list.orders.map(({ clientOrderId }) => ({
          ...this.orders.get(clientOrderId)!,
        })),
      };
    }
    return { ...structuredClone(list), orderReports: legs };
  };

  cancelOrderList = async (
    _instrument: TestnetInstrument,
    orderListId: number,
  ): Promise<TestnetOrderListReport> => {
    this.#call("cancelOrderList");
    const list = [...this.lists.values()].find(
      (entry) => entry.orderListId === orderListId,
    );
    if (!list || list.listOrderStatus !== "EXECUTING")
      throw new BinanceTestnetError(
        "rejected",
        -2011,
        undefined,
        "Unknown order sent.",
      );
    this.#cancel(list);
    return {
      ...structuredClone(list),
      orderReports: list.orders.map(({ clientOrderId }) => ({
        ...this.orders.get(clientOrderId)!,
      })),
    };
  };

  cancelOrderById = async (_instrument: TestnetInstrument, orderId: number) => {
    this.#call("cancelOrderById");
    const order = [...this.orders.values()].find(
      (entry) => entry.orderId === orderId,
    );
    if (!order) throw missing();
    this.#set({ ...order, status: "CANCELED" });
    return { ...this.orders.get(order.clientOrderId)! };
  };

  placeMarketSell = async (sale: TestnetMarketSell) => {
    this.#call("placeMarketSell");
    if (this.orders.has(sale.clientOrderId))
      throw new BinanceTestnetError(
        "rejected",
        -2010,
        undefined,
        "Duplicate order sent.",
      );
    if (this.sellBehaviour === "rate_limited")
      throw new BinanceTestnetError("rate_limited", -1015, 30);
    if (this.sellBehaviour === "reject")
      throw new BinanceTestnetError(
        "rejected",
        -2010,
        undefined,
        "Account has insufficient balance for requested action.",
      );
    const symbol = binanceSymbol(sale.instrument);
    const base = this.#balance(symbol.replace(/USDT$/, ""));
    let order: TestnetOrder = {
      symbol,
      orderId: this.#nextId++,
      clientOrderId: sale.clientOrderId,
      price: "0",
      origQty: sale.quantity,
      executedQty: "0",
      cummulativeQuoteQty: "0",
      status: "NEW",
      type: "MARKET",
      side: "SELL",
      orderListId: -1,
    };
    if (this.sellBehaviour === "expire") order.status = "EXPIRED";
    else {
      if (base.free.lt(sale.quantity))
        throw new BinanceTestnetError(
          "rejected",
          -2010,
          undefined,
          "Account has insufficient balance for requested action.",
        );
      order = this.#fill(
        order,
        new Decimal(sale.quantity),
        this.prices.get(sale.instrument)!,
        "0",
      );
      base.free = base.free.minus(sale.quantity);
    }
    this.#set(order);
    if (this.sellBehaviour === "unknown_placed")
      throw new BinanceTestnetError("unknown_outcome");
    return { ...order };
  };
}
