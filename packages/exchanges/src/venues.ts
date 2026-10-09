// Browser-safe: which venues the application knows, what each adapter can do,
// and how the application's names for markets and orders translate to each
// venue's. See docs/adr/0008-normalize-venues-markets-and-order-ids.md.
import { z } from "zod";
import {
  instrumentAssets,
  type AccountAccess,
  type Instrument,
} from "@crypto-trading/domain";

/**
 * Every venue the application has an adapter for. An exchange account's
 * `exchange` column holds one of these. Add a venue here with its
 * descriptor in VENUES below.
 */
export const VENUE_IDS = ["binance-spot-testnet"] as const;
export const venueIdSchema = z.enum(VENUE_IDS);
export type VenueId = z.infer<typeof venueIdSchema>;

/**
 * How an API key signs requests: an HMAC secret, or a private key (Ed25519,
 * RSA, or ES256 signing a JWT, as Coinbase's keys do). See ADR 0009 §6.
 */
export const exchangeKeyTypeSchema = z.enum([
  "hmac",
  "ed25519",
  "rsa",
  "es256",
]);
export type ExchangeKeyType = z.infer<typeof exchangeKeyTypeSchema>;

/** What an exchange account's credential set holds on the venue. */
export type VenueCredentials = {
  /** The key types the venue accepts. */
  readonly keyTypes: readonly ExchangeKeyType[];
  /** Whether each key comes with a passphrase, as OKX's and KuCoin's do. */
  readonly passphrase: boolean;
};

export type OrderTypeCapability =
  "limit" | "limit_maker" | "market" | "stop_loss" | "stop_loss_limit";
export type TimeInForce = "GTC" | "IOC" | "FOK";
export type OrderListCapability = "oco" | "oto" | "otoco" | "opo" | "opoco";

/**
 * What an adapter can do, stated explicitly rather than assumed alike for
 * every venue. These describe the adapter, not everything the venue offers:
 * an order type the venue has but the adapter never places is left out.
 *
 * A read-only venue, such as HTX in M4 (ADR 0009), declares `read_only`
 * access, `real` funds, no order types, order lists or attached exits, and
 * `stopOrders: "none"`. Its adapter implements AccountReader only, and its
 * exchange accounts are monitored but never traded.
 */
export type VenueCapabilities = {
  /** Market kinds the adapter trades or reads. */
  readonly marketKinds: readonly ("spot" | "perpetual")[];
  /**
   * `trade` places and cancels orders; `read_only` reads market data and the
   * account, and every order method is absent. Read-only comes from the
   * adapter, never from a customer setting.
   */
  readonly access: "trade" | "read_only";
  /**
   * `virtual` funds belong to a testnet. Only an adapter with virtual funds
   * may trade in this build: live trading stays impossible.
   */
  readonly funds: "virtual" | "real";
  /** The order types the adapter places, alone or in an order list. */
  readonly orderTypes: readonly OrderTypeCapability[];
  readonly timeInForce: readonly TimeInForce[];
  /** Contingent order lists the adapter places or reads. */
  readonly orderLists: readonly OrderListCapability[];
  /**
   * How the adapter attaches a protected entry's take profit and stop loss
   * so that the venue places them when the entry fills, or null if it
   * cannot. A venue without it cannot hold protected entries.
   */
  readonly attachedExits: "opoco" | null;
  /**
   * Whether stop orders exist only as attached exits, or also alone. A
   * stop-limit entry is held by the worker either way (ADR 0007).
   */
  readonly stopOrders: "exits_only" | "standalone" | "none";
  /** Validates an order without placing it. */
  readonly testOrders: boolean;
  /** Looks an order up by its client order ID, after an unknown outcome. */
  readonly lookupByClientOrderId: boolean;
};

/**
 * Translates the application's order ID to the client order ID a venue
 * accepts, and back.
 *
 * The application's order ID is venue-neutral: the order intent's
 * idempotency key, `ct_` and up to 30 letters, digits, `_` or `-`, or one
 * of the leg and close IDs derived from it by a suffix (`_en`, `_tp`, `_sl`,
 * `_c1` to `_c9`), so at most 36 characters in all.
 */
export interface ClientOrderIdCodec {
  /**
   * The venue's client order ID for an application order ID. Deterministic:
   * the same ID always translates the same way, so a lookup after an unknown
   * outcome finds the order a lost response placed, and a retry never makes
   * a second one. Throws if the venue cannot carry the ID.
   */
  toVenue(orderId: string): string;
  /**
   * The application order ID a venue's client order ID stands for, or
   * undefined for an order the application did not place.
   */
  fromVenue(venueClientOrderId: string): string | undefined;
}

/** Translates instrument names and asset codes to a venue's and back. */
export interface VenueSymbolCodec {
  /** BTC-USDT → the venue's symbol, such as BTCUSDT on Binance. */
  toVenueSymbol(instrument: Instrument): string;
  /**
   * A venue's asset code as the application names it, such as XBT → BTC on
   * a venue with legacy codes. The catalogue builds each instrument from its
   * base and quote asset this way, so it never parses a symbol.
   */
  assetCode(venueAsset: string): string;
}

export type Venue = {
  readonly id: VenueId;
  /** As the dashboard names it. */
  readonly name: string;
  readonly capabilities: VenueCapabilities;
  readonly credentials: VenueCredentials;
  readonly symbols: VenueSymbolCodec;
  readonly clientOrderIds: ClientOrderIdCodec;
};

/** The application's order IDs: an intent's key, or a leg or close ID derived from it. */
export const appOrderIdSchema = z.string().regex(/^ct_[A-Za-z0-9_-]{1,33}$/);

// Binance Spot documents this pattern for client order and list IDs in its
// FIX API. Its REST API states none, so the adapter keeps to it there too.
const BINANCE_CLIENT_ORDER_ID = /^[A-Za-z0-9_-]{1,36}$/;

/**
 * Binance takes the application's IDs unchanged: they already fit its client
 * order IDs, which is the `ct_` format every stored intent uses.
 */
export const binanceClientOrderIds: ClientOrderIdCodec = {
  toVenue(orderId) {
    const id = appOrderIdSchema.parse(orderId);
    if (!BINANCE_CLIENT_ORDER_ID.test(id))
      throw new Error("Binance cannot carry this client order ID.");
    return id;
  },
  fromVenue(venueClientOrderId) {
    return appOrderIdSchema.safeParse(venueClientOrderId).success
      ? venueClientOrderId
      : undefined;
  },
};

/** Binance joins the assets without a separator: BTC-USDT → BTCUSDT. */
export const binanceVenueSymbols: VenueSymbolCodec = {
  toVenueSymbol(instrument) {
    const { base, quote } = instrumentAssets(instrument);
    return `${base}${quote}`;
  },
  assetCode: (venueAsset) => venueAsset,
};

export const VENUES: { readonly [Id in VenueId]: Venue & { id: Id } } = {
  "binance-spot-testnet": {
    id: "binance-spot-testnet",
    name: "Binance Spot Testnet",
    capabilities: {
      marketKinds: ["spot"],
      access: "trade",
      funds: "virtual",
      orderTypes: ["limit", "limit_maker", "market", "stop_loss"],
      timeInForce: ["GTC", "FOK"],
      orderLists: ["opoco"],
      attachedExits: "opoco",
      stopOrders: "exits_only",
      testOrders: true,
      lookupByClientOrderId: true,
    },
    credentials: { keyTypes: ["hmac", "ed25519", "rsa"], passphrase: false },
    symbols: binanceVenueSymbols,
    clientOrderIds: binanceClientOrderIds,
  },
};

export function venueFor(id: VenueId): Venue {
  return VENUES[venueIdSchema.parse(id)];
}

/**
 * Whether the application may place orders on the venue: it trades,
 * holds only virtual funds, and can attach exits to every entry. Anything
 * else is read only, however its adapter is built, so live trading stays
 * impossible. The dashboard's order desk and the strategy runner check it
 * before every order and cancel they send (ADR 0009).
 */
export function canPlaceOrders(venue: Venue) {
  const { access, funds, attachedExits } = venue.capabilities;
  return access === "trade" && funds === "virtual" && attachedExits !== null;
}

/**
 * The modes an exchange account on the venue may have in this build:
 * `simulation` on a venue with virtual funds, such as a testnet, and `live`
 * only on a read-only venue, which never trades. A venue that would trade
 * real funds has none, since live trading stays disabled.
 */
export function accountModes(venue: Venue): ("simulation" | "live")[] {
  const { access, funds } = venue.capabilities;
  if (funds === "virtual") return ["simulation"];
  return access === "read_only" ? ["live"] : [];
}

/**
 * Whether an exchange account can be traded, from the venue ID its
 * `exchange` column holds: only on a venue that `canPlaceOrders`. An account
 * on any other venue, or on one this build has no adapter for, is read only:
 * monitored, but never the target of a strategy, proposal or order (ADR 0009).
 */
export function exchangeAccountAccess(exchange: string): AccountAccess {
  const venue = venueIdSchema.safeParse(exchange);
  return venue.success && canPlaceOrders(venueFor(venue.data))
    ? "trade"
    : "read_only";
}
