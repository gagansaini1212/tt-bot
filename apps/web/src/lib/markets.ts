import type {
  KlineInterval,
  TestnetInstrument,
} from "@crypto-trading/exchanges";

// Type-only imports from the exchange package: its adapter uses node:crypto,
// so nothing here may pull it into a client bundle.

export const markets = [
  { instrument: "BTC-USDT", symbol: "BTCUSDT", label: "BTC/USDT", base: "BTC" },
  { instrument: "ETH-USDT", symbol: "ETHUSDT", label: "ETH/USDT", base: "ETH" },
] as const satisfies readonly {
  instrument: TestnetInstrument;
  symbol: string;
  label: string;
  base: string;
}[];

export type Market = (typeof markets)[number];

export const chartIntervals = [
  "15m",
  "1h",
  "4h",
  "1d",
] as const satisfies readonly KlineInterval[];

export type ChartInterval = (typeof chartIntervals)[number];

export type MarketSelection = { market: Market; interval: ChartInterval };

const defaultSelection: MarketSelection = {
  market: markets[0],
  interval: "1h",
};

/**
 * Reads `?pair=ETH-USDT&interval=4h`. A missing, repeated or unknown value
 * falls back to BTC/USDT or 1h.
 */
export function parseMarketSelection(
  params: Record<string, string | string[] | undefined>,
): MarketSelection {
  const { pair, interval } = params;
  return {
    market:
      markets.find(({ instrument }) => instrument === pair) ??
      defaultSelection.market,
    interval:
      chartIntervals.find((value) => value === interval) ??
      defaultSelection.interval,
  };
}

export function marketsHref({ market, interval }: MarketSelection) {
  return `/markets?pair=${market.instrument}&interval=${interval}`;
}
