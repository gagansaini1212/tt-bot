import {
  klineIntervalSchema,
  MAX_DEPTH_LIMIT,
  MAX_KLINE_LIMIT,
  MAX_TICKER_FILTER,
  tickerSymbolSchema,
  findMarketRules,
  UnlistedMarketError,
  type MarketDataAdapter,
  type Depth,
  type Kline,
  type Ticker,
} from "@crypto-trading/exchanges";
import { instrumentSchema, type Instrument } from "@crypto-trading/domain";
import { z } from "zod";
import { createCache } from "../cache";
import { publicHandler, RequestError } from "../http";

export const DEFAULT_KLINE_LIMIT = 500;

/**
 * Refuses an instrument the venue's catalogue does not list, before asking
 * the venue for its market data.
 */
async function listed(
  exchange: Pick<MarketDataAdapter, "venue" | "getMarketRules">,
  instrument: Instrument,
) {
  if (!(await findMarketRules(exchange, instrument)))
    throw new RequestError(404, {
      status: "unknown_market",
      message: new UnlistedMarketError(exchange.venue, instrument).message,
    });
}

function limit(max: number) {
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().max(max))
    .optional();
}

/**
 * 24h statistics, cached for up to 5 seconds, for every symbol of the venue
 * or the comma-separated `symbols`. Symbols without a market are left out.
 * Every market data route serves the venue its `venue` parameter names,
 * each from its own cache.
 */
export function tickers(now: () => number) {
  const cache = createCache<Ticker[]>(5_000, now);
  return publicHandler({
    query: z.strictObject({
      symbols: z
        .string()
        .transform((value) => value.split(","))
        .pipe(z.array(tickerSymbolSchema).max(MAX_TICKER_FILTER))
        .optional(),
    }),
    async handle({ exchange, query }) {
      // One request for every symbol serves any list, and an unknown symbol
      // cannot fail it, as it would if sent to Binance.
      const all = await cache(`${exchange.venue} all`, () =>
        exchange.getTickers(),
      );
      const wanted = query.symbols && new Set(query.symbols);
      return {
        status: "connected",
        tickers: wanted ? all.filter(({ symbol }) => wanted.has(symbol)) : all,
      };
    },
  });
}

/** The latest `limit` candles, oldest first, cached for up to 5 seconds. */
export function klines(now: () => number) {
  const cache = createCache<Kline[]>(5_000, now);
  return publicHandler({
    query: z.strictObject({
      instrument: instrumentSchema,
      interval: klineIntervalSchema,
      limit: limit(MAX_KLINE_LIMIT),
    }),
    async handle({ exchange, query }) {
      const { instrument, interval, limit = DEFAULT_KLINE_LIMIT } = query;
      await listed(exchange, instrument);
      // Binance charges the same weight for any limit, so fetch the maximum
      // and let every limit share one cache entry.
      const klines = await cache(
        `${exchange.venue} ${instrument} ${interval}`,
        () => exchange.getKlines(instrument, interval, MAX_KLINE_LIMIT),
      );
      return { status: "connected", klines: klines.slice(-limit) };
    },
  });
}

/** The best `limit` bids and asks, cached for up to 1 second. */
export function depth(now: () => number) {
  const cache = createCache<Depth>(1_000, now);
  return publicHandler({
    query: z.strictObject({
      instrument: instrumentSchema,
      limit: limit(MAX_DEPTH_LIMIT),
    }),
    async handle({ exchange, query }) {
      const { instrument, limit = MAX_DEPTH_LIMIT } = query;
      await listed(exchange, instrument);
      const { lastUpdateId, bids, asks } = await cache(
        `${exchange.venue} ${instrument}`,
        () => exchange.getDepth(instrument, MAX_DEPTH_LIMIT),
      );
      return {
        status: "connected",
        depth: {
          lastUpdateId,
          bids: bids.slice(0, limit),
          asks: asks.slice(0, limit),
        },
      };
    },
  });
}
