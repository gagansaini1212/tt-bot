import type { BinanceSpotTestnet } from "@crypto-trading/exchanges";
import type { ExchangeSource } from "../exchange-credentials";

/** A source with one client for every account, or none. */
export function fixedExchanges(
  exchange: BinanceSpotTestnet | undefined,
): ExchangeSource {
  return {
    market: () => exchange,
    forAccount: async () =>
      exchange ? { exchange, source: "environment" } : { problem: "exchange" },
    forget: () => {},
  };
}
