"use client";

// Drawn with TradingView Lightweight Charts (Apache-2.0). Its NOTICE:
//   TradingView Lightweight Charts™
//   Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/
// The chart keeps the library's attribution logo, which links to
// tradingview.com, and the Markets page shows the notice below the chart.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import type { Candle, FillMarker, OrderLine } from "@/lib/candles";

export type CandlestickCanvasProps = {
  /** The market and interval. When it changes the chart redraws and refits. */
  dataKey: string;
  /** Oldest first; the last candle is still open. */
  candles: Candle[];
  priceDigits: number;
  markers: FillMarker[];
  orders: OrderLine[];
  /** Describes the chart for screen readers, such as "BTC/USDT 1h candles". */
  label: string;
};

type Chart = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  markers: ISeriesMarkersPluginApi<Time>;
};

// The library's default spacing; fewer candles than fit at it are spread out.
const BAR_SPACING = 6;

// The theme toggle sets the `dark` class on <html>.
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.classList.contains("dark");

/** The market colors from the CSS module around the chart, for the current theme. */
function chartColors(element: HTMLElement) {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    up: color("--market-up"),
    down: color("--market-down"),
    text: color("--market-text"),
    grid: color("--market-grid"),
    axis: color("--market-axis"),
    crosshair: color("--market-crosshair"),
    font: style.fontFamily,
  };
}

const bar = (candle: Candle): CandlestickData<UTCTimestamp> => ({
  ...candle,
  time: candle.time as UTCTimestamp,
});

const priceFormat = (digits: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const formatTime = (time: number) =>
  `${new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function CandlestickCanvas({
  dataKey,
  candles,
  priceDigits,
  markers,
  orders,
  label,
}: CandlestickCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  // The series and last candle time already drawn, to update in place.
  const drawnRef = useRef<{ key: string; last: number } | null>(null);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const dark = useSyncExternalStore(subscribeToTheme, isDark, () => true);

  useEffect(() => {
    const chart = createChart(containerRef.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        fontSize: 11,
      },
      rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        maxBarSpacing: 32,
      },
    });
    const series = chart.addSeries(CandlestickSeries);
    chartRef.current = {
      chart,
      series,
      markers: createSeriesMarkers(series, []),
    };
    drawnRef.current = null;
    chart.subscribeCrosshairMove(({ seriesData }) => {
      const data = seriesData.get(series) as CandlestickData<Time> | undefined;
      setHovered(
        data && "open" in data
          ? {
              time: data.time as number,
              open: data.open,
              high: data.high,
              low: data.low,
              close: data.close,
            }
          : null,
      );
    });
    return () => {
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const colors = chartColors(containerRef.current!);
    chartRef.current?.chart.applyOptions({
      layout: { textColor: colors.text, fontFamily: colors.font },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderColor: colors.axis },
      timeScale: { borderColor: colors.axis },
      crosshair: {
        vertLine: { color: colors.crosshair },
        horzLine: { color: colors.crosshair },
      },
    });
    // Hollow up candles keep the direction readable without color.
    chartRef.current?.series.applyOptions({
      upColor: "transparent",
      borderUpColor: colors.up,
      wickUpColor: colors.up,
      downColor: colors.down,
      borderDownColor: colors.down,
      wickDownColor: colors.down,
    });
  }, [dark]);

  useEffect(() => {
    // Grouped like the rest of the page, on the axis and price labels too.
    const format = priceFormat(priceDigits);
    chartRef.current?.series.applyOptions({
      priceFormat: {
        type: "custom",
        minMove: 10 ** -priceDigits,
        formatter: (value: number) => format.format(value),
      },
    });
  }, [priceDigits]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const drawn = drawnRef.current;
    const last = candles.at(-1)?.time;
    if (
      drawn?.key === dataKey &&
      last !== undefined &&
      last >= drawn.last &&
      candles.some(({ time }) => time === drawn.last)
    ) {
      // A refresh: update the open candle and add new ones, keeping the
      // customer's scroll and zoom.
      for (const candle of candles)
        if (candle.time >= drawn.last) current.series.update(bar(candle));
    } else {
      current.series.setData(candles.map(bar));
      const timeScale = current.chart.timeScale();
      // The testnet keeps little history, so spread a few candles out.
      if (candles.length * BAR_SPACING < containerRef.current!.clientWidth)
        timeScale.fitContent();
      else timeScale.resetTimeScale();
    }
    drawnRef.current = last === undefined ? null : { key: dataKey, last };
  }, [candles, dataKey]);

  useEffect(() => {
    const colors = chartColors(containerRef.current!);
    chartRef.current?.markers.setMarkers(
      markers.map(({ time, side, count }) => {
        // Labels on neighbouring candles collide, so only counts are labeled;
        // the arrow's direction and side of the candle show buy or sell.
        const text = count > 1 ? `×${count}` : undefined;
        return side === "BUY"
          ? {
              time: time as UTCTimestamp,
              position: "belowBar",
              shape: "arrowUp",
              color: colors.up,
              text,
            }
          : {
              time: time as UTCTimestamp,
              position: "aboveBar",
              shape: "arrowDown",
              color: colors.down,
              text,
            };
      }),
    );
  }, [markers, dark]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const colors = chartColors(containerRef.current!);
    const lines = orders.map(({ side, label, price, stop, quantity }) =>
      current.series.createPriceLine({
        price: Number(price),
        color: side === "BUY" ? colors.up : colors.down,
        lineWidth: 1,
        // Dotted for a stop's trigger, dashed for a resting limit price.
        lineStyle: stop ? LineStyle.Dotted : LineStyle.Dashed,
        axisLabelVisible: true,
        title: quantity ? `${label} ${quantity}` : label,
      }),
    );
    return () => {
      // Skip if the chart was removed first, on unmount.
      if (chartRef.current === current)
        lines.forEach((line) => current.series.removePriceLine(line));
    };
  }, [orders, dark]);

  const latest = candles.at(-1);
  const shown = hovered ?? latest;
  const price = priceFormat(priceDigits);

  return (
    <div className="space-y-2">
      <p className="grid min-h-12 content-start font-mono text-xs tabular-nums text-muted-foreground sm:min-h-8">
        {shown ? (
          <>
            <span>{formatTime(shown.time)}</span>
            <span className="grid grid-cols-2 gap-x-3 sm:flex">
              {(
                [
                  ["O", shown.open],
                  ["H", shown.high],
                  ["L", shown.low],
                  ["C", shown.close],
                ] as const
              ).map(([name, value]) => (
                <span key={name}>
                  {name}{" "}
                  <span className="text-foreground">{price.format(value)}</span>
                </span>
              ))}
            </span>
          </>
        ) : null}
      </p>
      <div
        aria-label={
          latest
            ? `${label}. Latest close ${price.format(latest.close)}.`
            : label
        }
        className="h-72 w-full sm:h-96 xl:h-[30rem]"
        ref={containerRef}
        role="figure"
      />
    </div>
  );
}
