import "server-only";
import { type Instrument } from "@crypto-trading/domain";
import {
  depthSchema,
  klineSchema,
  MAX_TICKER_FILTER,
  tickerSchema,
  type KlineInterval,
  type Depth,
  type Kline,
  type Ticker,
  type VenueId,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import {
  callWorker,
  type WorkerRequest,
  type WorkerState,
} from "./worker-client";

/**
 * The venue the Markets page and holdings valuation read: every exchange
 * account trades on Binance Spot Testnet until the dashboard shows another
 * venue's markets.
 */
export const MARKET_DATA_VENUE: VenueId = "binance-spot-testnet";

async function read<T extends object>(
  request: WorkerRequest<T>,
): Promise<WorkerState<T>> {
  const result = await callWorker(request);
  return result.status === "connected"
    ? { status: "connected", ...result.data }
    : { status: result.status, message: result.message };
}

/**
 * 24h statistics from `venue`, cached for up to 5 seconds.
 * Without `symbols`, returns every symbol. With symbols such as "BTCUSDT",
 * returns those that have a market and leaves the rest out.
 *
 * To value balances in USDT, note that some assets have no `<ASSET>USDT`
 * market: fiat-like assets are quoted as `USDT<ASSET>` (use the inverse), and
 * others only through another quote asset. USDT itself has no ticker.
 */
export async function getMarketTickers(
  symbols?: readonly string[],
  venue: VenueId = MARKET_DATA_VENUE,
): Promise<WorkerState<{ tickers: Ticker[] }>> {
  if (symbols?.length === 0) return { status: "connected", tickers: [] };
  // Longer lists exceed the worker's filter, so filter every ticker here.
  const filtered = symbols && symbols.length <= MAX_TICKER_FILTER;
  const state = await read({
    path: "/market/tickers",
    query: { venue, symbols: filtered ? symbols.join(",") : undefined },
    schema: z.object({ tickers: z.array(tickerSchema) }),
  });
  if (!symbols || filtered || state.status !== "connected") return state;
  const wanted = new Set(symbols);
  return {
    status: "connected",
    tickers: state.tickers.filter(({ symbol }) => wanted.has(symbol)),
  };
}

/**
 * The latest `limit` candles (1 to 1000, default 500), oldest first, cached
 * for up to 5 seconds. The last candle is still open.
 */
export async function getMarketKlines(
  instrument: Instrument,
  interval: KlineInterval,
  limit?: number,
  venue: VenueId = MARKET_DATA_VENUE,
): Promise<WorkerState<{ klines: Kline[] }>> {
  return read({
    path: "/market/klines",
    query: { venue, instrument, interval, limit },
    schema: z.object({ klines: z.array(klineSchema) }),
  });
}

/** The best `limit` bids and asks (1 to 100, default 100), cached for up to 1 second. */
export async function getMarketDepth(
  instrument: Instrument,
  limit?: number,
  venue: VenueId = MARKET_DATA_VENUE,
): Promise<WorkerState<{ depth: Depth }>> {
  return read({
    path: "/market/depth",
    query: { venue, instrument, limit },
    schema: z.object({ depth: depthSchema }),
  });
}
