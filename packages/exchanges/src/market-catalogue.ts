// Browser-safe: a venue's market catalogue, its markets with the rules an
// order must meet there, normalized from whatever form the venue publishes
// them in.
import { instrumentSchema, type Instrument } from "@crypto-trading/domain";
import { z } from "zod";
import { venueFor, type VenueId } from "./venues";

const decimal = z.string().regex(/^\d+(\.\d+)?$/);

/**
 * One market a venue lists, that is one instrument as the venue trades it,
 * with the rules an order must meet there. Zero
 * means the venue sets no such limit, except for the minimum quantity and
 * minimum notional, where zero is the limit.
 */
export const marketRulesSchema = z.object({
  instrument: instrumentSchema,
  // The venue's own name for the market, such as BTCUSDT on Binance or
  // btcusdt on HTX. Only adapters use it.
  venueSymbol: z.string().min(1).max(40),
  // `halted` covers every venue state that takes no new orders.
  status: z.enum(["trading", "halted"]),
  // Whether the venue attaches exits to an entry on this market: on Binance
  // it needs OTO, OCO and OPO lists and the LIMIT, LIMIT_MAKER and STOP_LOSS
  // types.
  protectedEntryAllowed: z.boolean(),
  minPrice: decimal,
  maxPrice: decimal,
  tickSize: decimal,
  minQty: decimal,
  maxQty: decimal,
  stepSize: decimal,
  minNotional: decimal,
  maxNotional: decimal,
  // The open stop orders an account may hold on the market, such as
  // Binance's MAX_NUM_ALGO_ORDERS. Each protected entry's stop loss is one.
  // Unset when the venue does not report it.
  maxStopOrders: z.int().positive().optional(),
});
export type MarketRules = z.infer<typeof marketRulesSchema>;

/** The venue does not list the instrument at all. */
export class UnlistedMarketError extends Error {
  constructor(
    readonly venue: VenueId,
    readonly instrument: Instrument,
  ) {
    super(`${venueFor(venue).name} does not list ${instrument}.`);
    this.name = "UnlistedMarketError";
  }
}

/**
 * The instrument's market from `adapter`, or undefined if its venue does not
 * list it. Other failures, such as the venue being unreachable, throw.
 */
export async function findMarketRules(
  adapter: { getMarketRules(instrument: Instrument): Promise<MarketRules> },
  instrument: Instrument,
): Promise<MarketRules | undefined> {
  try {
    return await adapter.getMarketRules(instrument);
  } catch (error) {
    if (error instanceof UnlistedMarketError) return undefined;
    throw error;
  }
}

// Market rules change rarely, and orders that miss a change are refused by
// the venue, so a few minutes' staleness costs nothing. The worker read
// Binance's rules this often before the catalogue existed.
export const MARKET_CATALOGUE_TTL_MS = 5 * 60_000;

type Loaded = {
  byInstrument: Map<Instrument, MarketRules>;
  byVenueSymbol: Map<string, Instrument>;
};

/**
 * One venue's markets, loaded from the venue and kept for `ttlMs`. Loads run
 * one at a time, and a failed load is not kept, so the next call tries
 * again. Share one catalogue between every client of a venue: the markets
 * are public and the same for every account.
 */
export class MarketCatalogue {
  readonly venue: VenueId;
  readonly #load: () => Promise<readonly MarketRules[]>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #loaded?: { at: number; value: Promise<Loaded> };

  constructor(options: {
    venue: VenueId;
    load: () => Promise<readonly MarketRules[]>;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.venue = options.venue;
    this.#load = options.load;
    this.#ttlMs = options.ttlMs ?? MARKET_CATALOGUE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  #current(): Promise<Loaded> {
    const now = this.#now();
    if (!this.#loaded || now - this.#loaded.at > this.#ttlMs) {
      const value = this.#load().then((markets) => {
        const byInstrument = new Map<Instrument, MarketRules>();
        const byVenueSymbol = new Map<string, Instrument>();
        for (const market of markets) {
          // A venue that lists one name twice is not trusted with either.
          if (
            byInstrument.has(market.instrument) ||
            byVenueSymbol.has(market.venueSymbol)
          )
            throw new Error(
              `${venueFor(this.venue).name} lists ${byInstrument.has(market.instrument) ? market.instrument : market.venueSymbol} more than once.`,
            );
          byInstrument.set(market.instrument, market);
          byVenueSymbol.set(market.venueSymbol, market.instrument);
        }
        return { byInstrument, byVenueSymbol };
      });
      const loaded = { at: now, value };
      this.#loaded = loaded;
      value.catch(() => {
        if (this.#loaded === loaded) this.#loaded = undefined;
      });
    }
    return this.#loaded.value;
  }

  /** Every market the venue lists. */
  async markets(): Promise<MarketRules[]> {
    return [...(await this.#current()).byInstrument.values()];
  }

  /** The instrument's market, or undefined if the venue does not list it. */
  async find(instrument: Instrument): Promise<MarketRules | undefined> {
    return (await this.#current()).byInstrument.get(instrument);
  }

  /** The instrument's market. Throws UnlistedMarketError if the venue does not list it. */
  async rules(instrument: Instrument): Promise<MarketRules> {
    const market = await this.find(instrument);
    if (!market) throw new UnlistedMarketError(this.venue, instrument);
    return market;
  }

  /** The instrument a venue symbol names, or undefined if the venue lists none. */
  async instrumentForVenueSymbol(
    venueSymbol: string,
  ): Promise<Instrument | undefined> {
    return (await this.#current()).byVenueSymbol.get(venueSymbol);
  }

  /** Drops what is loaded, so the next call loads again. */
  forget() {
    this.#loaded = undefined;
  }
}
