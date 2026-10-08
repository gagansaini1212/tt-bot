// Chart geometry for the backtest's equity curve. Numbers here only place
// marks; every value shown comes from the result's decimal strings.

export type EquityPlotPoint = {
  time: number;
  strategy: number;
  baseline: number;
};

/** The result's equity as plottable numbers. */
export function plotPoints(
  equity: readonly { time: number; strategy: string; baseline: string }[],
): EquityPlotPoint[] {
  return equity.map((point) => ({
    time: point.time,
    strategy: Number(point.strategy),
    baseline: Number(point.baseline),
  }));
}

/** The smallest of 1, 2, 2.5 and 5 times a power of ten at least `rough`. */
function niceStep(rough: number) {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  return (
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((value) => value >= rough) ?? 10 * magnitude
  );
}

/**
 * A value axis around every point and the allocation, widened to round
 * ticks, with about `count` intervals.
 */
export function valueAxis(
  points: readonly EquityPlotPoint[],
  allocation: number,
  count = 4,
) {
  let min = allocation;
  let max = allocation;
  for (const point of points) {
    min = Math.min(min, point.strategy, point.baseline);
    max = Math.max(max, point.strategy, point.baseline);
  }
  // A flat curve still gets a band around it.
  const span = max - min || Math.max(Math.abs(max) * 0.01, 1);
  const step = niceStep(span / count);
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step * 1e-9; tick += step)
    ticks.push(Number(tick.toPrecision(12)));
  if (ticks.length < 2) ticks.push(Number((low + step).toPrecision(12)));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnights to label on the time axis, at most `count` of them. */
export function dayTicks(start: number, end: number, count: number): number[] {
  const first = Math.ceil(start / DAY_MS) * DAY_MS;
  const days = Math.floor((end - first) / DAY_MS) + 1;
  if (days <= 0) return [];
  const every = Math.max(1, Math.ceil(days / Math.max(1, count)));
  const ticks: number[] = [];
  for (let day = first; day <= end; day += every * DAY_MS) ticks.push(day);
  return ticks;
}

/** An SVG path through the points. */
export function linePath(
  points: readonly EquityPlotPoint[],
  series: "strategy" | "baseline",
  x: (time: number) => number,
  y: (value: number) => number,
) {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(point.time).toFixed(2)} ${y(point[series]).toFixed(2)}`,
    )
    .join(" ");
}

/** The index of the point nearest `time`. Points are in time order. */
export function nearestPoint(
  points: readonly { time: number }[],
  time: number,
) {
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle].time <= time) low = middle;
    else high = middle;
  }
  return Math.abs(points[high].time - time) < Math.abs(points[low].time - time)
    ? high
    : low;
}
