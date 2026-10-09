import type {
  AccountAdapter,
  MarketDataAdapter,
} from "@crypto-trading/exchanges";
import type { ExchangeSource } from "../exchange-credentials";

/** A source with one client for every account and venue, or none. */
export function fixedExchanges(
  exchange: (AccountAdapter & MarketDataAdapter) | undefined,
): ExchangeSource {
  return {
    market: () => exchange,
    forAccount: async () =>
      exchange ? { exchange, source: "environment" } : { problem: "exchange" },
    forget: () => {},
  };
}
