import "server-only";
import {
  depthSchema,
  klineSchema,
  tickerSchema,
  type KlineInterval,
  type TestnetDepth,
  type TestnetInstrument,
  type TestnetKline,
  type TestnetTicker,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import {
  callWorker,
  type WorkerRequest,
  type WorkerState,
} from "./worker-client";

async function read<T extends object>(
  request: WorkerRequest<T>,
): Promise<WorkerState<T>> {
  const result = await callWorker(request);
  return result.status === "connected"
    ? { status: "connected", ...result.data }
    : { status: result.status, message: result.message };
}

/**
 * 24h statistics from Binance Spot Testnet, at most 5 seconds old. Without
 * `symbols`, returns every symbol. With up to 500 symbols, such as "BTCUSDT",
 * returns those that have a market and leaves the rest out.
 */
export async function getMarketTickers(
  symbols?: readonly string[],
): Promise<WorkerState<{ tickers: TestnetTicker[] }>> {
  if (symbols?.length === 0) return { status: "connected", tickers: [] };
  return read({
    path: "/market/tickers",
    query: { symbols: symbols?.join(",") },
    schema: z.object({ tickers: z.array(tickerSchema) }),
  });
}

/**
 * The latest `limit` candles (1 to 1000, default 500), oldest first, at most
 * 5 seconds old. The last candle is still open.
 */
export async function getMarketKlines(
  instrument: TestnetInstrument,
  interval: KlineInterval,
  limit?: number,
): Promise<WorkerState<{ klines: TestnetKline[] }>> {
  return read({
    path: "/market/klines",
    query: { instrument, interval, limit },
    schema: z.object({ klines: z.array(klineSchema) }),
  });
}

/** The best `limit` bids and asks (1 to 100, default 100), at most 1 second old. */
export async function getMarketDepth(
  instrument: TestnetInstrument,
  limit?: number,
): Promise<WorkerState<{ depth: TestnetDepth }>> {
  return read({
    path: "/market/depth",
    query: { instrument, limit },
    schema: z.object({ depth: depthSchema }),
  });
}
