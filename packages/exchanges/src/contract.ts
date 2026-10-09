// Browser-safe: the exchange-neutral contract every venue adapter implements,
// and the normalized shapes it returns. The worker and the dashboard see
// these, never a venue's own responses. See docs/adr/0008.
import { instrumentSchema, type Instrument } from "@crypto-trading/domain";
import { z } from "zod";
import type { MarketCatalogue, MarketRules } from "./market-catalogue";
import type { ProtectedEntry } from "./order-rules";
import { appOrderIdSchema, venueIdSchema, type VenueId } from "./venues";

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const signedDecimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const millis = z.number().int().nonnegative().refine(Number.isSafeInteger);

/**
 * A venue's ID for an order, order list or fill, as a string whatever the
 * venue uses: Binance's numbers, UUIDs, or IDs such as OU22CG-KLAF2-FWUDD7.
 */
export const exchangeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);

export const balanceSchema = z.object({
  // The asset code as the application names it.
  asset: z.string(),
  free: decimal,
  locked: decimal,
});
export type Balance = z.infer<typeof balanceSchema>;

export const exchangeAccountSchema = z.object({
  canTrade: z.boolean(),
  balances: z.array(balanceSchema),
});
export type ExchangeAccount = z.infer<typeof exchangeAccountSchema>;

/**
 * An order as every adapter reports it. Its type and status use Binance
 * Spot's vocabulary (LIMIT, LIMIT_MAKER, MARKET, STOP_LOSS; NEW,
 * PENDING_NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED...),
 * which other adapters translate into.
 */
export const exchangeOrderSchema = z.object({
  instrument: instrumentSchema,
  orderId: exchangeIdSchema,
  // The application's order ID if the application placed the order,
  // translated back from the venue's client order ID; otherwise the venue's
  // client order ID as it reports it.
  clientOrderId: z.string(),
  price: decimal,
  // Zero for an exit the venue holds back until its entry fills.
  origQty: decimal.default("0"),
  executedQty: decimal,
  cumulativeQuoteQty: decimal,
  status: z.string(),
  type: z.string(),
  side: z.enum(["BUY", "SELL"]),
  // Set when the order belongs to an order list, such as an OPOCO.
  orderListId: exchangeIdSchema.nullable().default(null),
  // Set for stop-loss and take-profit orders, which trigger at this price.
  stopPrice: decimal.optional(),
});
export type ExchangeOrder = z.infer<typeof exchangeOrderSchema>;

export const exchangeOrderListSchema = z.object({
  instrument: instrumentSchema,
  orderListId: exchangeIdSchema,
  contingencyType: z.string(),
  listStatusType: z.string(),
  listOrderStatus: z.string(),
  // As clientOrderId: the application's ID if it placed the list.
  listClientOrderId: z.string(),
  orders: z.array(
    z.object({
      instrument: instrumentSchema,
      orderId: exchangeIdSchema,
      clientOrderId: z.string(),
    }),
  ),
});
export type ExchangeOrderList = z.infer<typeof exchangeOrderListSchema>;

export const exchangeOrderListReportSchema = exchangeOrderListSchema.extend({
  orderReports: z.array(exchangeOrderSchema),
});
export type ExchangeOrderListReport = z.infer<
  typeof exchangeOrderListReportSchema
>;

export const exchangeFillSchema = z.object({
  instrument: instrumentSchema,
  id: exchangeIdSchema,
  orderId: exchangeIdSchema,
  price: decimal,
  qty: decimal,
  quoteQty: decimal,
  commission: decimal,
  commissionAsset: z.string(),
  // When it filled, in milliseconds since the epoch.
  time: millis,
  isBuyer: z.boolean(),
});
export type ExchangeFill = z.infer<typeof exchangeFillSchema>;

/** An exchange account's balances, open orders and recent fills. */
export const accountSnapshotSchema = z.object({
  venue: venueIdSchema,
  capturedAt: z.iso.datetime(),
  canTrade: z.boolean(),
  balances: z.array(balanceSchema),
  // Open orders on the account's instruments.
  orders: z.array(exchangeOrderSchema),
  // Open order lists on those instruments, and the legs a venue holds back
  // until the list's entry fills, which may be missing from `orders`.
  orderLists: z.array(exchangeOrderListSchema).default([]),
  pendingOrders: z.array(exchangeOrderSchema).default([]),
  fills: z.array(exchangeFillSchema),
});
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

/** A limit order the CLI places. */
export const limitOrderSchema = z.object({
  instrument: instrumentSchema,
  side: z.enum(["BUY", "SELL"]),
  quantity: decimal.refine((value) => /[1-9]/.test(value)),
  price: decimal.refine((value) => /[1-9]/.test(value)),
  // A caller-supplied identifier is needed to reconcile unknown outcomes.
  clientOrderId: appOrderIdSchema,
});
export type LimitOrderRequest = z.infer<typeof limitOrderSchema>;

/**
 * A market sell the worker sends to close a protected entry's quantity, such
 * as one whose exits the venue dropped, or one past its holding deadline.
 */
export const marketSellSchema = z.object({
  instrument: instrumentSchema,
  quantity: decimal.refine((value) => /[1-9]/.test(value)),
  clientOrderId: appOrderIdSchema,
});
export type MarketSellRequest = z.infer<typeof marketSellSchema>;

// Public market data. Prices and quantities stay decimal strings.

/**
 * A Binance symbol, as its tickers carry it. Binance lists some in
 * non-Latin scripts. This still rejects lowercase, separators and anything
 * that needs escaping.
 */
export const tickerSymbolSchema = z
  .string()
  .regex(/^[\p{Lu}\p{Lo}\p{Nd}]{2,20}$/u);
/**
 * Any venue's own symbol, as its tickers carry it: in capitals, as
 * Binance's BTCUSDT, or in lowercase, as HTX's btcusdt, never mixed. Letters
 * of scripts without case and digits may join either. Separators and
 * anything that needs escaping are still refused.
 */
export const venueTickerSymbolSchema = z
  .string()
  .regex(/^(?:[\p{Lu}\p{Lo}\p{Nd}]{2,40}|[\p{Ll}\p{Lo}\p{Nd}]{2,40})$/u);
export const MAX_TICKER_SYMBOLS = 100;
// Symbols per worker /market/tickers request, which filters its list of all
// tickers. Shared here so the web client can stay under it.
export const MAX_TICKER_FILTER = 500;
export const klineIntervalSchema = z.enum([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
]);
export type KlineInterval = z.infer<typeof klineIntervalSchema>;
export const MAX_KLINE_LIMIT = 1000;
// Depth limits up to 100 cost Binance's lowest request weight.
export const MAX_DEPTH_LIMIT = 100;

/**
 * 24-hour statistics for one market. Tickers still carry the venue's own
 * symbol: the dashboard values holdings across every market the venue lists.
 */
export const tickerSchema = z.object({
  symbol: z.string(),
  lastPrice: decimal,
  openPrice: decimal,
  highPrice: decimal,
  lowPrice: decimal,
  priceChange: signedDecimal,
  priceChangePercent: signedDecimal,
  // Base-asset volume; quoteVolume is in the quote asset, e.g. USDT.
  volume: decimal,
  quoteVolume: decimal,
  openTime: millis,
  closeTime: millis,
});
export type Ticker = z.infer<typeof tickerSchema>;

export const klineSchema = z.object({
  openTime: millis,
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  volume: decimal,
  closeTime: millis,
  quoteVolume: decimal,
  trades: millis,
});
export type Kline = z.infer<typeof klineSchema>;

const depthLevelSchema = z.object({ price: decimal, quantity: decimal });
export const depthSchema = z.object({
  lastUpdateId: millis,
  // Best price first on both sides.
  bids: z.array(depthLevelSchema),
  asks: z.array(depthLevelSchema),
});
export type Depth = z.infer<typeof depthSchema>;

export type ExchangeErrorKind =
  "rejected" | "unavailable" | "rate_limited" | "unknown_outcome";

/**
 * Why a venue request failed, in terms every adapter shares:
 * - rejected: the venue refused it. Nothing changed.
 * - unavailable: the venue could not serve it now, such as during an
 *   outage or after a clock-skew error. Nothing changed, for an order
 *   request too: one whose outcome is uncertain is unknown_outcome.
 * - rate_limited: the venue asks the application to wait
 *   `retryAfterSeconds`. Nothing changed.
 * - unknown_outcome: an order request may or may not have acted. Look the
 *   order up by its client order ID before doing anything else.
 * Messages never include request URLs, signatures, headers or keys.
 */
export class ExchangeError extends Error {
  readonly kind: ExchangeErrorKind;
  readonly venue: VenueId;
  // The venue's own error code, for logs and messages.
  readonly code?: number | string;
  readonly retryAfterSeconds?: number;
  // A documented reason the venue gave for a rejection, safe to show.
  readonly reason?: string;
  // The venue says the order does not exist.
  readonly orderNotFound: boolean;

  constructor(
    kind: ExchangeErrorKind,
    details: {
      venue: VenueId;
      code?: number | string;
      retryAfterSeconds?: number;
      reason?: string;
      orderNotFound?: boolean;
      message?: string;
    },
  ) {
    super(
      details.message ??
        (kind === "unknown_outcome"
          ? "The exchange's outcome is unknown. Query the client order ID before taking further action."
          : `The exchange request was ${kind.replace("_", " ")}${details.code === undefined ? "" : ` (code ${details.code})`}.${details.reason ? ` ${details.reason}` : ""}`),
    );
    this.name = "ExchangeError";
    this.kind = kind;
    this.venue = details.venue;
    this.code = details.code;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.reason = details.reason;
    this.orderNotFound = details.orderNotFound ?? false;
  }
}

/** Public market data and the venue's market catalogue. Needs no keys. */
export interface MarketDataAdapter {
  readonly venue: VenueId;
  /** The venue's markets, shared by every client of the venue. */
  readonly markets: MarketCatalogue;
  /** Every market the venue lists, read from the venue now. */
  loadMarkets(): Promise<MarketRules[]>;
  /** The instrument's market from the catalogue. Throws UnlistedMarketError if the venue does not list it. */
  getMarketRules(instrument: Instrument): Promise<MarketRules>;
  /** 24-hour statistics for every symbol, or for the listed venue symbols. */
  getTickers(symbols?: readonly string[]): Promise<Ticker[]>;
  /** The most recent candles, oldest first. */
  getKlines(
    instrument: Instrument,
    interval: KlineInterval,
    limit?: number,
  ): Promise<Kline[]>;
  getDepth(instrument: Instrument, limit?: number): Promise<Depth>;
  /** The latest traded price, which stop orders trigger on. */
  getLastPrice(instrument: Instrument): Promise<string>;
}

/**
 * Reads an exchange account: everything a read-only venue, such as HTX in
 * M4, implements (ADR 0009). It has no order methods at all.
 */
export interface AccountReader extends MarketDataAdapter {
  getAccount(): Promise<ExchangeAccount>;
  getOpenOrders(instrument: Instrument): Promise<ExchangeOrder[]>;
  /** The account's recent fills on the instrument. */
  getFills(instrument: Instrument): Promise<ExchangeFill[]>;
  /** Every fill of one order. */
  getOrderFills(
    instrument: Instrument,
    orderId: string,
  ): Promise<ExchangeFill[]>;
  getOrderById(instrument: Instrument, orderId: string): Promise<ExchangeOrder>;
  /**
   * Balances, and open orders and recent fills on `instruments`. A venue
   * without order lists reports none.
   */
  getSnapshot(instruments: readonly Instrument[]): Promise<AccountSnapshot>;
  /**
   * What the connected API key may do, as the venue reports it, or null when
   * the venue cannot report it for this key, such as a sub-user's key on
   * HTX. An adapter whose venue has no such report leaves it out. The worker
   * asks before it saves new keys and when it tests a connection, and
   * refuses keys with more permission than the account allows
   * (`excessKeyPermissions`). Throws ExchangeError when the request fails.
   */
  getKeyPermissions?(): Promise<KeyPermissions | null>;
}

/** What an API key may do beyond reading the account. */
export type KeyPermissions = { trade: boolean; withdraw: boolean };

/**
 * Places and cancels orders, and looks up the ones the application placed
 * by its own IDs, which the adapter translates for the venue. Only an
 * adapter whose venue `canPlaceOrders` implements this.
 */
export interface TradingAdapter extends AccountReader {
  /** Looks an order up by the application's order ID. */
  getOrder(
    instrument: Instrument,
    clientOrderId: string,
  ): Promise<ExchangeOrder>;
  /**
   * Looks an order list up by the application's list ID. Pass the instrument
   * it was placed on when known.
   */
  getOrderList(
    listClientOrderId: string,
    instrument?: Instrument,
  ): Promise<ExchangeOrderList>;
  /** Open order lists on `instrument`, or on every listed market. */
  getOpenOrderLists(instrument?: Instrument): Promise<ExchangeOrderList[]>;
  testLimitOrder(order: LimitOrderRequest): Promise<void>;
  placeLimitOrder(order: LimitOrderRequest): Promise<ExchangeOrder>;
  cancelOrder(
    instrument: Instrument,
    clientOrderId: string,
  ): Promise<ExchangeOrder>;
  cancelOrderById(
    instrument: Instrument,
    orderId: string,
  ): Promise<ExchangeOrder>;
  /** Sells at market. Only the worker's exits use it. */
  placeMarketSell(order: MarketSellRequest): Promise<ExchangeOrder>;
  /** Validates the entry leg without placing it. */
  testProtectedEntry(entry: ProtectedEntry): Promise<void>;
  /** Places the entry with its exits attached, as one order list. */
  placeProtectedEntry(entry: ProtectedEntry): Promise<ExchangeOrderListReport>;
  /** Cancels every order in the list. */
  cancelOrderList(
    instrument: Instrument,
    orderListId: string,
  ): Promise<ExchangeOrderListReport>;
}
