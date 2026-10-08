import { z } from "zod";
import {
  binanceKlineSchema,
  exchangeInfoSchema,
  klineIntervalSchema,
  MAX_KLINE_LIMIT,
  symbolRules,
  type KlineInterval,
  type TestnetKline,
} from "./binance-spot-testnet";
import {
  binanceSymbol,
  testnetInstrumentSchema,
  type SymbolRules,
  type TestnetInstrument,
} from "./order-rules";

/**
 * Binance's market-data-only host. It serves public market data from the live
 * spot market without API keys, and has no account or order endpoints, so
 * nothing can be traded through it. Deliberately fixed, like the testnet URL.
 * See https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md
 */
export const BINANCE_MARKET_DATA_URL = "https://data-api.binance.vision";

const INTERVAL_MS: Partial<Record<KlineInterval, number>> = {
  "1m": 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export class BinanceHistoryError extends Error {
  constructor(
    public readonly kind: "unavailable" | "rate_limited",
    public readonly retryAfterSeconds?: number,
  ) {
    super(
      kind === "rate_limited"
        ? `Binance market data is rate limited. Try again in ${retryAfterSeconds} seconds.`
        : "Binance market data is unavailable. Try again later.",
    );
    this.name = "BinanceHistoryError";
  }
}

/** A market's filters, and the most stop orders an account may hold on it. */
export type HistoricalSymbolFilters = {
  rules: SymbolRules;
  maxStopOrders: number;
};

const algoOrderFilterSchema = z.object({
  filterType: z.literal("MAX_NUM_ALGO_ORDERS"),
  maxNumAlgoOrders: z.int().positive(),
});

/**
 * Read-only candle history from Binance's live spot market, for backtests:
 * the testnet keeps only about a day of candles. It sends no credentials and
 * only GET requests for klines and exchange information.
 */
export class BinanceSpotHistory {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #blockedUntil = 0;

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async #get<T>(
    path: "/api/v3/klines" | "/api/v3/exchangeInfo",
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (this.#now() < this.#blockedUntil)
      throw new BinanceHistoryError(
        "rate_limited",
        Math.ceil((this.#blockedUntil - this.#now()) / 1000),
      );
    let response: Response;
    try {
      response = await this.#fetch(
        `${BINANCE_MARKET_DATA_URL}${path}?${new URLSearchParams(parameters)}`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      throw new BinanceHistoryError("unavailable");
    }
    // Binance asks clients to back off for Retry-After seconds after a 429,
    // and bans an address that keeps sending (418).
    if (response.status === 429 || response.status === 418) {
      const seconds = Number(response.headers.get("Retry-After"));
      const retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
      this.#blockedUntil = this.#now() + retryAfter * 1000;
      throw new BinanceHistoryError("rate_limited", retryAfter);
    }
    if (!response.ok) throw new BinanceHistoryError("unavailable");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BinanceHistoryError("unavailable");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BinanceHistoryError("unavailable");
    return parsed.data;
  }

  /**
   * Candles that open from `startTime` until before `endTime`, in
   * milliseconds, oldest first. Binance returns at most 1,000 a request, from
   * the start, so this asks again from after the last one until the range is
   * covered. The latest candle may still be open: compare its close time.
   */
  async getKlines(
    instrument: TestnetInstrument,
    interval: KlineInterval,
    startTime: number,
    endTime: number,
  ): Promise<TestnetKline[]> {
    const symbol = binanceSymbol(testnetInstrumentSchema.parse(instrument));
    const step = INTERVAL_MS[klineIntervalSchema.parse(interval)];
    if (!step) throw new RangeError(`History is not kept for ${interval}.`);
    z.int().nonnegative().parse(startTime);
    z.int().nonnegative().parse(endTime);
    const klines: TestnetKline[] = [];
    // Enough pages for the range, with one to spare, so a misbehaving
    // response cannot loop forever.
    const pages = Math.ceil((endTime - startTime) / step / MAX_KLINE_LIMIT) + 1;
    let from = startTime;
    for (let page = 0; page < pages && from < endTime; page++) {
      const batch = await this.#get(
        "/api/v3/klines",
        {
          symbol,
          interval,
          startTime: String(from),
          endTime: String(endTime - 1),
          limit: String(MAX_KLINE_LIMIT),
        },
        z.array(binanceKlineSchema),
      );
      const fresh = batch.filter(
        (kline) => kline.openTime >= from && kline.openTime < endTime,
      );
      klines.push(...fresh);
      if (batch.length < MAX_KLINE_LIMIT || fresh.length === 0) break;
      from = fresh[fresh.length - 1].openTime + 1;
    }
    return klines;
  }

  /** The market's current filters, from its exchange information. */
  async getSymbolFilters(
    instrument: TestnetInstrument,
  ): Promise<HistoricalSymbolFilters> {
    const symbol = binanceSymbol(testnetInstrumentSchema.parse(instrument));
    const { symbols } = await this.#get(
      "/api/v3/exchangeInfo",
      { symbol },
      exchangeInfoSchema,
    );
    const info = symbols.find((entry) => entry.symbol === symbol);
    const algo = info?.filters
      .map((filter) => algoOrderFilterSchema.safeParse(filter))
      .find((filter) => filter.success);
    if (!info || !algo?.success) throw new BinanceHistoryError("unavailable");
    let rules: SymbolRules;
    try {
      rules = symbolRules(instrument, info);
    } catch {
      throw new BinanceHistoryError("unavailable");
    }
    return { rules, maxStopOrders: algo.data.maxNumAlgoOrders };
  }
}
