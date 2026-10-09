import Decimal from "decimal.js";
import {
  convertAmount,
  instrumentLabel,
  valueAccount,
  type AccountValuation,
  type ConversionRoute,
  type PriceSource,
} from "@crypto-trading/domain";
import type { Ticker } from "@crypto-trading/exchanges/contract";
import { venueFor, venueIdSchema } from "@crypto-trading/exchanges/venues";

// Enough significant digits that sums and products of the domain's exact
// decimals stay exact for display.
const Exact = Decimal.clone({ precision: 100 });
const ZERO = new Exact(0);
const HUNDRED = new Exact(100);
// Balances worth less than one unit of the reporting currency count as dust.
const DUST_LIMIT = new Exact(1);
/** Slices in the asset mix: the largest holdings, then "Other". The chart has a colour for each. */
export const MIX_SLICES = 6;

type Balance = { asset: string; free: string; locked: string };

/**
 * One venue's prices from its 24-hour tickers: the last price is the mark,
 * the open is the price 24 hours earlier, and each price was observed at
 * the market's last trade. A venue the dashboard has no tickers for prices
 * nothing.
 */
export function tickerPrices(
  venue: string,
  tickers: readonly Ticker[],
): PriceSource {
  const known = venueIdSchema.safeParse(venue);
  if (!known.success) return () => undefined;
  const { symbols } = venueFor(known.data);
  const bySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  return (instrument) => {
    const ticker = bySymbol.get(symbols.toVenueSymbol(instrument));
    return ticker
      ? {
          price: ticker.lastPrice,
          openPrice: ticker.openPrice,
          observedAt: ticker.closeTime,
        }
      : undefined;
  };
}

/** The markets a route goes through, such as "1 ÷ USDT/TRY × USDC/USDT". */
export function routeSource(route: ConversionRoute) {
  if (!route.legs.length) return `Already in ${route.to}`;
  return route.legs
    .map((leg) =>
      leg.side === "base"
        ? instrumentLabel(leg.instrument)
        : `1 ÷ ${instrumentLabel(leg.instrument)}`,
    )
    .join(" × ");
}

export type HoldingValue = {
  /** Reporting currency per unit. */
  price: string;
  /** Quantity × price, in the reporting currency. */
  value: string;
  /** Change in this quantity's value over the 24-hour window; null without open prices. */
  change: string | null;
  /** The price's 24-hour change; null when it needs no conversion, or has no open price. */
  changePercent: string | null;
  /** The markets the price comes from, such as "BTC/USDT". */
  source: string;
};

export type Holding = Balance & {
  /** Available plus locked. */
  quantity: string;
  /** Missing when the holding could not be converted; never counted as zero. */
  valuation?: HoldingValue;
  /** Why a nonzero holding has no value: no route on its venue, or a stale price. */
  unconverted?: { status: "missing" } | { status: "stale"; since: number };
  /** Zero, or valued below 1 in the reporting currency. A balance without a value is not dust. */
  dust: boolean;
};

export type Portfolio = {
  /** The reporting currency every value is in. */
  currency: string;
  /** Highest value first, then balances without a value by asset. */
  holdings: Holding[];
  /** Value of the converted holdings. */
  total: string;
  /** Σ quantity × (last − open) over the converted holdings with open prices. */
  change: string;
  /** `change` as a percentage of the same holdings' value at the open prices; null when that is zero. */
  changePercent: string | null;
  /** Assets with a nonzero balance and no value, left out of the totals. */
  unpriced: string[];
  /** The account's figures, for totals across accounts. */
  valuation: AccountValuation;
};

/**
 * Values each balance (available plus locked) in `currency` with `prices`
 * from the account's own venue, through the conversion routes of ADR 0009.
 * Balances without a route, or with a stale price, keep no value and are
 * listed rather than counted as zero.
 */
export function valuePortfolio(
  balances: readonly Balance[],
  currency: string,
  prices: PriceSource,
  now: Date,
): Portfolio {
  const quantities = balances.map((balance) => ({
    asset: balance.asset,
    quantity: new Exact(balance.free).plus(balance.locked).toFixed(),
  }));
  const valuation = valueAccount(quantities, currency, prices, now);
  const valued = balances.map((balance, index) => {
    const { quantity, conversion } = valuation.holdings[index];
    const holding: Holding = {
      ...balance,
      quantity,
      dust: new Exact(quantity).isZero(),
    };
    if (conversion.status !== "converted") {
      if (!holding.dust)
        holding.unconverted =
          conversion.status === "stale"
            ? { status: "stale", since: conversion.since }
            : { status: "missing" };
      return { holding, value: undefined };
    }
    const value = new Exact(conversion.value);
    const unit = convertAmount("1", balance.asset, currency, prices, now);
    const price = unit.status === "converted" ? unit.value : "0";
    const priceAtOpen = unit.status === "converted" ? unit.valueAtOpen : null;
    // Compared at the cent shown, so a value displayed as 1.00 is not dust.
    holding.dust = value.toDecimalPlaces(2, Exact.ROUND_HALF_UP).lt(DUST_LIMIT);
    holding.valuation = {
      price,
      value: value.toFixed(),
      change:
        conversion.valueAtOpen === null
          ? null
          : value.minus(conversion.valueAtOpen).toFixed(),
      changePercent:
        conversion.route.legs.length &&
        priceAtOpen &&
        !new Exact(priceAtOpen).isZero()
          ? percent(new Exact(price).minus(priceAtOpen), new Exact(priceAtOpen))
          : null,
      source: routeSource(conversion.route),
    };
    return { holding, value };
  });

  valued.sort(
    (a, b) =>
      Number(!a.value) - Number(!b.value) ||
      (a.value && b.value ? b.value.cmp(a.value) : 0) ||
      a.holding.asset.localeCompare(b.holding.asset, "en"),
  );
  const changeBase = new Exact(valuation.changeBase);
  return {
    currency,
    holdings: valued.map(({ holding }) => holding),
    total: valuation.total,
    change: valuation.change,
    changePercent: changeBase.isZero()
      ? null
      : percent(new Exact(valuation.change), changeBase),
    unpriced: valuation.unconverted.map(({ asset }) => asset),
    valuation,
  };
}

/** Balances listed without values, for when prices are unavailable. */
export function unvaluedHoldings(balances: readonly Balance[]): Holding[] {
  return balances
    .map((balance) => {
      const quantity = new Exact(balance.free).plus(balance.locked);
      return {
        ...balance,
        quantity: quantity.toFixed(),
        dust: quantity.isZero(),
      };
    })
    .sort((a, b) => a.asset.localeCompare(b.asset, "en"));
}

function percent(change: Decimal, base: Decimal) {
  return change.div(base).times(HUNDRED).toFixed();
}

export type MixSlice = {
  /** An asset, or "Other" when `folded` is above zero. */
  label: string;
  /** In the reporting currency. */
  value: string;
  /** Percentage of the portfolio's total. */
  share: string;
  /** How many assets were folded into this "Other" slice. */
  folded: number;
};

/**
 * Each priced holding's share of net worth, largest first. With more than
 * MIX_SLICES holdings, the smallest are folded into one "Other" slice.
 */
export function assetMix(portfolio: Portfolio): MixSlice[] {
  const total = new Exact(portfolio.total);
  if (total.isZero()) return [];
  const priced = portfolio.holdings.flatMap(({ asset, valuation }) =>
    valuation && new Exact(valuation.value).gt(0)
      ? [{ asset, value: new Exact(valuation.value) }]
      : [],
  );
  const shown =
    priced.length > MIX_SLICES ? priced.slice(0, MIX_SLICES - 1) : priced;
  const slice = (label: string, value: Decimal, folded: number) => ({
    label,
    value: value.toFixed(),
    share: percent(value, total),
    folded,
  });
  const slices = shown.map(({ asset, value }) => slice(asset, value, 0));
  const rest = priced.slice(shown.length);
  if (rest.length > 0)
    slices.push(
      slice(
        "Other",
        rest.reduce((sum, { value }) => sum.plus(value), ZERO),
        rest.length,
      ),
    );
  return slices;
}

/** A fill's total, price × quantity, in the quote asset. */
export function fillTotal(fill: { price: string; qty: string }) {
  return new Exact(fill.price).times(fill.qty).toFixed();
}
