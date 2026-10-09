import { createHmac, createPrivateKey, sign } from "node:crypto";
import { instrumentFor, type Instrument } from "@crypto-trading/domain";
import { z } from "zod";
import {
  ExchangeError,
  klineIntervalSchema,
  limitOrderSchema,
  marketSellSchema,
  MAX_DEPTH_LIMIT,
  MAX_KLINE_LIMIT,
  MAX_TICKER_SYMBOLS,
  tickerSchema,
  tickerSymbolSchema,
  type ExchangeFill,
  type ExchangeOrder,
  type ExchangeOrderList,
  type ExchangeOrderListReport,
  type AccountSnapshot,
  type KlineInterval,
  type LimitOrderRequest,
  type MarketSellRequest,
  type TradingAdapter,
} from "./contract";
import {
  MarketCatalogue,
  marketRulesSchema,
  type MarketRules,
} from "./market-catalogue";
import {
  positiveDecimal,
  protectedEntrySchema,
  protectedLegIds,
  type ProtectedEntry,
} from "./order-rules";
import { binanceClientOrderIds, binanceVenueSymbols } from "./venues";

// Deliberately fixed: this adapter cannot be configured to send real orders.
export const BINANCE_SPOT_TESTNET_URL = "https://testnet.binance.vision";
const VENUE = "binance-spot-testnet";
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
// Binance's IDs are JSON numbers. Larger ones would lose digits.
const id = z.number().int().nonnegative().refine(Number.isSafeInteger);

// Binance's own response shapes. Only this module sees them: the adapter
// returns the normalized shapes of ./contract.
const binanceBalanceSchema = z.object({
  asset: z.string(),
  free: decimal,
  locked: decimal,
});
const accountSchema = z.object({
  canTrade: z.boolean(),
  balances: z.array(binanceBalanceSchema),
});
const binanceOrderSchema = z.object({
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
  stopPrice: decimal.optional(),
});
type BinanceOrder = z.infer<typeof binanceOrderSchema>;
const binanceOrderListSchema = z.object({
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
type BinanceOrderList = z.infer<typeof binanceOrderListSchema>;
const binanceOrderListReportSchema = binanceOrderListSchema.extend({
  orderReports: z.array(binanceOrderSchema),
});
const binanceFillSchema = z.object({
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
type BinanceFill = z.infer<typeof binanceFillSchema>;

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

// The application's IDs for orders and lists it placed; the venue's own for
// any other.
const appId = (venueClientOrderId: string) =>
  binanceClientOrderIds.fromVenue(venueClientOrderId) ?? venueClientOrderId;

function toOrder(raw: BinanceOrder, instrument: Instrument): ExchangeOrder {
  return {
    instrument,
    orderId: String(raw.orderId),
    clientOrderId: appId(raw.clientOrderId),
    price: raw.price,
    origQty: raw.origQty,
    executedQty: raw.executedQty,
    cumulativeQuoteQty: raw.cummulativeQuoteQty,
    status: raw.status,
    type: raw.type,
    side: raw.side,
    orderListId: raw.orderListId < 0 ? null : String(raw.orderListId),
    ...(raw.stopPrice === undefined ? {} : { stopPrice: raw.stopPrice }),
  };
}

function toOrderList(
  raw: BinanceOrderList,
  instrument: Instrument,
): ExchangeOrderList {
  return {
    instrument,
    orderListId: String(raw.orderListId),
    contingencyType: raw.contingencyType,
    listStatusType: raw.listStatusType,
    listOrderStatus: raw.listOrderStatus,
    listClientOrderId: appId(raw.listClientOrderId),
    // A list holds orders on one symbol.
    orders: raw.orders.map((leg) => ({
      instrument,
      orderId: String(leg.orderId),
      clientOrderId: appId(leg.clientOrderId),
    })),
  };
}

function toOrderListReport(
  raw: z.infer<typeof binanceOrderListReportSchema>,
  instrument: Instrument,
): ExchangeOrderListReport {
  return {
    ...toOrderList(raw, instrument),
    orderReports: raw.orderReports.map((order) => toOrder(order, instrument)),
  };
}

function toFill(raw: BinanceFill, instrument: Instrument): ExchangeFill {
  return {
    instrument,
    id: String(raw.id),
    orderId: String(raw.orderId),
    price: raw.price,
    qty: raw.qty,
    quoteQty: raw.quoteQty,
    commission: raw.commission,
    commissionAsset: raw.commissionAsset,
    time: raw.time,
    isBuyer: raw.isBuyer,
  };
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

// Binance's "Order does not exist."
const NO_SUCH_ORDER = -2013;
// Binance's "Invalid symbol.", for a market it does not list.
const INVALID_SYMBOL = -1121;

/** An ExchangeError from Binance Spot Testnet, with Binance's numeric code. */
export class BinanceTestnetError extends ExchangeError {
  declare readonly code?: number;

  constructor(
    kind: ExchangeError["kind"],
    code?: number,
    retryAfterSeconds?: number,
    reason?: string,
  ) {
    super(kind, {
      venue: VENUE,
      code,
      retryAfterSeconds,
      reason,
      orderNotFound: kind === "rejected" && code === NO_SUCH_ORDER,
      message:
        kind === "unknown_outcome"
          ? "Binance testnet outcome is unknown. Query the client order ID before taking further action."
          : `Binance testnet request ${kind}${code === undefined ? "" : ` (code ${code})`}.${reason ? ` ${reason}` : ""}`,
    });
    this.name = "BinanceTestnetError";
  }
}

export class BinanceSpotTestnet implements TradingAdapter {
  readonly venue = VENUE;
  readonly markets: MarketCatalogue;
  // Unset on a public market data client.
  readonly #apiKey?: string;
  readonly #signPayload?: (payload: string) => string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #clockOffset = 0;
  #clockSyncedAt = -Infinity;
  #clockSync?: Promise<void>;
  #blockedUntil = 0;

  constructor(
    options: (
      | { apiKey: string; apiSecret?: string; privateKey?: string }
      // Public market data needs no key. Signed requests then throw before
      // anything is sent.
      | { publicData: true }
    ) & {
      fetch?: typeof fetch;
      now?: () => number;
      // The venue's catalogue, shared with its other clients. Without one,
      // this client keeps its own.
      markets?: MarketCatalogue;
    },
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.markets =
      options.markets ??
      new MarketCatalogue({
        venue: VENUE,
        load: () => this.loadMarkets(),
        now: this.#now,
      });
    if (this.markets.venue !== VENUE)
      throw new Error("The market catalogue belongs to another venue.");
    if ("publicData" in options) return;
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
    if (signed && (!this.#signPayload || !this.#apiKey))
      throw new Error(
        "This Binance client serves public market data only. Configure API keys for account requests.",
      );
    if (signed) await this.#syncClock();
    const query = new URLSearchParams(parameters);
    if (signed) {
      query.set("recvWindow", "5000");
      query.set("timestamp", String(this.#now() + this.#clockOffset));
      query.set("signature", this.#signPayload!(query.toString()));
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
                "X-MBX-APIKEY": this.#apiKey!,
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

  /** The instrument a Binance symbol names, from the catalogue. */
  async #instrumentFor(symbol: string) {
    const instrument = await this.markets.instrumentForVenueSymbol(symbol);
    if (!instrument) throw new BinanceTestnetError("unavailable");
    return instrument;
  }

  getAccount() {
    return this.#request(
      "GET",
      "/api/v3/account",
      { omitZeroBalances: "true" },
      accountSchema,
    );
  }
  async getOpenOrders(instrument: Instrument) {
    const orders = await this.#request(
      "GET",
      "/api/v3/openOrders",
      { symbol: symbol(instrument) },
      z.array(binanceOrderSchema),
    );
    return orders.map((order) => toOrder(order, instrument));
  }
  async getFills(instrument: Instrument) {
    const fills = await this.#request(
      "GET",
      "/api/v3/myTrades",
      { symbol: symbol(instrument), limit: "50" },
      z.array(binanceFillSchema),
    );
    return fills.map((fill) => toFill(fill, instrument));
  }
  async getOrder(instrument: Instrument, clientOrderId: string) {
    return toOrder(
      await this.#request(
        "GET",
        "/api/v3/order",
        orderIdentifier(instrument, clientOrderId),
        binanceOrderSchema,
      ),
      instrument,
    );
  }
  async testLimitOrder(order: LimitOrderRequest) {
    await this.#request(
      "POST",
      "/api/v3/order/test",
      orderParameters(order),
      z.object({}),
    );
  }
  async placeLimitOrder(raw: LimitOrderRequest) {
    const order = limitOrderSchema.parse(raw);
    return toOrder(
      await this.#request(
        "POST",
        "/api/v3/order",
        orderParameters(order),
        binanceOrderSchema,
      ),
      order.instrument,
    );
  }
  async cancelOrder(instrument: Instrument, clientOrderId: string) {
    return toOrder(
      await this.#request(
        "DELETE",
        "/api/v3/order",
        orderIdentifier(instrument, clientOrderId),
        binanceOrderSchema,
      ),
      instrument,
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
  getKlines(instrument: Instrument, interval: KlineInterval, limit = 500) {
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
  getDepth(instrument: Instrument, limit = MAX_DEPTH_LIMIT) {
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
  async getOrderById(instrument: Instrument, orderId: string) {
    return toOrder(
      await this.#request(
        "GET",
        "/api/v3/order",
        { symbol: symbol(instrument), orderId: binanceId(orderId) },
        binanceOrderSchema,
      ),
      instrument,
    );
  }
  async cancelOrderById(instrument: Instrument, orderId: string) {
    return toOrder(
      await this.#request(
        "DELETE",
        "/api/v3/order",
        { symbol: symbol(instrument), orderId: binanceId(orderId) },
        binanceOrderSchema,
      ),
      instrument,
    );
  }
  /** The latest traded price, which Binance also triggers stop orders on. */
  async getLastPrice(instrument: Instrument) {
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
  async getOrderFills(instrument: Instrument, orderId: string) {
    const fills = await this.#request(
      "GET",
      "/api/v3/myTrades",
      {
        symbol: symbol(instrument),
        orderId: binanceId(orderId),
        limit: "1000",
      },
      z.array(binanceFillSchema),
    );
    return fills.map((fill) => toFill(fill, instrument));
  }
  /**
   * Sells at market. It closes a position at whatever the book pays, so only
   * the worker's exits use it.
   */
  async placeMarketSell(raw: MarketSellRequest) {
    const order = marketSellSchema.parse(raw);
    return toOrder(
      await this.#request(
        "POST",
        "/api/v3/order",
        {
          symbol: symbol(order.instrument),
          side: "SELL",
          type: "MARKET",
          quantity: order.quantity,
          newClientOrderId: clientId(order.clientOrderId),
          newOrderRespType: "RESULT",
        },
        binanceOrderSchema,
      ),
      order.instrument,
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
        newClientOrderId: clientId(
          protectedLegIds(order.listClientOrderId).entry,
        ),
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
    const report = await this.#request(
      "POST",
      "/api/v3/orderList/opoco",
      {
        symbol: symbol(order.instrument),
        listClientOrderId: clientId(order.listClientOrderId),
        newOrderRespType: "RESULT",
        workingType: "LIMIT",
        workingSide: "BUY",
        workingClientOrderId: clientId(legs.entry),
        workingPrice: order.price,
        workingQuantity: order.quantity,
        workingTimeInForce: order.timeInForce,
        pendingSide: "SELL",
        pendingAboveType: "LIMIT_MAKER",
        pendingAboveClientOrderId: clientId(legs.takeProfit),
        pendingAbovePrice: order.takeProfitPrice,
        // A stop-market exit still sells if the price gaps through the stop.
        pendingBelowType: "STOP_LOSS",
        pendingBelowClientOrderId: clientId(legs.stopLoss),
        pendingBelowStopPrice: order.stopLossPrice,
      },
      binanceOrderListReportSchema,
    );
    return toOrderListReport(report, order.instrument);
  }
  /**
   * The list the application placed with `listClientOrderId`. Given the
   * instrument it was placed on, as the worker always knows, the list needs
   * no catalogue to name its market.
   */
  async getOrderList(listClientOrderId: string, instrument?: Instrument) {
    const list = await this.#request(
      "GET",
      "/api/v3/orderList",
      { origClientOrderId: clientId(listClientOrderId) },
      binanceOrderListSchema,
    );
    return toOrderList(
      list,
      instrument && list.symbol === symbol(instrument)
        ? instrument
        : await this.#instrumentFor(list.symbol),
    );
  }
  #openOrderLists() {
    return this.#request(
      "GET",
      "/api/v3/openOrderList",
      {},
      z.array(binanceOrderListSchema),
    );
  }
  /**
   * The account's open order lists on `instrument`, or on every market the
   * catalogue lists. Only the second needs the catalogue.
   */
  async getOpenOrderLists(instrument?: Instrument) {
    const lists = await this.#openOrderLists();
    if (instrument)
      return lists
        .filter((list) => list.symbol === symbol(instrument))
        .map((list) => toOrderList(list, instrument));
    const normalized: ExchangeOrderList[] = [];
    for (const list of lists) {
      const listed = await this.markets.instrumentForVenueSymbol(list.symbol);
      if (listed) normalized.push(toOrderList(list, listed));
    }
    return normalized;
  }
  /** Binance cancels every order in a list when any one of them is cancelled. */
  async cancelOrderList(instrument: Instrument, orderListId: string) {
    return toOrderListReport(
      await this.#request(
        "DELETE",
        "/api/v3/orderList",
        { symbol: symbol(instrument), orderListId: binanceId(orderListId) },
        binanceOrderListReportSchema,
      ),
      instrument,
    );
  }
  /**
   * Every market Binance lists, from exchangeInfo without parameters. A
   * symbol whose entry this adapter cannot read is left out, so one odd
   * listing cannot hide the rest.
   */
  async loadMarkets(): Promise<MarketRules[]> {
    const { symbols } = await this.#request(
      "GET",
      "/api/v3/exchangeInfo",
      {},
      z.object({ symbols: z.array(z.unknown()) }),
      false,
    );
    return symbols.flatMap((entry) => {
      const info = binanceSymbolInfoSchema.safeParse(entry);
      if (!info.success) return [];
      try {
        return [binanceMarketRules(info.data)];
      } catch {
        return [];
      }
    });
  }
  /** The instrument's market from the catalogue. */
  getMarketRules(instrument: Instrument) {
    return this.markets.rules(instrument);
  }
  /**
   * Balances, and open orders and recent fills on `instruments` that Binance
   * lists. Others are left out.
   */
  async getSnapshot(
    instruments: readonly Instrument[],
  ): Promise<AccountSnapshot> {
    const unique = [...new Set(instruments)];
    // A market Binance does not list answers "Invalid symbol" and is left
    // out, rather than failing the lot. This needs no catalogue.
    const unlisted = (error: unknown) => {
      if (
        error instanceof BinanceTestnetError &&
        error.kind === "rejected" &&
        error.code === INVALID_SYMBOL
      )
        return undefined;
      throw error;
    };
    const [account, perInstrument, lists] = await Promise.all([
      this.getAccount(),
      Promise.all(
        unique.map((instrument) =>
          Promise.all([
            this.getOpenOrders(instrument),
            this.getFills(instrument),
          ]).catch(unlisted),
        ),
      ),
      this.#openOrderLists(),
    ]);
    const wanted = unique.filter((_, index) => perInstrument[index]);
    const orders = perInstrument.flatMap((found) => found?.[0] ?? []);
    const fillLists = perInstrument.map((found) => found?.[1] ?? []);
    const bySymbol = new Map(
      wanted.map((instrument) => [symbol(instrument), instrument]),
    );
    const openLists = lists.flatMap((list) => {
      const instrument = bySymbol.get(list.symbol);
      return instrument ? [toOrderList(list, instrument)] : [];
    });
    // Binance documents no rule for whether openOrders includes the legs it
    // holds back until an entry fills, so look up any that are missing.
    const open = new Set(
      orders.map((order) => `${order.instrument}:${order.orderId}`),
    );
    const pendingOrders = (
      await Promise.all(
        openLists.flatMap((list) =>
          list.orders
            .filter((leg) => !open.has(`${leg.instrument}:${leg.orderId}`))
            .map((leg) => this.getOrderById(leg.instrument, leg.orderId)),
        ),
      )
    ).filter((order) => order.status === "PENDING_NEW");
    return {
      venue: VENUE,
      capturedAt: new Date(this.#now()).toISOString(),
      canTrade: account.canTrade,
      balances: account.balances,
      orders,
      orderLists: openLists,
      pendingOrders,
      fills: fillLists
        .flat()
        .sort((a, b) => b.time - a.time)
        .slice(0, 50),
    };
  }
}

const binanceSymbolInfoSchema = z.object({
  symbol: z.string(),
  status: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  orderTypes: z.array(z.string()),
  ocoAllowed: z.boolean(),
  otoAllowed: z.boolean(),
  opoAllowed: z.boolean().default(false),
  filters: z.array(z.looseObject({ filterType: z.string() })),
});
export const exchangeInfoSchema = z.object({
  symbols: z.array(binanceSymbolInfoSchema),
});
export type BinanceSymbolInfo = z.infer<typeof binanceSymbolInfoSchema>;

/**
 * A Binance exchangeInfo symbol as a catalogue market. The instrument comes
 * from the symbol's base and quote assets, never from splitting its name.
 * Throws if the symbol lacks its price or lot filter.
 */
export function binanceMarketRules(info: BinanceSymbolInfo): MarketRules {
  const instrument = instrumentFor(
    binanceVenueSymbols.assetCode(info.baseAsset),
    binanceVenueSymbols.assetCode(info.quoteAsset),
  );
  if (!instrument)
    throw new Error(`Binance's ${info.symbol} has unreadable asset codes.`);
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
  const algo = filter(
    "MAX_NUM_ALGO_ORDERS",
    z.object({ maxNumAlgoOrders: z.int().positive() }),
  );
  if (!price || !lot) throw new BinanceTestnetError("unavailable");
  return marketRulesSchema.parse({
    instrument,
    venueSymbol: info.symbol,
    status: info.status === "TRADING" ? "trading" : "halted",
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
    maxStopOrders: algo?.maxNumAlgoOrders,
  });
}

const symbol = binanceVenueSymbols.toVenueSymbol;
const clientId = binanceClientOrderIds.toVenue;
function boundedLimit(max: number) {
  return z.number().int().min(1).max(max);
}
/** An order or list ID the adapter returned, as Binance takes it back. */
function binanceId(value: string) {
  if (
    !/^(0|[1-9]\d{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Binance order IDs are whole numbers.");
  return value;
}
function orderIdentifier(instrument: Instrument, clientOrderId: string) {
  return {
    symbol: symbol(instrument),
    origClientOrderId: clientId(clientOrderId),
  };
}
function orderParameters(raw: LimitOrderRequest) {
  const order = limitOrderSchema.parse(raw);
  return {
    symbol: symbol(order.instrument),
    side: order.side,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity: order.quantity,
    price: order.price,
    newClientOrderId: clientId(order.clientOrderId),
    newOrderRespType: "RESULT",
  };
}
