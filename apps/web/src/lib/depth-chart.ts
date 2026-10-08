// Geometry for the market depth chart. No decimal.js here: the chart is a
// client component and only needs numbers.

/** A price level and the quantity available from the best price up to it. */
export type DepthPoint = { price: number; total: number };

/** Cumulative quantity per side, best price first. */
export type DepthCurve = { bids: DepthPoint[]; asks: DepthPoint[] };

export type DepthDomain = {
  mid: number;
  min: number;
  max: number;
  /** The largest cumulative quantity inside [min, max]. */
  maxTotal: number;
};

/**
 * The price range to draw: centred on the mid price and as wide as the side
 * with less reach, so both sides fill their half. With one side empty, the
 * other side's reach is used.
 */
export function depthDomain({ bids, asks }: DepthCurve): DepthDomain | null {
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (!bestBid && !bestAsk) return null;
  const mid =
    bestBid && bestAsk
      ? (bestBid.price + bestAsk.price) / 2
      : (bestBid ?? bestAsk).price;
  const reaches = [
    bids.length ? mid - bids[bids.length - 1].price : undefined,
    asks.length ? asks[asks.length - 1].price - mid : undefined,
  ].filter((reach) => reach !== undefined);
  // A single level at the mid has no reach; show a small range around it.
  const half = Math.min(...reaches) || mid * 0.001 || 1;
  const min = mid - half;
  const max = mid + half;
  // Rounding can put the narrower side's last level a hair outside the range.
  const slack = half * 1e-9;
  const maxTotal = Math.max(
    0,
    ...bids
      .filter(({ price }) => price >= min - slack)
      .map(({ total }) => total),
    ...asks
      .filter(({ price }) => price <= max + slack)
      .map(({ total }) => total),
  );
  return { mid, min, max, maxTotal };
}

/**
 * The cumulative quantity at a price: every bid at or above it below the mid,
 * every ask at or below it above the mid.
 */
export function depthAt(
  { bids, asks }: DepthCurve,
  mid: number,
  price: number,
): { side: "bids" | "asks"; total: number } {
  if (price <= mid) {
    const reached = bids.filter((level) => level.price >= price);
    return { side: "bids", total: reached.at(-1)?.total ?? 0 };
  }
  const reached = asks.filter((level) => level.price <= price);
  return { side: "asks", total: reached.at(-1)?.total ?? 0 };
}

/**
 * An SVG path that steps outward from the best price: flat between levels,
 * rising at each one, then flat to `edge` if the levels stop short of it.
 * With `close`, it returns to the baseline as an area.
 */
export function depthPath(
  points: readonly DepthPoint[],
  x: (price: number) => number,
  y: (total: number) => number,
  edge: number,
  close = false,
): string {
  if (!points.length) return "";
  const start = x(points[0].price);
  const commands = [`M${start} ${y(0)}`];
  for (const [index, point] of points.entries()) {
    if (index > 0) commands.push(`H${x(point.price)}`);
    commands.push(`V${y(point.total)}`);
  }
  const outward = Math.sign(edge - points[0].price);
  if ((edge - points[points.length - 1].price) * outward > 0)
    commands.push(`H${x(edge)}`);
  if (close) commands.push(`V${y(0)}`, `H${start}`, "Z");
  return commands.join("");
}

/** About `count` round tick values from 0 to `max`. */
export function niceTicks(max: number, count: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((value) => value >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step * 1e-9; tick += step)
    ticks.push(Number(tick.toPrecision(12)));
  return ticks;
}
