import { createHmac, createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import {
  binanceSymbol,
  instrumentForSymbol,
  positiveDecimal,
  protectedEntrySchema,
  protectedLegIds,
  symbolRulesSchema,
  testnetInstrumentSchema,
  type ProtectedEntry,
  type SymbolRules,
  type TestnetInstrument,
} from "./order-rules";

// Deliberately fixed: this adapter cannot be configured to send real orders.
export const BINANCE_SPOT_TESTNET_URL = "https://testnet.binance.vision";
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const id = z.number().int().nonnegative().refine(Number.isSafeInteger);

export const balanceSchema = z.object({
  asset: z.string(),
  free: decimal,
  locked: decimal,
});
const accountSchema = z.object({
  canTrade: z.boolean(),
  balances: z.array(balanceSchema),
});
export const orderSchema = z.object({
  symbol: z.string(),
  orderId: id,
  clientOrderId: z.string(),
  price: decimal,
  // Binance leaves this out of OPO exits until their entry fills.
  origQty: decimal.default("0"),
  executedQty: decimal,
  cummulativeQuoteQty: decimal,
  status: z.string(),
  type: z.string(),
  side: z.enum(["BUY", "SELL"]),
  // -1 unless the order belongs to an order list, such as an OCO.
  orderListId: z
    .number()
    .int()
    .min(-1)
    .refine(Number.isSafeInteger)
    .default(-1),
  // Set for stop-loss and take-profit orders, which trigger at this price.
  stopPrice: decimal.optional(),
});
export const orderListSchema = z.object({
  orderListId: id,
  contingencyType: z.string(),
  listStatusType: z.string(),
  listOrderStatus: z.string(),
  listClientOrderId: z.string(),
  symbol: z.string(),
  orders: z.array(
    z.object({ symbol: z.string(), orderId: id, clientOrderId: z.string() }),
  ),
});
const orderListReportSchema = orderListSchema.extend({
  orderReports: z.array(orderSchema),
});
export const fillSchema = z.object({
  symbol: z.string(),
  id,
  orderId: id,
  price: decimal,
  qty: decimal,
  quoteQty: decimal,
  commission: decimal,
  commissionAsset: z.string(),
  time: id,
  isBuyer: z.boolean(),
});
export const limitOrderSchema = z.object({
  instrument: testnetInstrumentSchema,
  side: z.enum(["BUY", "SELL"]),
  quantity: positiveDecimal,
  price: positiveDecimal,
  // A caller-supplied identifier is needed to reconcile unknown outcomes.
  clientOrderId: z.string().regex(/^ct_[A-Za-z0-9_-]{1,33}$/),
});
export type TestnetLimitOrder = z.infer<typeof limitOrderSchema>;
/**
 * A market sell the worker sends to close a protected entry's quantity, such
 * as one whose exits Binance dropped, or one past its holding deadline.
 */
export const marketSellSchema = z.object({
  instrument: testnetInstrumentSchema,
  quantity: positiveDecimal,
  clientOrderId: z.string().regex(/^ct_[A-Za-z0-9_-]{1,33}$/),
});
export type TestnetMarketSell = z.infer<typeof marketSellSchema>;
export type TestnetOrder = z.infer<typeof orderSchema>;
export type TestnetOrderList = z.infer<typeof orderListSchema>;
export type TestnetOrderListReport = z.infer<typeof orderListReportSchema>;
export type TestnetFill = z.infer<typeof fillSchema>;
export const testnetSnapshotSchema = z.object({
  provider: z.literal("binance-spot-testnet"),
  capturedAt: z.iso.datetime(),
  canTrade: z.boolean(),
  balances: z.array(balanceSchema),
  orders: z.array(orderSchema),
  // Open order lists on BTC/USDT and ETH/USDT, and the legs Binance holds
  // back until the list's entry fills, which may be missing from `orders`.
  orderLists: z.array(orderListSchema).default([]),
  pendingOrders: z.array(orderSchema).default([]),
  fills: z.array(fillSchema),
});
export type TestnetSnapshot = z.infer<typeof testnetSnapshotSchema>;

// Public market data. Prices and quantities stay decimal strings.
const signedDecimal = z.string().regex(/^-?\d+(\.\d+)?$/);
// Binance lists some symbols in non-Latin scripts. This still rejects
// lowercase, separators and anything that needs escaping.
export const tickerSymbolSchema = z
  .string()
  .regex(/^[\p{Lu}\p{Lo}\p{Nd}]{2,20}$/u);
export const MAX_TICKER_SYMBOLS = 100;
// Symbols per worker /market/tickers request, which filters its list of all
// tickers. Shared here so the web client can stay under it.
export const MAX_TICKER_FILTER = 500;
export const klineIntervalSchema = z.enum([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
]);
export type KlineInterval = z.infer<typeof klineIntervalSchema>;
export const MAX_KLINE_LIMIT = 1000;
// Depth limits up to 100 cost Binance's lowest request weight.
export const MAX_DEPTH_LIMIT = 100;
export const tickerSchema = z.object({
  symbol: z.string(),
  lastPrice: decimal,
  openPrice: decimal,
  highPrice: decimal,
  lowPrice: decimal,
  priceChange: signedDecimal,
  priceChangePercent: signedDecimal,
  // Base-asset volume; quoteVolume is in the quote asset, e.g. USDT.
  volume: decimal,
  quoteVolume: decimal,
  openTime: id,
  closeTime: id,
});
export type TestnetTicker = z.infer<typeof tickerSchema>;
export const klineSchema = z.object({
  openTime: id,
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  volume: decimal,
  closeTime: id,
  quoteVolume: decimal,
  trades: id,
});
export type TestnetKline = z.infer<typeof klineSchema>;
const depthLevelSchema = z.object({ price: decimal, quantity: decimal });
export const depthSchema = z.object({
  lastUpdateId: id,
  // Best price first on both sides.
  bids: z.array(depthLevelSchema),
  asks: z.array(depthLevelSchema),
});
export type TestnetDepth = z.infer<typeof depthSchema>;
// Binance sends klines and depth levels as positional arrays.
export const binanceKlineSchema = z
  .tuple(
    [id, decimal, decimal, decimal, decimal, decimal, id, decimal, id],
    z.unknown(),
  )
  .transform(
    ([
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime,
      quoteVolume,
      trades,
    ]) => ({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      closeTime,
      quoteVolume,
      trades,
    }),
  );
const binanceLevelsSchema = z
  .array(z.tuple([decimal, decimal]))
  .transform((levels) =>
    levels.map(([price, quantity]) => ({ price, quantity })),
  );
const binanceDepthSchema = z.object({
  lastUpdateId: id,
  bids: binanceLevelsSchema,
  asks: binanceLevelsSchema,
});

export interface SpotTestnetExchange {
  getAccount(): Promise<z.infer<typeof accountSchema>>;
  getOpenOrders(instrument: TestnetInstrument): Promise<TestnetOrder[]>;
  getFills(instrument: TestnetInstrument): Promise<TestnetFill[]>;
  getOrder(
    instrument: TestnetInstrument,
    clientOrderId: string,
  ): Promise<TestnetOrder>;
  testLimitOrder(order: TestnetLimitOrder): Promise<void>;
  placeLimitOrder(order: TestnetLimitOrder): Promise<TestnetOrder>;
  cancelOrder(
    instrument: TestnetInstrument,
    clientOrderId: string,
  ): Promise<TestnetOrder>;
  getTickers(symbols?: readonly string[]): Promise<TestnetTicker[]>;
  getKlines(
    instrument: TestnetInstrument,
    interval: KlineInterval,
    limit?: number,
  ): Promise<TestnetKline[]>;
  getDepth(
    instrument: TestnetInstrument,
    limit?: number,
  ): Promise<TestnetDepth>;
}

// Rejection reasons from Binance's error documentation. Other messages are
// dropped: a proxy or a changed API could echo request details.
const documentedRejections = new Set([
  "Account has insufficient balance for requested action.",
  "Duplicate order sent.",
  "Market is closed.",
  "OPO orders are not supported for this symbol.",
  "Order would immediately match and take.",
  "Order would trigger immediately.",
  "The relationship of the prices for the orders is not correct.",
  "This account may not place or cancel orders.",
  "Unknown order sent.",
  "Unsupported order combination",
]);
function documentedRejection(message: unknown) {
  if (typeof message !== "string") return undefined;
  return documentedRejections.has(message) ||
    /^Filter failure: [A-Z_]{1,40}$/.test(message)
    ? message
    : undefined;
}

export class BinanceTestnetError extends Error {
  constructor(
    public readonly kind:
      "rejected" | "unavailable" | "rate_limited" | "unknown_outcome",
    public readonly code?: number,
    public readonly retryAfterSeconds?: number,
    public readonly reason?: string,
  ) {
    super(
      kind === "unknown_outcome"
        ? "Binance testnet outcome is unknown. Query the client order ID before taking further action."
        : `Binance testnet request ${kind}${code === undefined ? "" : ` (code ${code})`}.${reason ? ` ${reason}` : ""}`,
    );
    this.name = "BinanceTestnetError";
  }
}

export class BinanceSpotTestnet implements SpotTestnetExchange {
  readonly #apiKey: string;
  readonly #signPayload: (payload: string) => string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #clockOffset = 0;
  #clockSyncedAt = -Infinity;
  #clockSync?: Promise<void>;
  #blockedUntil = 0;

  constructor(options: {
    apiKey: string;
    apiSecret?: string;
    privateKey?: string;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    if (
      !options.apiKey.trim() ||
      (!options.apiSecret?.trim() && !options.privateKey?.trim())
    ) {
      throw new Error(
        "A Binance testnet API key and either a private key or HMAC secret are required in the execution service.",
      );
    }
    if (options.privateKey?.trim() && options.apiSecret?.trim()) {
      throw new Error(
        "Configure either a Binance private key or HMAC secret, not both.",
      );
    }
    this.#apiKey = options.apiKey;
    if (options.privateKey?.trim()) {
      try {
        const key = createPrivateKey(options.privateKey);
        if (
          key.asymmetricKeyType !== "ed25519" &&
          key.asymmetricKeyType !== "rsa"
        )
          throw new Error();
        if (
          key.asymmetricKeyType === "rsa" &&
          (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
        )
          throw new Error();
        this.#signPayload = (payload) =>
          sign(
            key.asymmetricKeyType === "ed25519" ? null : "sha256",
            Buffer.from(payload),
            key,
          ).toString("base64");
      } catch {
        throw new Error(
          "The Binance private key must be an unencrypted Ed25519 or RSA PEM key. RSA keys must have at least 2048 bits.",
        );
      }
    } else {
      const secret = options.apiSecret!;
      this.#signPayload = (payload) =>
        createHmac("sha256", secret).update(payload).digest("hex");
    }
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async #syncClock() {
    if (this.#now() - this.#clockSyncedAt < 60_000) return;
    if (!this.#clockSync) {
      this.#clockSync = (async () => {
        const start = this.#now();
        const { serverTime } = await this.#request(
          "GET",
          "/api/v3/time",
          {},
          z.object({ serverTime: id }),
          false,
        );
        this.#clockOffset = serverTime - Math.floor((start + this.#now()) / 2);
        this.#clockSyncedAt = this.#now();
      })().finally(() => {
        this.#clockSync = undefined;
      });
    }
    await this.#clockSync;
  }

  async #request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
    signed = true,
  ): Promise<T> {
    if (this.#now() < this.#blockedUntil) {
      throw new BinanceTestnetError(
        "rate_limited",
        undefined,
        Math.ceil((this.#blockedUntil - this.#now()) / 1000),
      );
    }
    if (signed) await this.#syncClock();
    const query = new URLSearchParams(parameters);
    if (signed) {
      query.set("recvWindow", "5000");
      query.set("timestamp", String(this.#now() + this.#clockOffset));
      query.set("signature", this.#signPayload(query.toString()));
    }
    const mutation = method !== "GET" && path !== "/api/v3/order/test";
    let response: Response;
    try {
      response = await this.#fetch(
        `${BINANCE_SPOT_TESTNET_URL}${path}${method === "GET" ? `?${query}` : ""}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(12_000),
          headers: signed
            ? {
                "X-MBX-APIKEY": this.#apiKey,
                "Content-Type": "application/x-www-form-urlencoded",
              }
            : {},
          ...(method === "GET" ? {} : { body: query.toString() }),
        },
      );
    } catch {
      // Never include request URLs, signatures, headers or transport errors.
      throw new BinanceTestnetError(
        mutation ? "unknown_outcome" : "unavailable",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Some proxies return HTML errors. HTTP rate limits must still apply.
      body = undefined;
    }
    const error = z
      .object({ code: z.number(), msg: z.string() })
      .safeParse(body);
    if (!response.ok || (error.success && error.data.code < 0)) {
      const code = error.success ? error.data.code : undefined;
      if (response.status === 429 || response.status === 418) {
        const seconds = Number(response.headers.get("Retry-After"));
        const retryAfter =
          Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
        this.#blockedUntil = this.#now() + retryAfter * 1000;
        throw new BinanceTestnetError("rate_limited", code, retryAfter);
      }
      const unknown =
        mutation &&
        (response.status >= 500 || code === -1006 || code === -1007);
      const kind = unknown
        ? "unknown_outcome"
        : response.status >= 500
          ? "unavailable"
          : "rejected";
      throw new BinanceTestnetError(
        kind,
        code,
        undefined,
        kind === "rejected" && error.success
          ? documentedRejection(error.data.msg)
          : undefined,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new BinanceTestnetError(
        mutation ? "unknown_outcome" : "unavailable",
      );
    return parsed.data;
  }

  getAccount() {
    return this.#request(
      "GET",
      "/api/v3/account",
      { omitZeroBalances: "true" },
      accountSchema,
    );
  }
  getOpenOrders(instrument: TestnetInstrument) {
    return this.#request(
      "GET",
      "/api/v3/openOrders",
      { symbol: symbol(instrument) },
      z.array(orderSchema),
    );
  }
  getFills(instrument: TestnetInstrument) {
    return this.#request(
      "GET",
      "/api/v3/myTrades",
      { symbol: symbol(instrument), limit: "50" },
      z.array(fillSchema),
    );
  }
  getOrder(instrument: TestnetInstrument, clientOrderId: string) {
    return this.#request(
      "GET",
      "/api/v3/order",
      orderIdentifier(instrument, clientOrderId),
      orderSchema,
    );
  }
  async testLimitOrder(order: TestnetLimitOrder) {
    await this.#request(
      "POST",
      "/api/v3/order/test",
      orderParameters(order),
      z.object({}),
    );
  }
  placeLimitOrder(order: TestnetLimitOrder) {
    return this.#request(
      "POST",
      "/api/v3/order",
      orderParameters(order),
      orderSchema,
    );
  }
  cancelOrder(instrument: TestnetInstrument, clientOrderId: string) {
    return this.#request(
      "DELETE",
      "/api/v3/order",
      orderIdentifier(instrument, clientOrderId),
      orderSchema,
    );
  }
  /** 24h statistics for every symbol, or for up to 100 listed symbols. */
  getTickers(symbols?: readonly string[]) {
    const listed =
      symbols &&
      z.array(tickerSymbolSchema).min(1).max(MAX_TICKER_SYMBOLS).parse(symbols);
    return this.#request(
      "GET",
      "/api/v3/ticker/24hr",
      listed ? { symbols: JSON.stringify(listed) } : {},
      z.array(tickerSchema),
      false,
    );
  }
  /** The most recent candles, oldest first. */
  getKlines(
    instrument: TestnetInstrument,
    interval: KlineInterval,
    limit = 500,
  ) {
    return this.#request(
      "GET",
      "/api/v3/klines",
      {
        symbol: symbol(instrument),
        interval: klineIntervalSchema.parse(interval),
        limit: String(boundedLimit(MAX_KLINE_LIMIT).parse(limit)),
      },
      z.array(binanceKlineSchema),
      false,
    );
  }
  getDepth(instrument: TestnetInstrument, limit = MAX_DEPTH_LIMIT) {
    return this.#request(
      "GET",
      "/api/v3/depth",
      {
        symbol: symbol(instrument),
        limit: String(boundedLimit(MAX_DEPTH_LIMIT).parse(limit)),
      },
      binanceDepthSchema,
      false,
    );
  }
  async getOrderById(instrument: TestnetInstrument, orderId: number) {
    return this.#request(
      "GET",
      "/api/v3/order",
      { symbol: symbol(instrument), orderId: String(id.parse(orderId)) },
      orderSchema,
    );
  }
  async cancelOrderById(instrument: TestnetInstrument, orderId: number) {
    return this.#request(
      "DELETE",
      "/api/v3/order",
      { symbol: symbol(instrument), orderId: String(id.parse(orderId)) },
      orderSchema,
    );
  }
  /** The latest traded price, which Binance also triggers stop orders on. */
  async getLastPrice(instrument: TestnetInstrument) {
    const { price } = await this.#request(
      "GET",
      "/api/v3/ticker/price",
      { symbol: symbol(instrument) },
      z.object({ symbol: z.string(), price: positiveDecimal }),
      false,
    );
    return price;
  }
  /** Every fill of one order. */
  getOrderFills(instrument: TestnetInstrument, orderId: number) {
    return this.#request(
      "GET",
      "/api/v3/myTrades",
      {
        symbol: symbol(instrument),
        orderId: String(id.parse(orderId)),
        limit: "1000",
      },
      z.array(fillSchema),
    );
  }
  /**
   * Sells at market. It closes a position at whatever the book pays, so only
   * the worker's exits use it.
   */
  async placeMarketSell(raw: TestnetMarketSell) {
    const order = marketSellSchema.parse(raw);
    return this.#request(
      "POST",
      "/api/v3/order",
      {
        symbol: symbol(order.instrument),
        side: "SELL",
        type: "MARKET",
        quantity: order.quantity,
        newClientOrderId: order.clientOrderId,
        newOrderRespType: "RESULT",
      },
      orderSchema,
    );
  }
  /** Validates the entry leg without placing it. Binance has no test endpoint for order lists. */
  async testProtectedEntry(entry: ProtectedEntry) {
    const order = protectedEntrySchema.parse(entry);
    await this.#request(
      "POST",
      "/api/v3/order/test",
      {
        symbol: symbol(order.instrument),
        side: "BUY",
        type: "LIMIT",
        timeInForce: order.timeInForce,
        quantity: order.quantity,
        price: order.price,
        newClientOrderId: protectedLegIds(order.listClientOrderId).entry,
      },
      z.object({}),
    );
  }
  /**
   * Places the entry and its exits as one OPOCO order list. Binance places the
   * take profit and stop loss itself once the entry fills completely, sized
   * from the quantity received after fees.
   */
  async placeProtectedEntry(entry: ProtectedEntry) {
    const order = protectedEntrySchema.parse(entry);
    const legs = protectedLegIds(order.listClientOrderId);
    return this.#request(
      "POST",
      "/api/v3/orderList/opoco",
      {
        symbol: symbol(order.instrument),
        listClientOrderId: order.listClientOrderId,
        newOrderRespType: "RESULT",
        workingType: "LIMIT",
        workingSide: "BUY",
        workingClientOrderId: legs.entry,
        workingPrice: order.price,
        workingQuantity: order.quantity,
        workingTimeInForce: order.timeInForce,
        pendingSide: "SELL",
        pendingAboveType: "LIMIT_MAKER",
        pendingAboveClientOrderId: legs.takeProfit,
        pendingAbovePrice: order.takeProfitPrice,
        // A stop-market exit still sells if the price gaps through the stop.
        pendingBelowType: "STOP_LOSS",
        pendingBelowClientOrderId: legs.stopLoss,
        pendingBelowStopPrice: order.stopLossPrice,
      },
      orderListReportSchema,
    );
  }
  async getOrderList(listClientOrderId: string) {
    return this.#request(
      "GET",
      "/api/v3/orderList",
      {
        origClientOrderId: z
          .string()
          .regex(/^ct_[A-Za-z0-9_-]{1,33}$/)
          .parse(listClientOrderId),
      },
      orderListSchema,
    );
  }
  getOpenOrderLists() {
    return this.#request(
      "GET",
      "/api/v3/openOrderList",
      {},
      z.array(orderListSchema),
    );
  }
  /** Binance cancels every order in a list when any one of them is cancelled. */
  async cancelOrderList(instrument: TestnetInstrument, orderListId: number) {
    return this.#request(
      "DELETE",
      "/api/v3/orderList",
      {
        symbol: symbol(instrument),
        orderListId: String(id.parse(orderListId)),
      },
      orderListReportSchema,
    );
  }
  async getSymbolRules(): Promise<SymbolRules[]> {
    const { symbols } = await this.#request(
      "GET",
      "/api/v3/exchangeInfo",
      { symbols: JSON.stringify(testnetInstrumentSchema.options.map(symbol)) },
      exchangeInfoSchema,
      false,
    );
    return testnetInstrumentSchema.options.map((instrument) => {
      const info = symbols.find((entry) => entry.symbol === symbol(instrument));
      if (!info) throw new BinanceTestnetError("unavailable");
      return symbolRules(instrument, info);
    });
  }
  async getSnapshot(): Promise<TestnetSnapshot> {
    const [account, btcOrders, ethOrders, btcFills, ethFills, lists] =
      await Promise.all([
        this.getAccount(),
        this.getOpenOrders("BTC-USDT"),
        this.getOpenOrders("ETH-USDT"),
        this.getFills("BTC-USDT"),
        this.getFills("ETH-USDT"),
        this.getOpenOrderLists(),
      ]);
    const orders = [...btcOrders, ...ethOrders];
    const orderLists = lists.filter((list) => instrumentForSymbol(list.symbol));
    // Binance documents no rule for whether openOrders includes the legs it
    // holds back until an entry fills, so look up any that are missing.
    const open = new Set(
      orders.map((order) => `${order.symbol}:${order.orderId}`),
    );
    const pendingOrders = (
      await Promise.all(
        orderLists.flatMap((list) =>
          list.orders
            .filter((leg) => !open.has(`${leg.symbol}:${leg.orderId}`))
            .map((leg) =>
              this.getOrderById(instrumentForSymbol(list.symbol)!, leg.orderId),
            ),
        ),
      )
    ).filter((order) => order.status === "PENDING_NEW");
    return {
      provider: "binance-spot-testnet",
      capturedAt: new Date(this.#now()).toISOString(),
      canTrade: account.canTrade,
      balances: account.balances,
      orders,
      orderLists,
      pendingOrders,
      fills: [...btcFills, ...ethFills]
        .sort((a, b) => b.time - a.time)
        .slice(0, 50),
    };
  }
}

export const exchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string(),
      status: z.string(),
      orderTypes: z.array(z.string()),
      ocoAllowed: z.boolean(),
      otoAllowed: z.boolean(),
      opoAllowed: z.boolean().default(false),
      filters: z.array(z.looseObject({ filterType: z.string() })),
    }),
  ),
});

export function symbolRules(
  instrument: TestnetInstrument,
  info: z.infer<typeof exchangeInfoSchema>["symbols"][number],
): SymbolRules {
  const filter = <T extends z.ZodType>(type: string, schema: T) => {
    const found = info.filters.find((entry) => entry.filterType === type);
    return found ? schema.parse(found) : undefined;
  };
  const price = filter(
    "PRICE_FILTER",
    z.object({ minPrice: decimal, maxPrice: decimal, tickSize: decimal }),
  );
  const lot = filter(
    "LOT_SIZE",
    z.object({ minQty: decimal, maxQty: decimal, stepSize: decimal }),
  );
  const notional =
    filter(
      "NOTIONAL",
      z.object({ minNotional: decimal, maxNotional: decimal }),
    ) ??
    filter(
      "MIN_NOTIONAL",
      z
        .object({ minNotional: decimal })
        .transform((value) => ({ ...value, maxNotional: "0" })),
    );
  if (!price || !lot) throw new BinanceTestnetError("unavailable");
  return symbolRulesSchema.parse({
    instrument,
    trading: info.status === "TRADING",
    protectedEntryAllowed:
      info.ocoAllowed &&
      info.otoAllowed &&
      info.opoAllowed &&
      ["LIMIT", "LIMIT_MAKER", "STOP_LOSS"].every((type) =>
        info.orderTypes.includes(type),
      ),
    ...price,
    ...lot,
    minNotional: notional?.minNotional ?? "0",
    maxNotional: notional?.maxNotional ?? "0",
  });
}

const symbol = binanceSymbol;
function boundedLimit(max: number) {
  return z.number().int().min(1).max(max);
}
function orderIdentifier(instrument: TestnetInstrument, clientOrderId: string) {
  z.string()
    .regex(/^ct_[A-Za-z0-9_-]{1,33}$/)
    .parse(clientOrderId);
  return { symbol: symbol(instrument), origClientOrderId: clientOrderId };
}
function orderParameters(raw: TestnetLimitOrder) {
  const order = limitOrderSchema.parse(raw);
  return {
    symbol: symbol(order.instrument),
    side: order.side,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity: order.quantity,
    price: order.price,
    newClientOrderId: order.clientOrderId,
    newOrderRespType: "RESULT",
  };
}
