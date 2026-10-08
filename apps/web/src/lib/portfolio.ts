import Decimal from "decimal.js";
import type { TestnetTicker } from "@crypto-trading/exchanges";

// Enough significant digits that sums and products of Binance's decimal
// strings stay exact. Only prices through an inverse market (1 ÷ rate) are
// rounded, to 64 significant digits.
const Exact = Decimal.clone({ precision: 64 });
const ZERO = new Exact(0);
const ONE = new Exact(1);
const HUNDRED = new Exact(100);
// Balances worth less than this many USDT count as dust.
const DUST_LIMIT = ONE;
// Assets without a USDT market are priced through the first of these that
// has a market with both the asset and USDT.
const BRIDGES = ["BTC", "ETH", "BNB"];

type Balance = { asset: string; free: string; locked: string };

/** USDT per unit now (`last`) and at the start of the 24-hour ticker window (`open`). */
type Rate = { last: Decimal; open: Decimal; source: string };

const USDT_RATE: Rate = { last: ONE, open: ONE, source: "USDT counts as 1" };

export type HoldingValue = {
  /** USDT per unit. */
  price: string;
  /** Quantity × price, in USDT. */
  value: string;
  /** Change in this quantity's value over the 24-hour ticker window, in USDT. */
  change: string;
  /** The price's 24-hour change; null for USDT, which always counts as 1. */
  changePercent: string | null;
  /** The markets the price comes from, such as "1 ÷ BTCJPY × BTCUSDT". */
  source: string;
};

export type Holding = Balance & {
  /** Available plus locked. */
  quantity: string;
  /** Missing when no USDT price was found; never counted as zero. */
  valuation?: HoldingValue;
  /** Zero, or valued below 1 USDT. A balance without a price is not dust. */
  dust: boolean;
};

export type Portfolio = {
  /** Highest value first, then balances without a price by asset. */
  holdings: Holding[];
  /** Value of the priced holdings, in USDT. */
  total: string;
  /** Σ quantity × (last − open) over the priced holdings, in USDT. */
  change: string;
  /** `change` as a percentage of the same holdings' value at the open prices; null when that is zero. */
  changePercent: string | null;
  /** Assets with a nonzero balance and no USDT price, left out of the totals. */
  unpriced: string[];
};

/**
 * Values each balance (available plus locked) in USDT from Binance 24-hour
 * tickers: through `<ASSET>USDT`, the inverse of `USDT<ASSET>`, or a bridge
 * asset such as BTC. Assets with no route stay unpriced and are listed
 * rather than counted as zero.
 */
export function valuePortfolio(
  balances: readonly Balance[],
  tickers: readonly TestnetTicker[],
): Portfolio {
  const markets = new Map<string, Rate>();
  for (const { symbol, lastPrice, openPrice } of tickers) {
    const last = new Exact(lastPrice);
    const open = new Exact(openPrice);
    // A market without both prices can value nothing.
    if (last.gt(0) && open.gt(0))
      markets.set(symbol, { last, open, source: symbol });
  }

  let total = ZERO;
  let opening = ZERO;
  const valued = balances.map((balance) => {
    const quantity = new Exact(balance.free).plus(balance.locked);
    const rate =
      balance.asset === "USDT" ? USDT_RATE : findRate(balance.asset, markets);
    const holding: Holding = {
      ...balance,
      quantity: quantity.toFixed(),
      dust: quantity.isZero(),
    };
    if (!rate) return { holding, value: undefined };
    const value = quantity.times(rate.last);
    const before = quantity.times(rate.open);
    total = total.plus(value);
    opening = opening.plus(before);
    holding.dust = value.lt(DUST_LIMIT);
    holding.valuation = {
      price: rate.last.toFixed(),
      value: value.toFixed(),
      change: value.minus(before).toFixed(),
      changePercent:
        rate === USDT_RATE
          ? null
          : percent(rate.last.minus(rate.open), rate.open),
      source: rate.source,
    };
    return { holding, value };
  });

  valued.sort(
    (a, b) =>
      Number(!a.value) - Number(!b.value) ||
      (a.value && b.value ? b.value.cmp(a.value) : 0) ||
      a.holding.asset.localeCompare(b.holding.asset, "en"),
  );
  const change = total.minus(opening);
  return {
    holdings: valued.map(({ holding }) => holding),
    total: total.toFixed(),
    change: change.toFixed(),
    changePercent: opening.isZero() ? null : percent(change, opening),
    unpriced: valued
      .filter(({ holding }) => !holding.valuation && !holding.dust)
      .map(({ holding }) => holding.asset),
  };
}

function findRate(asset: string, markets: Map<string, Rate>) {
  const direct = pair(asset, "USDT", markets);
  if (direct) return direct;
  for (const bridge of BRIDGES) {
    if (bridge === asset) continue;
    const leg = pair(asset, bridge, markets);
    const bridgeRate = leg && pair(bridge, "USDT", markets);
    if (leg && bridgeRate)
      return {
        last: leg.last.times(bridgeRate.last),
        open: leg.open.times(bridgeRate.open),
        source: `${leg.source} × ${bridgeRate.source}`,
      };
  }
  return undefined;
}

/** `quote` per unit of `base`, from BASEQUOTE or the inverse of QUOTEBASE. */
function pair(
  base: string,
  quote: string,
  markets: Map<string, Rate>,
): Rate | undefined {
  const direct = markets.get(base + quote);
  if (direct) return direct;
  const inverse = markets.get(quote + base);
  return inverse
    ? {
        last: ONE.div(inverse.last),
        open: ONE.div(inverse.open),
        source: `1 ÷ ${inverse.source}`,
      }
    : undefined;
}

function percent(change: Decimal, base: Decimal) {
  return change.div(base).times(HUNDRED).toFixed();
}

export type AllocationSlice = {
  /** An asset, or "Other" when `folded` is above zero. */
  label: string;
  /** In USDT. */
  value: string;
  /** Percentage of the portfolio's total. */
  share: string;
  /** How many assets were folded into this "Other" slice. */
  folded: number;
};

/**
 * The priced holdings' shares of the total, largest first. With more than
 * `max` holdings, the smallest are folded into one "Other" slice.
 */
export function allocationSlices(
  portfolio: Portfolio,
  max = 6,
): AllocationSlice[] {
  const total = new Exact(portfolio.total);
  if (total.isZero()) return [];
  const priced = portfolio.holdings.flatMap(({ asset, valuation }) =>
    valuation && new Exact(valuation.value).gt(0)
      ? [{ asset, value: new Exact(valuation.value) }]
      : [],
  );
  const shown = priced.length > max ? priced.slice(0, max - 1) : priced;
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
