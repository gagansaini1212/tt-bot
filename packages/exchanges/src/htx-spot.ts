// Server-only: a read-only adapter for HTX's spot API. It reads the market
// catalogue, public market data and an exchange account's balances, open
// orders and fills, and holds no code that places, cancels or withdraws
// anything (ADR 0009). See docs/venues/htx.md for the API it follows.
import {
  ExactDecimal,
  instrumentFor,
  type Instrument,
} from "@crypto-trading/domain";
import Decimal from "decimal.js";
import { z } from "zod";
import {
  ExchangeError,
  klineIntervalSchema,
  MAX_DEPTH_LIMIT,
  MAX_KLINE_LIMIT,
  MAX_TICKER_FILTER,
  type AccountReader,
  type AccountSnapshot,
  type Balance,
  type Depth,
  type ExchangeAccount,
  type ExchangeErrorKind,
  type ExchangeFill,
  type ExchangeOrder,
  type Kline,
  type KlineInterval,
  type Ticker,
} from "./contract";
import {
  htxCanonicalQuery,
  htxSignatureV2,
  type HtxSigner,
} from "./htx-signature";
import {
  MarketCatalogue,
  marketRulesSchema,
  type MarketRules,
} from "./market-catalogue";
import { htxClientOrderIds, htxVenueSymbols } from "./venues";

// Deliberately fixed. HTX documents api.huobi.pro and api-aws.huobi.pro, and
// the host is part of what a request's signature covers.
export const HTX_SPOT_HOST = "api.huobi.pro";
const VENUE = "htx";

type Reviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

/**
 * HTX's JSON with every number kept as its source text. HTX sends prices
 * and amounts as JSON numbers, some in exponent form such as 5.0E-5, and
 * some IDs are longer than a double holds, so no number passes through one.
 */
export function parseHtxJson(text: string): unknown {
  return (JSON.parse as (text: string, reviver: Reviver) => unknown)(
    text,
    (_key, value, context) => {
      if (typeof value !== "number") return value;
      if (context?.source === undefined)
        throw new Error("This runtime cannot read JSON numbers exactly.");
      return context.source;
    },
  );
}

// A number as HTX wrote it, as a JSON string or a number's source text,
// possibly in exponent form. The schemas below read it as a plain decimal.
const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const signedAmount = z
  .string()
  .regex(NUMBER)
  .transform((value) => new ExactDecimal(value));
const decimal = z.string().regex(/^\d+(\.\d+)?$/);
/** A non-negative amount, as a plain decimal string. */
const amount = signedAmount.transform((value) => value.toFixed()).pipe(decimal);
// HTX leaves some amounts empty, such as the fee a deduction paid instead.
const optionalAmount = z
  .union([z.literal(""), amount])
  .nullish()
  .transform((value) => value || "0");
// Order, fill and account IDs, kept as strings.
const htxId = z.string().regex(/^\d{1,20}$/);
const millis = z
  .string()
  .regex(/^\d{1,16}$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().refine(Number.isSafeInteger));
const precision = z
  .string()
  .regex(/^\d{1,2}$/)
  .transform(Number);

// HTX's own response shapes. Only this module sees them: the adapter
// returns the normalized shapes of ./contract.
const htxOrderSchema = z.object({
  id: htxId,
  symbol: z.string(),
  "client-order-id": z.string().nullish(),
  price: amount,
  amount,
  // HTX's order lookup spells these "field-…" in its documented response.
  "filled-amount": amount.optional(),
  "field-amount": amount.optional(),
  "filled-cash-amount": amount.optional(),
  "field-cash-amount": amount.optional(),
  state: z.string(),
  type: z.string().regex(/^(buy|sell)-[a-z-]+$/),
  "stop-price": optionalAmount,
});
type HtxOrder = z.infer<typeof htxOrderSchema>;
const htxFillSchema = z.object({
  id: htxId,
  symbol: z.string(),
  "order-id": htxId,
  price: amount,
  "filled-amount": amount,
  // Negative for a maker rebate.
  "filled-fees": z
    .union([z.literal(""), signedAmount])
    .nullish()
    .transform((value) => value || new ExactDecimal(0)),
  "fee-currency": z.string(),
  "filled-points": optionalAmount,
  "fee-deduct-currency": z.string().nullish(),
  "created-at": millis,
  type: z.string().regex(/^(buy|sell)-[a-z-]+$/),
});
type HtxFill = z.infer<typeof htxFillSchema>;
const htxMarketSymbolSchema = z.object({
  symbol: z.string(),
  state: z.string(),
  bc: z.string(),
  qc: z.string(),
  pp: precision,
  ap: precision,
  minoa: amount,
  maxoa: amount,
  minov: amount,
  at: z.string().optional(),
});
export type HtxMarketSymbol = z.infer<typeof htxMarketSymbolSchema>;
const htxTickerSchema = z.object({
  symbol: z.string(),
  open: amount,
  high: amount,
  low: amount,
  close: amount,
  amount,
  vol: amount,
});
const htxLevelsSchema = z
  .array(z.tuple([amount, amount]))
  .transform((levels) =>
    levels.map(([price, quantity]) => ({ price, quantity })),
  );

// Order states and types in Binance Spot's vocabulary, the contract's
// (ADR 0008). Others are passed on in capitals.
const ORDER_STATUS: Record<string, string> = {
  created: "NEW",
  submitted: "NEW",
  "partial-filled": "PARTIALLY_FILLED",
  filled: "FILLED",
  "partial-canceled": "CANCELED",
  canceling: "PENDING_CANCEL",
  canceled: "CANCELED",
};
const ORDER_TYPE: Record<string, string> = {
  limit: "LIMIT",
  "limit-maker": "LIMIT_MAKER",
  ioc: "LIMIT",
  "limit-fok": "LIMIT",
  market: "MARKET",
  "stop-limit": "STOP_LOSS_LIMIT",
  "stop-limit-fok": "STOP_LOSS_LIMIT",
  "limit-grid": "LIMIT",
  "market-grid": "MARKET",
};
const capitals = (value: string) => value.toUpperCase().replaceAll("-", "_");

function toOrder(raw: HtxOrder, instrument: Instrument): ExchangeOrder {
  const [side, ...kind] = raw.type.split("-");
  const type = kind.join("-");
  const clientOrderId = raw["client-order-id"] ?? "";
  return {
    instrument,
    orderId: raw.id,
    clientOrderId: htxClientOrderIds.fromVenue(clientOrderId) ?? clientOrderId,
    price: raw.price,
    // A market buy's amount is its value in the quote asset, not a quantity.
    origQty: raw.type === "buy-market" ? "0" : raw.amount,
    executedQty: raw["filled-amount"] ?? raw["field-amount"] ?? "0",
    cumulativeQuoteQty:
      raw["filled-cash-amount"] ?? raw["field-cash-amount"] ?? "0",
    status: ORDER_STATUS[raw.state] ?? capitals(raw.state),
    type: ORDER_TYPE[type] ?? capitals(type),
    side: side === "buy" ? "BUY" : "SELL",
    orderListId: null,
    ...(raw["stop-price"] === "0" ? {} : { stopPrice: raw["stop-price"] }),
  };
}

/**
 * A fill's commission is what HTX charged in the fee currency or, when the
 * account pays fees with HT or points, the deduction. A maker rebate is
 * income, not a commission, so it counts as none.
 */
function toFill(raw: HtxFill, instrument: Instrument): ExchangeFill {
  const fees = raw["filled-fees"];
  const deducted =
    !fees.greaterThan(0) &&
    raw["filled-points"] !== "0" &&
    raw["fee-deduct-currency"];
  return {
    instrument,
    id: raw.id,
    orderId: raw["order-id"],
    price: raw.price,
    qty: raw["filled-amount"],
    quoteQty: new ExactDecimal(raw.price).times(raw["filled-amount"]).toFixed(),
    commission: deducted
      ? raw["filled-points"]
      : fees.greaterThan(0)
        ? fees.toFixed()
        : "0",
    commissionAsset: htxVenueSymbols.assetCode(
      deducted ? raw["fee-deduct-currency"]! : raw["fee-currency"],
    ),
    time: raw["created-at"],
    isBuyer: raw.type.startsWith("buy-"),
  };
}

// HTX starts its days at midnight Singapore time (UTC+8).
const SINGAPORE_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
function singaporeDayStart(time: number) {
  return (
    Math.floor((time + SINGAPORE_OFFSET_MS) / DAY_MS) * DAY_MS -
    SINGAPORE_OFFSET_MS
  );
}

/**
 * HTX's candle periods, from its kline documentation. The contract's 3m, 2h,
 * 6h, 8h, 12h and 3d have none.
 */
const KLINE_PERIODS: Partial<Record<KlineInterval, string>> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "60min",
  "4h": "4hour",
  "1d": "1day",
  "1w": "1week",
  "1M": "1mon",
};
const KLINE_MS: Partial<Record<KlineInterval, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": DAY_MS,
  "1w": 7 * DAY_MS,
};
/** The last millisecond of a candle opening at `openTime`. */
function klineCloseTime(interval: KlineInterval, openTime: number) {
  if (interval !== "1M") return openTime + KLINE_MS[interval]! - 1;
  // Months start at midnight Singapore time.
  const start = new Date(openTime + SINGAPORE_OFFSET_MS);
  return (
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) -
    SINGAPORE_OFFSET_MS -
    1
  );
}

// HTX's depth parameter takes 5, 10 or 20 levels, or 150 when left out.
const DEPTH_STEPS = [5, 10, 20] as const;

// Error codes from HTX's Spot API documentation.
const RATE_LIMITED = new Set(["1006", "frequent-invoke"]);
const UNAVAILABLE = new Set([
  "500",
  "base-system-error",
  "gateway-internal-error",
]);
const ORDER_NOT_FOUND = new Set([
  "base-record-invalid",
  "base-not-found",
  "not-found",
]);
// What HTX answers a sub-user's key on an endpoint only a parent user may
// call, such as GET /v2/user/api-key.
const FORBIDDEN = new Set(["403", "1002"]);
const RATE_LIMIT_WAIT_SECONDS = 10;

/**
 * An ExchangeError from HTX, with HTX's error code. The adapter sends no
 * order requests, so an outcome is never unknown.
 */
export class HtxError extends ExchangeError {
  declare readonly code?: string;
  /** HTX refused this key access to the endpoint, as it does a sub-user's. */
  readonly forbidden: boolean;

  constructor(
    kind: Exclude<ExchangeErrorKind, "unknown_outcome">,
    details: {
      code?: string;
      retryAfterSeconds?: number;
      reason?: string;
      orderNotFound?: boolean;
      forbidden?: boolean;
    } = {},
  ) {
    const { forbidden = false, ...rest } = details;
    super(kind, {
      venue: VENUE,
      ...rest,
      message: `HTX request ${kind.replace("_", " ")}${rest.code === undefined ? "" : ` (${rest.code})`}.${rest.reason ? ` ${rest.reason}` : ""}`,
    });
    this.name = "HtxError";
    this.forbidden = forbidden;
  }
}

/** The permissions HTX reports for an API key. */
type HtxKeyPermissions = { trade: boolean; withdraw: boolean };

/**
 * HTX spot, read only. Its capabilities say `read_only`, it implements
 * AccountReader and nothing more, and every request it sends is a GET.
 */
export class HtxSpot implements AccountReader {
  readonly venue = VENUE;
  readonly markets: MarketCatalogue;
  // Unset on a public market data client.
  readonly #accessKey?: string;
  readonly #signer?: HtxSigner;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #clockOffset = 0;
  #clockSyncedAt = -Infinity;
  #clockSync?: Promise<void>;
  #blockedUntil = 0;
  #spotAccountId?: Promise<string>;

  constructor(
    options: (
      | {
          /** HTX's Access Key. */
          apiKey: string;
          /** HTX's Secret Key. */
          apiSecret: string;
        }
      // Public market data needs no key. Signed requests then throw before
      // anything is sent.
      | { publicData: true }
    ) & {
      fetch?: typeof fetch;
      now?: () => number;
      // The venue's catalogue, shared with its other clients. Without one,
      // this client keeps its own.
      markets?: MarketCatalogue;
    },
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.markets =
      options.markets ??
      new MarketCatalogue({
        venue: VENUE,
        load: () => this.loadMarkets(),
        now: this.#now,
      });
    if (this.markets.venue !== VENUE)
      throw new Error("The market catalogue belongs to another venue.");
    if ("publicData" in options) return;
    this.#signer = htxSignatureV2({
      accessKey: options.apiKey,
      secretKey: options.apiSecret,
    });
    this.#accessKey = options.apiKey;
  }

  async #syncClock() {
    if (this.#now() - this.#clockSyncedAt < 60_000) return;
    if (!this.#clockSync) {
      this.#clockSync = (async () => {
        const start = this.#now();
        const { data } = await this.#request(
          "/v1/common/timestamp",
          {},
          z.object({ data: millis }),
          false,
        );
        this.#clockOffset = data - Math.floor((start + this.#now()) / 2);
        this.#clockSyncedAt = this.#now();
      })().finally(() => {
        this.#clockSync = undefined;
      });
    }
    await this.#clockSync;
  }

  /** A GET request, signed unless `signed` is false. There is no other kind. */
  async #request<T>(
    path: string,
    parameters: Record<string, string>,
    schema: z.ZodType<T>,
    signed = true,
  ): Promise<T> {
    if (this.#now() < this.#blockedUntil) {
      throw new HtxError("rate_limited", {
        retryAfterSeconds: Math.ceil((this.#blockedUntil - this.#now()) / 1000),
      });
    }
    if (signed && !this.#signer)
      throw new Error(
        "This HTX client serves public market data only. Configure API keys for account requests.",
      );
    if (signed) await this.#syncClock();
    const query = signed
      ? this.#signer!.sign({
          host: HTX_SPOT_HOST,
          path,
          parameters,
          time: this.#now() + this.#clockOffset,
        })
      : htxCanonicalQuery(parameters);
    let response: Response;
    try {
      response = await this.#fetch(
        `https://${HTX_SPOT_HOST}${path}${query ? `?${query}` : ""}`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      // Never include request URLs, signatures, headers or transport errors.
      throw new HtxError("unavailable");
    }
    let body: unknown;
    try {
      body = parseHtxJson(await response.text());
    } catch {
      // Some proxies return HTML errors. HTTP rate limits must still apply.
      body = undefined;
    }
    // HTX reports most errors with HTTP 200: v1 endpoints with status
    // "error" and an err-code, v2 endpoints with a code other than 200.
    const envelope = z
      .looseObject({
        status: z.string().optional(),
        "err-code": z.string().optional(),
        code: z.string().optional(),
      })
      .safeParse(body);
    const failed =
      envelope.success &&
      (envelope.data.status === "error" ||
        (envelope.data.code !== undefined && envelope.data.code !== "200"));
    if (!response.ok || failed) {
      const reported = envelope.success
        ? (envelope.data["err-code"] ?? envelope.data.code)
        : undefined;
      // Codes are short slugs or numbers. Anything else could echo a request.
      const code =
        reported && /^[A-Za-z0-9._-]{1,64}$/.test(reported)
          ? reported
          : undefined;
      if (response.status === 429 || (code && RATE_LIMITED.has(code))) {
        const seconds = Number(response.headers.get("Retry-After"));
        const retryAfter =
          Number.isFinite(seconds) && seconds > 0
            ? seconds
            : RATE_LIMIT_WAIT_SECONDS;
        this.#blockedUntil = this.#now() + retryAfter * 1000;
        throw new HtxError("rate_limited", {
          code,
          retryAfterSeconds: retryAfter,
        });
      }
      if (response.status >= 500 || (code && UNAVAILABLE.has(code)))
        throw new HtxError("unavailable", { code });
      throw new HtxError("rejected", {
        code,
        orderNotFound: code !== undefined && ORDER_NOT_FOUND.has(code),
        forbidden:
          response.status === 403 ||
          (code !== undefined && FORBIDDEN.has(code)),
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HtxError("unavailable");
    return parsed.data;
  }

  /** The ID of the API key's spot account, which balances and open orders need. */
  #spotAccount() {
    this.#spotAccountId ??= this.#request(
      "/v1/account/accounts",
      {},
      z.object({
        data: z.array(z.object({ id: htxId, type: z.string() })),
      }),
    ).then(({ data }) => {
      const spot = data.find((account) => account.type === "spot");
      if (!spot)
        throw new HtxError("rejected", {
          reason: "This HTX user has no spot account.",
        });
      return spot.id;
    });
    const pending = this.#spotAccountId;
    // A failed lookup is not kept, so the next request tries again.
    pending.catch(() => {
      if (this.#spotAccountId === pending) this.#spotAccountId = undefined;
    });
    return pending;
  }

  /**
   * The spot account's balances, without assets it holds none of. HTX's
   * `trade` balance is free; `frozen` and `lock` are locked. The product never
   * trades an HTX account, so canTrade is false whatever the key allows.
   */
  async getAccount(): Promise<ExchangeAccount> {
    const accountId = await this.#spotAccount();
    const { data } = await this.#request(
      `/v1/account/accounts/${accountId}/balance`,
      {},
      z.object({
        data: z.object({
          list: z.array(
            z.object({
              currency: z.string(),
              type: z.string(),
              balance: amount,
            }),
          ),
        }),
      }),
    );
    const totals = new Map<string, { free: Decimal; locked: Decimal }>();
    for (const entry of data.list) {
      const side =
        entry.type === "trade"
          ? "free"
          : entry.type === "frozen" || entry.type === "lock"
            ? "locked"
            : undefined;
      if (!side) continue;
      const asset = htxVenueSymbols.assetCode(entry.currency);
      const total = totals.get(asset) ?? {
        free: new ExactDecimal(0),
        locked: new ExactDecimal(0),
      };
      total[side] = total[side].plus(entry.balance);
      totals.set(asset, total);
    }
    const balances: Balance[] = [];
    for (const [asset, { free, locked }] of totals)
      if (!free.isZero() || !locked.isZero())
        balances.push({
          asset,
          free: free.toFixed(),
          locked: locked.toFixed(),
        });
    return { canTrade: false, balances };
  }

  /** The spot account's open orders: on `instrument`, or on every market. */
  async #openOrders(instrument?: Instrument) {
    const accountId = await this.#spotAccount();
    const { data } = await this.#request(
      "/v1/order/openOrders",
      {
        "account-id": accountId,
        ...(instrument ? { symbol: symbol(instrument) } : {}),
        size: "500",
      },
      z.object({ data: z.array(htxOrderSchema) }),
    );
    return data;
  }

  async getOpenOrders(instrument: Instrument) {
    const orders = await this.#openOrders(instrument);
    return orders
      .filter((order) => order.symbol === symbol(instrument))
      .map((order) => toOrder(order, instrument));
  }

  /** The account's fills on the instrument in the last 48 hours, newest first, at most 50. */
  async getFills(instrument: Instrument) {
    const { data } = await this.#request(
      "/v1/order/matchresults",
      { symbol: symbol(instrument), size: "50" },
      z.object({ data: z.array(htxFillSchema) }),
    );
    return data
      .filter((fill) => fill.symbol === symbol(instrument))
      .map((fill) => toFill(fill, instrument));
  }

  /** Every fill of one order. */
  async getOrderFills(instrument: Instrument, orderId: string) {
    const { data } = await this.#request(
      `/v1/order/orders/${htxOrderId(orderId)}/matchresults`,
      {},
      z.object({ data: z.array(htxFillSchema) }),
    );
    return data
      .filter((fill) => fill.symbol === symbol(instrument))
      .map((fill) => toFill(fill, instrument));
  }

  /** The order with HTX's `orderId`, if it is on `instrument`. */
  async getOrderById(instrument: Instrument, orderId: string) {
    const { data } = await this.#request(
      `/v1/order/orders/${htxOrderId(orderId)}`,
      {},
      z.object({ data: htxOrderSchema }),
    );
    if (data.symbol !== symbol(instrument))
      throw new HtxError("rejected", { orderNotFound: true });
    return toOrder(data, instrument);
  }

  /**
   * Balances, and open orders and fills from the last 48 hours on
   * `instruments` that HTX lists. Others are left out. HTX has no order
   * lists, so there are none.
   */
  async getSnapshot(
    instruments: readonly Instrument[],
  ): Promise<AccountSnapshot> {
    const listed = (
      await Promise.all(
        [...new Set(instruments)].map((instrument) =>
          this.markets.find(instrument),
        ),
      )
    ).filter((market) => market !== undefined);
    const bySymbol = new Map(
      listed.map((market) => [market.venueSymbol, market.instrument]),
    );
    const [account, open, fills] = await Promise.all([
      this.getAccount(),
      // One request covers every market.
      listed.length ? this.#openOrders() : [],
      Promise.all(listed.map((market) => this.getFills(market.instrument))),
    ]);
    const orders = open.flatMap((order) => {
      const instrument = bySymbol.get(order.symbol);
      return instrument ? [toOrder(order, instrument)] : [];
    });
    return {
      venue: VENUE,
      capturedAt: new Date(this.#now()).toISOString(),
      canTrade: account.canTrade,
      balances: account.balances,
      orders,
      orderLists: [],
      pendingOrders: [],
      fills: fills
        .flat()
        .sort((a, b) => b.time - a.time)
        .slice(0, 50),
    };
  }

  /**
   * What HTX reports for this API key, from GET /v2/user/api-key, or null
   * when HTX will not say. It answers only a parent user's key: a
   * sub-user's key is refused there.
   */
  async getKeyPermissions(): Promise<HtxKeyPermissions | null> {
    try {
      const { data: uid } = await this.#request(
        "/v2/user/uid",
        {},
        z.object({ data: htxId }),
      );
      const { data: keys } = await this.#request(
        "/v2/user/api-key",
        { uid, accessKey: this.#accessKey! },
        z.object({
          data: z.array(
            z.object({ accessKey: z.string(), permission: z.string() }),
          ),
        }),
      );
      const key = keys.find((entry) => entry.accessKey === this.#accessKey);
      if (!key) throw new HtxError("unavailable");
      const permissions = key.permission
        .split(",")
        .map((permission) => permission.trim())
        .filter(Boolean);
      // A permission HTX has not documented may allow anything.
      if (
        permissions.some(
          (permission) =>
            !["readOnly", "trade", "withdraw"].includes(permission),
        )
      )
        throw new HtxError("unavailable", {
          reason:
            "HTX reported an API key permission this adapter does not know.",
        });
      return {
        trade: permissions.includes("trade"),
        withdraw: permissions.includes("withdraw"),
      };
    } catch (error) {
      if (error instanceof HtxError && error.forbidden) return null;
      throw error;
    }
  }

  /**
   * Refuses an API key that can trade or withdraw. Resolves to `verified`
   * when HTX reports a read-only key, and to `unverified` when it will not
   * report the key's permissions, as for a sub-user's key: the customer must
   * then confirm the key is read only.
   */
  async checkReadOnlyKey(): Promise<"verified" | "unverified"> {
    const permissions = await this.getKeyPermissions();
    if (!permissions) return "unverified";
    if (permissions.trade || permissions.withdraw)
      throw new HtxError("rejected", {
        reason:
          "This HTX API key can trade or withdraw. Connect a key with read permission only.",
      });
    return "verified";
  }

  /**
   * Every market HTX lists, from GET /v1/settings/common/market-symbols.
   * Offline (delisted) symbols are left out, as is any entry this adapter
   * cannot read or whose symbol is not its base and quote joined, so one odd
   * listing cannot hide the rest.
   */
  async loadMarkets(): Promise<MarketRules[]> {
    const { data } = await this.#request(
      "/v1/settings/common/market-symbols",
      {},
      z.object({ data: z.array(z.unknown()) }),
      false,
    );
    return data.flatMap((entry) => {
      const info = htxMarketSymbolSchema.safeParse(entry);
      if (!info.success || info.data.state === "offline") return [];
      try {
        return [htxMarketRules(info.data)];
      } catch {
        return [];
      }
    });
  }

  /** The instrument's market from the catalogue. */
  getMarketRules(instrument: Instrument) {
    return this.markets.rules(instrument);
  }

  /**
   * Statistics for every symbol, or for the listed venue symbols, such as
   * btcusdt. HTX's open, high, low and price change run from midnight
   * Singapore time (16:00 UTC), which `openTime` says; its volumes cover
   * the last 24 hours. A ticker this adapter cannot read is left out.
   */
  async getTickers(symbols?: readonly string[]): Promise<Ticker[]> {
    const wanted =
      symbols &&
      new Set(
        z
          .array(z.string().regex(/^[\p{Ll}\p{Lo}\p{Nd}]{2,40}$/u))
          .min(1)
          .max(MAX_TICKER_FILTER)
          .parse(symbols),
      );
    const { ts, data } = await this.#request(
      "/market/tickers",
      {},
      z.object({ ts: millis, data: z.array(z.unknown()) }),
      false,
    );
    return data.flatMap((entry) => {
      const ticker = htxTickerSchema.safeParse(entry);
      if (!ticker.success || (wanted && !wanted.has(ticker.data.symbol)))
        return [];
      const { symbol, open, high, low, close } = ticker.data;
      const change = new ExactDecimal(close).minus(open);
      return [
        {
          symbol,
          lastPrice: close,
          openPrice: open,
          highPrice: high,
          lowPrice: low,
          priceChange: change.toFixed(),
          priceChangePercent: new ExactDecimal(open).isZero()
            ? "0"
            : change
                .dividedBy(open)
                .times(100)
                .toFixed(3, Decimal.ROUND_HALF_UP),
          volume: ticker.data.amount,
          quoteVolume: ticker.data.vol,
          openTime: singaporeDayStart(ts),
          closeTime: ts,
        },
      ];
    });
  }

  /**
   * The most recent candles, oldest first. Daily and longer candles start at
   * midnight Singapore time. Throws for an interval HTX has no candles for.
   */
  async getKlines(
    instrument: Instrument,
    interval: KlineInterval,
    limit = 500,
  ): Promise<Kline[]> {
    const period = KLINE_PERIODS[klineIntervalSchema.parse(interval)];
    if (!period)
      throw new HtxError("rejected", {
        reason: `HTX has no ${interval} candles.`,
      });
    const { data } = await this.#request(
      "/market/history/kline",
      {
        symbol: symbol(instrument),
        period,
        size: String(boundedLimit(MAX_KLINE_LIMIT).parse(limit)),
      },
      z.object({
        data: z.array(
          z.object({
            id: millis,
            open: amount,
            close: amount,
            low: amount,
            high: amount,
            amount,
            vol: amount,
            count: millis,
          }),
        ),
      }),
      false,
    );
    // HTX sends the newest first.
    return data
      .map((candle) => {
        const openTime = candle.id * 1000;
        return {
          openTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.amount,
          closeTime: klineCloseTime(interval, openTime),
          quoteVolume: candle.vol,
          trades: candle.count,
        };
      })
      .sort((a, b) => a.openTime - b.openTime);
  }

  /** The best `limit` bids and asks, unaggregated. */
  async getDepth(
    instrument: Instrument,
    limit = MAX_DEPTH_LIMIT,
  ): Promise<Depth> {
    const levels = boundedLimit(MAX_DEPTH_LIMIT).parse(limit);
    const depth = DEPTH_STEPS.find((step) => step >= levels);
    const { tick } = await this.#request(
      "/market/depth",
      {
        symbol: symbol(instrument),
        type: "step0",
        ...(depth ? { depth: String(depth) } : {}),
      },
      z.object({
        tick: z.object({
          version: millis,
          bids: htxLevelsSchema,
          asks: htxLevelsSchema,
        }),
      }),
      false,
    );
    return {
      lastUpdateId: tick.version,
      bids: tick.bids.slice(0, levels),
      asks: tick.asks.slice(0, levels),
    };
  }

  /** The price of the market's latest trade. */
  async getLastPrice(instrument: Instrument) {
    const { tick } = await this.#request(
      "/market/trade",
      { symbol: symbol(instrument) },
      z.object({
        tick: z.object({
          data: z
            .array(
              z.object({
                price: amount.refine((value) => /[1-9]/.test(value)),
              }),
            )
            .min(1),
        }),
      }),
      false,
    );
    return tick.data[0].price;
  }
}

/**
 * An HTX market-symbols entry as a catalogue market. The instrument comes
 * from its base and quote currencies, never from splitting the symbol, and
 * HTX's price and amount precisions become the tick and step sizes. HTX sets
 * no fixed price range: it bounds a limit price around the last trade. The
 * adapter places no orders, so no market can hold protected entries.
 */
export function htxMarketRules(info: HtxMarketSymbol): MarketRules {
  const instrument = instrumentFor(
    htxVenueSymbols.assetCode(info.bc),
    htxVenueSymbols.assetCode(info.qc),
  );
  if (!instrument || htxVenueSymbols.toVenueSymbol(instrument) !== info.symbol)
    throw new Error(`HTX's ${info.symbol} does not name its base and quote.`);
  return marketRulesSchema.parse({
    instrument,
    venueSymbol: info.symbol,
    status:
      info.state === "online" && info.at === "enabled" ? "trading" : "halted",
    protectedEntryAllowed: false,
    minPrice: "0",
    maxPrice: "0",
    tickSize: new ExactDecimal(10).pow(-info.pp).toFixed(),
    minQty: info.minoa,
    maxQty: info.maxoa,
    stepSize: new ExactDecimal(10).pow(-info.ap).toFixed(),
    minNotional: info.minov,
    maxNotional: "0",
  });
}

const symbol = htxVenueSymbols.toVenueSymbol;
function boundedLimit(max: number) {
  return z.number().int().min(1).max(max);
}
/** An order ID the adapter returned, as HTX takes it back in a path. */
function htxOrderId(value: string) {
  if (!/^[1-9]\d{0,19}$/.test(value))
    throw new Error("HTX order IDs are whole numbers.");
  return value;
}
