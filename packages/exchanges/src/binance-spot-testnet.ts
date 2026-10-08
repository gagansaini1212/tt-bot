import { createHmac, createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

// Deliberately fixed: this adapter cannot be configured to send real orders.
export const BINANCE_SPOT_TESTNET_URL = "https://testnet.binance.vision";
export const testnetInstrumentSchema = z.enum(["BTC-USDT", "ETH-USDT"]);
export type TestnetInstrument = z.infer<typeof testnetInstrumentSchema>;
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const positiveDecimal = decimal.refine((value) => /[1-9]/.test(value));
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
  origQty: decimal,
  executedQty: decimal,
  cummulativeQuoteQty: decimal,
  status: z.string(),
  type: z.string(),
  side: z.enum(["BUY", "SELL"]),
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
export type TestnetOrder = z.infer<typeof orderSchema>;
export type TestnetFill = z.infer<typeof fillSchema>;
export const testnetSnapshotSchema = z.object({
  provider: z.literal("binance-spot-testnet"),
  capturedAt: z.iso.datetime(),
  canTrade: z.boolean(),
  balances: z.array(balanceSchema),
  orders: z.array(orderSchema),
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
const binanceKlineSchema = z
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

export class BinanceTestnetError extends Error {
  constructor(
    public readonly kind:
      "rejected" | "unavailable" | "rate_limited" | "unknown_outcome",
    public readonly code?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === "unknown_outcome"
        ? "Binance testnet outcome is unknown. Query the client order ID before taking further action."
        : `Binance testnet request ${kind}${code === undefined ? "" : ` (code ${code})`}.`,
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
      throw new BinanceTestnetError(
        unknown
          ? "unknown_outcome"
          : response.status >= 500
            ? "unavailable"
            : "rejected",
        code,
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
  async getSnapshot(): Promise<TestnetSnapshot> {
    const [account, btcOrders, ethOrders, btcFills, ethFills] =
      await Promise.all([
        this.getAccount(),
        this.getOpenOrders("BTC-USDT"),
        this.getOpenOrders("ETH-USDT"),
        this.getFills("BTC-USDT"),
        this.getFills("ETH-USDT"),
      ]);
    return {
      provider: "binance-spot-testnet",
      capturedAt: new Date(this.#now()).toISOString(),
      canTrade: account.canTrade,
      balances: account.balances,
      orders: [...btcOrders, ...ethOrders],
      fills: [...btcFills, ...ethFills]
        .sort((a, b) => b.time - a.time)
        .slice(0, 50),
    };
  }
}

function symbol(instrument: TestnetInstrument) {
  return testnetInstrumentSchema.parse(instrument).replace("-", "");
}
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
