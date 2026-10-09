import {
  DEFAULT_ALLOWED_INSTRUMENTS,
  instrumentAssets,
  instrumentLabel,
  type Instrument,
} from "@crypto-trading/domain";
import type { KlineInterval } from "@crypto-trading/exchanges";

// Type-only imports from the exchange package: its adapter uses node:crypto,
// so nothing here may pull it into a client bundle.

export type Market = { instrument: Instrument; label: string; base: string };

function market(instrument: Instrument): Market {
  return {
    instrument,
    label: instrumentLabel(instrument),
    base: instrumentAssets(instrument).base,
  };
}

/** The markets the page offers: the default allowed instruments. */
export const markets: readonly Market[] =
  DEFAULT_ALLOWED_INSTRUMENTS.map(market);

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
