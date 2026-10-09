// Server-only: the venues the worker connects to, and how it builds a client
// for each exchange account (issue #22). Each registered venue holds what
// that venue's clients share, its market catalogue, its limits and clock,
// and its public market data client, so nothing about one venue reaches
// another's.
import { BinanceSpotTestnet } from "./binance-spot-testnet";
import { HtxSpot } from "./htx-spot";
import type {
  AccountReader,
  MarketDataAdapter,
  TradingAdapter,
} from "./contract";
import { MarketCatalogue } from "./market-catalogue";
import type { SigningCredentials } from "./signing";
import { VenueLimits } from "./venue-limits";
import {
  canPlaceOrders,
  VENUES,
  venueFor,
  type Venue,
  type VenueId,
} from "./venues";

/**
 * An exchange account's client: an AccountReader on a read-only venue, a
 * TradingAdapter on one that trades.
 */
export type AccountAdapter = AccountReader | TradingAdapter;

/**
 * Whether the worker may place orders through this client: its venue
 * `canPlaceOrders` and the client implements every order method. A
 * read-only account's client never does (ADR 0009).
 */
export function canTrade(adapter: AccountAdapter): adapter is TradingAdapter {
  return (
    canPlaceOrders(venueFor(adapter.venue)) &&
    "placeProtectedEntry" in adapter &&
    "cancelOrderList" in adapter &&
    "placeMarketSell" in adapter
  );
}

/** What the worker needs from one venue. */
export interface RegisteredVenue {
  readonly venue: Venue;
  /** Shared by every client of the venue, and by no other venue's. */
  readonly limits: VenueLimits;
  /** Public market data. Needs no keys. */
  readonly market: MarketDataAdapter;
  /**
   * A client for one exchange account's credentials. It shares the venue's
   * catalogue, limits and clock, and keeps the account's own limits. Throws
   * CredentialsError for credentials the venue cannot use.
   */
  connect(credentials: SigningCredentials): AccountAdapter;
}

/**
 * The venues the worker connects to, at most one entry per venue. A new
 * venue's adapter registers here, in the worker's index.ts.
 */
export class VenueRegistry {
  readonly #venues = new Map<VenueId, RegisteredVenue>();

  constructor(venues: Iterable<RegisteredVenue>) {
    for (const registered of venues) {
      if (this.#venues.has(registered.venue.id))
        throw new Error(`Two venues registered as ${registered.venue.id}.`);
      this.#venues.set(registered.venue.id, registered);
    }
  }

  /** The venue's entry, or undefined if the worker does not connect to it. */
  get(venue: VenueId): RegisteredVenue | undefined {
    return this.#venues.get(venue);
  }

  get venues(): VenueId[] {
    return [...this.#venues.keys()];
  }

  /**
   * A client for an exchange account on `venue`. Throws if the worker does
   * not connect to the venue, or CredentialsError.
   */
  connect(venue: VenueId, credentials: SigningCredentials): AccountAdapter {
    const registered = this.get(venue);
    if (!registered)
      throw new Error(`The worker does not connect to ${venue}.`);
    return registered.connect(credentials);
  }
}

/**
 * Binance Spot Testnet: one catalogue, one set of limits and clock, and one
 * public client for the venue, shared by every account's client.
 */
export function binanceSpotTestnetVenue({
  fetch,
  now = Date.now,
}: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
} = {}): RegisteredVenue {
  const venue = VENUES["binance-spot-testnet"];
  const limits = new VenueLimits({ venue: venue.id, now });
  const markets: MarketCatalogue = new MarketCatalogue({
    venue: venue.id,
    load: () => market.loadMarkets(),
    now,
  });
  const market: BinanceSpotTestnet = new BinanceSpotTestnet({
    publicData: true,
    markets,
    limits,
    fetch,
    now,
  });
  return {
    venue,
    limits,
    market,
    connect: (credentials) =>
      new BinanceSpotTestnet({ credentials, markets, limits, fetch, now }),
  };
}

/**
 * HTX spot, read only (ADR 0009, docs/venues/htx.md): one catalogue, one set
 * of limits and clock, and one public client for the venue, shared by every
 * HTX account's client and by no other venue's. Each account's client also
 * keeps its own limits, which HTX counts per user. Its clients implement
 * AccountReader only, so `canTrade` is false for every one of them.
 */
export function htxVenue({
  fetch,
  now = Date.now,
}: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
} = {}): RegisteredVenue {
  const venue = VENUES.htx;
  const limits = new VenueLimits({ venue: venue.id, now });
  const markets: MarketCatalogue = new MarketCatalogue({
    venue: venue.id,
    load: () => market.loadMarkets(),
    now,
  });
  const market: HtxSpot = new HtxSpot({
    publicData: true,
    markets,
    limits,
    fetch,
    now,
  });
  return {
    venue,
    limits,
    market,
    connect: (credentials) =>
      new HtxSpot({ credentials, markets, limits, fetch, now }),
  };
}
