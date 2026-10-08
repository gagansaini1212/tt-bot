import type {
  BinanceSpotTestnet,
  TestnetInstrument,
  TestnetOrder,
} from "@crypto-trading/exchanges";

/** What the loop and the strategies it runs ask Binance. */
export type ExecutionExchange = Pick<
  BinanceSpotTestnet,
  | "getAccount"
  | "getOpenOrders"
  | "getOrder"
  | "getOrderList"
  | "getOrderFills"
  | "getLastPrice"
  | "getSymbolRules"
  | "getDepth"
  | "getKlines"
  | "cancelOrderList"
  | "placeMarketSell"
  | "testProtectedEntry"
  | "placeProtectedEntry"
>;

/** What a pass reads from Binance once, however many entries need it. */
export class PassReads {
  // The client for the account this pass is checking.
  readonly exchange: ExecutionExchange;
  readonly #open = new Map<
    TestnetInstrument,
    Promise<Map<string, TestnetOrder>>
  >();
  readonly #prices = new Map<TestnetInstrument, Promise<string>>();
  readonly #asks = new Map<TestnetInstrument, Promise<string | undefined>>();
  #account?: ReturnType<ExecutionExchange["getAccount"]>;

  constructor(exchange: ExecutionExchange) {
    this.exchange = exchange;
  }

  openOrders(instrument: TestnetInstrument) {
    let orders = this.#open.get(instrument);
    if (!orders) {
      orders = this.exchange
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
      price = this.exchange.getLastPrice(instrument);
      this.#prices.set(instrument, price);
    }
    return price;
  }

  /** The best ask, or undefined if the book has none. */
  bestAsk(instrument: TestnetInstrument) {
    let ask = this.#asks.get(instrument);
    if (!ask) {
      ask = this.exchange
        .getDepth(instrument, 5)
        .then((book) => book.asks[0]?.price);
      this.#asks.set(instrument, ask);
    }
    return ask;
  }

  async balance(asset: string) {
    this.#account ??= this.exchange.getAccount();
    const found = (await this.#account).balances.find(
      (balance) => balance.asset === asset,
    );
    return { free: found?.free ?? "0", locked: found?.locked ?? "0" };
  }

  /**
   * An order changes the balance and the open orders, so read them again
   * before the next.
   */
  forgetBalance() {
    this.#account = undefined;
  }

  forgetOpenOrders(instrument: TestnetInstrument) {
    this.#open.delete(instrument);
  }
}
