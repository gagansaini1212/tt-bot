import Decimal from "decimal.js";
import { z } from "zod";

import { ExactDecimal } from "./decimal";
import { assetCodeSchema, instrumentFor, type Instrument } from "./instruments";

// Reporting across exchange accounts (ADR 0009). A customer's reporting
// currency only shows amounts and adds them up across their exchange
// accounts. Each amount is converted with its own account's venue prices,
// through a conversion route, and an amount without a fresh route is reported
// as missing or stale, never as zero. Nothing here changes an allocation, a
// limit or an execution check: those stay in each account's accounting
// currency.

/**
 * The reporting currency every customer starts with. Every exchange account
 * in M4 accounts in USDT, and every venue lists USDT markets, so totals need
 * no outside price feed.
 */
export const DEFAULT_REPORTING_CURRENCY = "USDT";

/**
 * The currencies a customer may choose to report in. Each is offered only
 * where a conversion route to it exists on every one of their exchange
 * accounts' venues: GBP waits for a venue market or an FX feed.
 */
export const REPORTING_CURRENCIES = [
  "USDT",
  "USDC",
  "USD",
  "EUR",
  "GBP",
] as const;
export const reportingCurrencyChoiceSchema = z.enum(REPORTING_CURRENCIES);
export type ReportingCurrencyChoice = z.infer<
  typeof reportingCurrencyChoiceSchema
>;
/** A saved reporting currency: any asset code, so a saved one always shows. */
export const reportingCurrencySchema = assetCodeSchema;

/** The currencies a two-market route passes through, in the order tried. */
export const CONVERSION_BRIDGES = ["USDT", "USDC"] as const;

/**
 * The local build's valuation freshness threshold: a conversion whose price
 * is older is stale. Live thresholds are a deployment decision.
 */
export const VALUATION_FRESHNESS_MS = 60_000;

/** One market's prices on a venue, as the worker values holdings with them. */
export type MarketPrice = {
  /** Quote per unit of base: the mark, the market's last price. */
  price: string;
  /** Quote per unit of base 24 hours earlier, if the venue reports it. */
  openPrice?: string | null;
  /** When the venue priced the market, in milliseconds since the epoch. */
  observedAt: number;
};

/**
 * One venue's prices, by instrument. Undefined where the venue lists no such
 * market. A source never mixes venues: an account's amounts convert only
 * with its own venue's prices.
 */
export type PriceSource = (instrument: Instrument) => MarketPrice | undefined;

/** One market of a conversion route, with the price it used. */
export type ConversionLeg = {
  instrument: Instrument;
  /**
   * `base`: the amount is the market's base asset, so it is multiplied by
   * the price. `quote`: it is the quote asset, so it is divided by it.
   */
  side: "base" | "quote";
  price: string;
  openPrice: string | null;
  observedAt: number;
};

/** How an amount in `from` becomes `to`: no market, one, or two. */
export type ConversionRoute = {
  from: string;
  to: string;
  legs: ConversionLeg[];
};

export type Conversion =
  | {
      status: "converted";
      /** The amount in the target currency, exact. Round only to show it. */
      value: string;
      /** The same amount at the 24-hour open prices, or null without them. */
      valueAtOpen: string | null;
      route: ConversionRoute;
    }
  | {
      /** A price on the route is older than the freshness threshold. */
      status: "stale";
      route: ConversionRoute;
      /** When the route's oldest price was observed. */
      since: number;
    }
  | {
      /**
       * `no_route`: the venue lists no route. `no_price`: it lists the
       * route's markets, but one of them has no usable price.
       */
      status: "missing";
      reason: "no_route" | "no_price";
      from: string;
      to: string;
    };

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Whether `value` is a decimal string above zero. */
function positive(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    DECIMAL.test(value) &&
    new Decimal(value).greaterThan(0)
  );
}

/** Whether a leg's price can value an amount: positive, and timed. */
function priced(leg: ConversionLeg) {
  return positive(leg.price) && Number.isFinite(leg.observedAt);
}

/**
 * The one market the venue lists between `from` and `to`, in either
 * direction, whether or not it has a usable price.
 */
function directLeg(
  from: string,
  to: string,
  prices: PriceSource,
): ConversionLeg | undefined {
  for (const [instrument, side] of [
    [instrumentFor(from, to), "base"],
    [instrumentFor(to, from), "quote"],
  ] as const) {
    if (!instrument) continue;
    const market = prices(instrument);
    if (!market) continue;
    return {
      instrument,
      side,
      price: market.price,
      openPrice: positive(market.openPrice) ? market.openPrice : null,
      observedAt: market.observedAt,
    };
  }
  return undefined;
}

/**
 * The route that converts `from` into `to` on one venue, the first that
 * exists of: no conversion when they are the same; one market between them,
 * in either direction; two markets through USDT, then through USDC. Longer
 * routes are never used, and no currency is assumed equal to another. A
 * market exists if the venue lists it: one without a usable price still
 * decides the route, so the conversion is missing rather than taken from
 * other markets.
 */
export function conversionRoute(
  from: string,
  to: string,
  prices: PriceSource,
): ConversionRoute | undefined {
  if (from === to) return { from, to, legs: [] };
  const direct = directLeg(from, to, prices);
  if (direct) return { from, to, legs: [direct] };
  for (const bridge of CONVERSION_BRIDGES) {
    if (bridge === from || bridge === to) continue;
    const first = directLeg(from, bridge, prices);
    const second = first && directLeg(bridge, to, prices);
    if (first && second) return { from, to, legs: [first, second] };
  }
  return undefined;
}

/** Whether a route from `from` to `to` exists among the markets a venue `lists`. */
export function hasConversionRoute(
  from: string,
  to: string,
  lists: (instrument: Instrument) => boolean,
) {
  return (
    conversionRoute(from, to, (instrument) =>
      lists(instrument) ? { price: "1", observedAt: 0 } : undefined,
    ) !== undefined
  );
}

function applyRoute(
  amount: Decimal.Value,
  legs: ConversionLeg[],
  price: (leg: ConversionLeg) => string | null,
) {
  let value = new ExactDecimal(amount);
  for (const leg of legs) {
    const legPrice = price(leg);
    if (legPrice === null) return null;
    value =
      leg.side === "base" ? value.times(legPrice) : value.dividedBy(legPrice);
  }
  return value;
}

/**
 * Converts `amount`, in `from`, into `to` with one venue's `prices`, as of
 * `now`. A conversion is missing when the venue has no route, or a market on
 * it has no usable price, and stale when any price on the route is older
 * than `maxAgeMs`: either way it has no value, so it is never counted as
 * zero or filled from another venue.
 */
export function convertAmount(
  amount: Decimal.Value,
  from: string,
  to: string,
  prices: PriceSource,
  now: Date,
  maxAgeMs = VALUATION_FRESHNESS_MS,
): Conversion {
  const route = conversionRoute(from, to, prices);
  if (!route) return { status: "missing", reason: "no_route", from, to };
  if (!route.legs.every(priced))
    return { status: "missing", reason: "no_price", from, to };
  if (route.legs.length) {
    const oldest = Math.min(...route.legs.map((leg) => leg.observedAt));
    // A price from the future is no older than now.
    if (now.getTime() - oldest > maxAgeMs)
      return { status: "stale", route, since: oldest };
  }
  const value = applyRoute(amount, route.legs, (leg) => leg.price)!;
  const atOpen = applyRoute(amount, route.legs, (leg) => leg.openPrice);
  return {
    status: "converted",
    value: value.toFixed(),
    valueAtOpen: atOpen?.toFixed() ?? null,
    route,
  };
}

/**
 * What one unit costs in the route's target currency, now and at the
 * 24-hour open (null without open prices), from the prices it recorded.
 */
export function unitPrice(route: ConversionRoute) {
  return {
    price: applyRoute(1, route.legs, (leg) => leg.price)!.toFixed(),
    openPrice:
      applyRoute(1, route.legs, (leg) => leg.openPrice)?.toFixed() ?? null,
  };
}

/** One asset an exchange account holds, available and locked together. */
export type AssetBalance = { asset: string; quantity: string };

export type ValuedHolding = AssetBalance & { conversion: Conversion };

/** Why an amount has no value: a missing or a stale conversion. */
export type ConversionProblem =
  | { status: "missing"; reason: "no_route" | "no_price" }
  | {
      status: "stale";
      /** When the route's oldest price was observed. */
      since: number;
    };

/** A nonzero holding left out of a total, and why. */
export type UnconvertedHolding = AssetBalance & ConversionProblem;

/** One exchange account's holdings in a reporting currency. */
export type AccountValuation = {
  currency: string;
  /** In the order given. */
  holdings: ValuedHolding[];
  /** The converted holdings' value. */
  total: string;
  /**
   * Σ value − value at the 24-hour open, over the converted holdings with
   * open prices: the change if today's balances had been held all day.
   */
  change: string;
  /** Those holdings' value at the open, the base of `change`. */
  changeBase: string;
  /** Nonzero holdings converted, so counted in `total`. */
  converted: number;
  /** Of those, the ones without a 24-hour open price, left out of `change`. */
  withoutOpen: number;
  /** Nonzero holdings left out of `total`. */
  unconverted: UnconvertedHolding[];
};

/**
 * Values one exchange account's `balances` in `currency`, each with
 * `prices` from the account's own venue.
 */
export function valueAccount(
  balances: readonly AssetBalance[],
  currency: string,
  prices: PriceSource,
  now: Date,
  maxAgeMs = VALUATION_FRESHNESS_MS,
): AccountValuation {
  let total = new ExactDecimal(0);
  let change = new ExactDecimal(0);
  let changeBase = new ExactDecimal(0);
  let converted = 0;
  let withoutOpen = 0;
  const unconverted: UnconvertedHolding[] = [];
  const holdings = balances.map((balance): ValuedHolding => {
    const conversion = convertAmount(
      balance.quantity,
      balance.asset,
      currency,
      prices,
      now,
      maxAgeMs,
    );
    const nonzero = !new Decimal(balance.quantity).isZero();
    if (conversion.status === "converted") {
      total = total.plus(conversion.value);
      if (conversion.valueAtOpen !== null) {
        change = change.plus(conversion.value).minus(conversion.valueAtOpen);
        changeBase = changeBase.plus(conversion.valueAtOpen);
      } else if (nonzero) withoutOpen += 1;
      if (nonzero) converted += 1;
    } else if (nonzero)
      unconverted.push(
        conversion.status === "stale"
          ? { ...balance, status: "stale", since: conversion.since }
          : { ...balance, status: "missing", reason: conversion.reason },
      );
    return { ...balance, conversion };
  });
  return {
    currency,
    holdings,
    total: total.toFixed(),
    change: change.toFixed(),
    changeBase: changeBase.toFixed(),
    converted,
    withoutOpen,
    unconverted,
  };
}

/** An exchange account, and how the dashboard names it: its venue and label. */
export type AccountName = { exchangeAccountId: string; label: string };

/** One exchange account's part in a total across accounts. */
export type AccountFigures = AccountName &
  (
    | { status: "valued"; valuation: AccountValuation }
    | {
        /** Its venue cannot serve it now, so it is not counted. */
        status: "unavailable";
        reason: string;
        /** Its last known value, shown apart from the total, never in it. */
        lastKnown?: { total: string; at: number };
      }
  );

/** A total across exchange accounts in the reporting currency. */
export type CombinedValuation = {
  currency: string;
  total: string;
  change: string;
  /** `change` as a percentage of its base, or null when that is zero. */
  changePercent: string | null;
  /** Accounts counted in the total. */
  counted: number;
  /** Nonzero holdings counted, across those accounts. */
  converted: number;
  /** Of those, the ones without a 24-hour open price, left out of `change`. */
  withoutOpen: number;
  /** Every account counted and every holding converted. */
  complete: boolean;
  /** Accounts not counted, with why. */
  leftOutAccounts: (AccountName & {
    reason: string;
    lastKnown?: { total: string; at: number };
  })[];
  /** Holdings of counted accounts left out, with their account. */
  unconverted: (AccountName & UnconvertedHolding)[];
};

/**
 * Adds every exchange account's value in `currency`. An account that is
 * unavailable is left out and named, and so is every holding without a
 * fresh conversion: the total is then incomplete, never filled in.
 */
export function combineAccounts(
  currency: string,
  accounts: readonly AccountFigures[],
): CombinedValuation {
  let total = new ExactDecimal(0);
  let change = new ExactDecimal(0);
  let changeBase = new ExactDecimal(0);
  let counted = 0;
  let converted = 0;
  let withoutOpen = 0;
  const leftOutAccounts: CombinedValuation["leftOutAccounts"] = [];
  const unconverted: CombinedValuation["unconverted"] = [];
  for (const account of accounts) {
    const name = {
      exchangeAccountId: account.exchangeAccountId,
      label: account.label,
    };
    if (account.status === "unavailable") {
      leftOutAccounts.push({
        ...name,
        reason: account.reason,
        ...(account.lastKnown ? { lastKnown: account.lastKnown } : {}),
      });
      continue;
    }
    const { valuation } = account;
    if (valuation.currency !== currency)
      throw new Error(
        `${account.label} is valued in ${valuation.currency}, not ${currency}.`,
      );
    total = total.plus(valuation.total);
    change = change.plus(valuation.change);
    changeBase = changeBase.plus(valuation.changeBase);
    counted += 1;
    converted += valuation.converted;
    withoutOpen += valuation.withoutOpen;
    for (const holding of valuation.unconverted)
      unconverted.push({ ...name, ...holding });
  }
  return {
    currency,
    total: total.toFixed(),
    change: change.toFixed(),
    changePercent: changeBase.isZero()
      ? null
      : change.dividedBy(changeBase).times(100).toFixed(),
    counted,
    converted,
    withoutOpen,
    complete: leftOutAccounts.length === 0 && unconverted.length === 0,
    leftOutAccounts,
    unconverted,
  };
}

/** One exchange account's strategies since midnight UTC. */
export type AccountDay = AccountName & {
  accountingCurrency: string;
  /** Its venue's prices, to convert from the accounting currency. */
  prices: PriceSource;
} & (
    | {
        /** Their result together, and their allocations, in the accounting currency. */
        today: { pnl: string; allocation: string };
      }
    | { unmeasured: string }
  );

/** The customer's strategies on every account together, since midnight UTC. */
export type CombinedDrawdown = {
  currency: string;
  /** Profit, or loss as a negative amount. */
  pnl: string;
  allocation: string;
  /** The loss as a percentage of the allocations, to 4 places, rounded down. */
  drawdownPercent: string;
  /** Accounts counted. */
  counted: number;
  complete: boolean;
  leftOut: (AccountName & { reason: string })[];
};

/**
 * The customer-wide daily drawdown in `currency`, for display only. Each
 * account's own daily drawdown limit, in its accounting currency, is what
 * pauses its strategies; this total pauses nothing. An account whose
 * strategies cannot be measured, or whose conversion is missing or stale,
 * is left out and named.
 */
export function drawdownAcrossAccounts(
  currency: string,
  accounts: readonly AccountDay[],
  now: Date,
  maxAgeMs = VALUATION_FRESHNESS_MS,
): CombinedDrawdown {
  let pnl = new ExactDecimal(0);
  let allocation = new ExactDecimal(0);
  let counted = 0;
  const leftOut: CombinedDrawdown["leftOut"] = [];
  for (const account of accounts) {
    const name = {
      exchangeAccountId: account.exchangeAccountId,
      label: account.label,
    };
    if ("unmeasured" in account) {
      leftOut.push({ ...name, reason: account.unmeasured });
      continue;
    }
    const convert = (amount: string) =>
      convertAmount(
        amount,
        account.accountingCurrency,
        currency,
        account.prices,
        now,
        maxAgeMs,
      );
    const [result, allocated] = [
      convert(account.today.pnl),
      convert(account.today.allocation),
    ];
    // Both amounts take the same route, so they fail the same way.
    if (result.status !== "converted" || allocated.status !== "converted") {
      const pair = `${account.accountingCurrency} to ${currency}`;
      leftOut.push({
        ...name,
        reason:
          result.status === "stale"
            ? `Its ${pair} price is stale.`
            : result.status === "missing" && result.reason === "no_price"
              ? `Its venue has no price to convert ${pair}.`
              : `Its venue has no market to convert ${pair}.`,
      });
      continue;
    }
    pnl = pnl.plus(result.value);
    allocation = allocation.plus(allocated.value);
    counted += 1;
  }
  const drawdown = allocation.greaterThan(0)
    ? ExactDecimal.max(pnl.negated(), 0).dividedBy(allocation).times(100)
    : new ExactDecimal(0);
  return {
    currency,
    pnl: pnl.toFixed(),
    allocation: allocation.toFixed(),
    drawdownPercent: drawdown.toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(),
    counted,
    complete: leftOut.length === 0,
    leftOut,
  };
}

/** Whether a customer may choose a reporting currency, and why not. */
export type ReportingCurrencyOption = {
  currency: ReportingCurrencyChoice;
  available: boolean;
  /** The accounts with no route to it on their venue. */
  unavailableFor: string[];
};

/**
 * The reporting currencies a customer may choose: each one that every
 * exchange account can convert its accounting currency into on its own
 * venue. `lists` says which markets an account's venue lists, and is
 * undefined where the worker cannot read its venue's markets, which allows
 * only that account's accounting currency. With no account, only the
 * default is offered.
 */
export function reportingCurrencyOptions(
  accounts: readonly {
    label: string;
    accountingCurrency: string;
    lists?: (instrument: Instrument) => boolean;
  }[],
): ReportingCurrencyOption[] {
  return REPORTING_CURRENCIES.map((currency) => {
    const unavailableFor = accounts
      .filter(
        (account) =>
          account.accountingCurrency !== currency &&
          !(
            account.lists &&
            hasConversionRoute(
              account.accountingCurrency,
              currency,
              account.lists,
            )
          ),
      )
      .map((account) => account.label);
    return {
      currency,
      available: accounts.length
        ? unavailableFor.length === 0
        : currency === DEFAULT_REPORTING_CURRENCY,
      unavailableFor,
    };
  });
}
