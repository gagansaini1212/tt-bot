import Decimal from "decimal.js";
import type { Depth } from "@crypto-trading/exchanges";

import { fractionDigits, formatDecimal } from "./decimals";
import type { DepthCurve } from "./depth-chart";

/** A displayed level. `total` is the cumulative quantity from the best price. */
export type BookRow = { price: string; quantity: string; total: string };

export type OrderBookView = {
  /** Best price first, formatted for display. */
  bids: BookRow[];
  asks: BookRow[];
  /** The same levels as numbers, for the depth chart. */
  curve: DepthCurve;
  /** Null unless both sides have a level. */
  spread: { value: string; percent: string; mid: string } | null;
  priceDigits: number;
  quantityDigits: number;
};

/**
 * Formats the order book with exact cumulative totals. Prices and quantities
 * keep the most decimal places their column uses, so the columns line up.
 */
export function orderBook({ bids, asks }: Depth): OrderBookView {
  const all = [...bids, ...asks];
  const priceDigits = fractionDigits(all.map(({ price }) => price));
  const quantityDigits = fractionDigits(all.map(({ quantity }) => quantity));

  function cumulate(levels: Depth["bids"]) {
    let total = new Decimal(0);
    return levels.map(({ price, quantity }) => {
      total = total.plus(quantity);
      return {
        row: {
          price: formatDecimal(price, priceDigits),
          quantity: formatDecimal(quantity, quantityDigits),
          total: formatDecimal(total, quantityDigits),
        },
        point: { price: Number(price), total: total.toNumber() },
      };
    });
  }
  const bidLevels = cumulate(bids);
  const askLevels = cumulate(asks);

  let spread: OrderBookView["spread"] = null;
  if (bids.length && asks.length) {
    const bestBid = new Decimal(bids[0].price);
    const bestAsk = new Decimal(asks[0].price);
    const value = bestAsk.minus(bestBid);
    const mid = bestBid.plus(bestAsk).div(2);
    spread = {
      value: formatDecimal(value, priceDigits),
      percent: mid.isZero()
        ? "0"
        : value.div(mid).times(100).toSignificantDigits(2).toFixed(),
      mid: formatDecimal(mid, Math.max(priceDigits, mid.decimalPlaces())),
    };
  }

  return {
    bids: bidLevels.map(({ row }) => row),
    asks: askLevels.map(({ row }) => row),
    curve: {
      bids: bidLevels.map(({ point }) => point),
      asks: askLevels.map(({ point }) => point),
    },
    spread,
    priceDigits,
    quantityDigits,
  };
}
