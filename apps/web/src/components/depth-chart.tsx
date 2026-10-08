"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";

import {
  depthAt,
  depthDomain,
  depthPath,
  niceTicks,
  type DepthCurve,
  type DepthDomain,
} from "@/lib/depth-chart";

const HEIGHT = 240;
const MARGIN = { top: 12, right: 56, bottom: 24, left: 4 };

type DepthChartProps = {
  curve: DepthCurve;
  priceDigits: number;
  quantityDigits: number;
  /** The base asset the quantities are in, such as "BTC". */
  base: string;
  /** The market, such as "BTC/USDT". */
  label: string;
  /** The exact mid price, formatted, when both sides have a level. */
  mid?: string;
};

/**
 * Cumulative bids (left) and asks (right) around the mid price, drawn as SVG
 * with the market colors, so it follows the theme through CSS alone. The
 * order book beside it lists the same levels as a table.
 */
export function DepthChart(props: DepthChartProps) {
  // Measured even while the book is empty, so a book that fills in later
  // still gets a width.
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(containerRef.current!);
    return () => observer.disconnect();
  }, []);

  const domain = depthDomain(props.curve);
  return (
    <div ref={containerRef}>
      {domain ? (
        <DepthPlot {...props} domain={domain} width={width} />
      ) : (
        <p className="text-sm text-muted-foreground">
          The order book is empty.
        </p>
      )}
    </div>
  );
}

function DepthPlot({
  curve,
  priceDigits,
  quantityDigits,
  base,
  label,
  mid: exactMid,
  domain,
  width,
}: DepthChartProps & { domain: DepthDomain; width: number }) {
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const clipId = `depth-${useId().replace(/[^\w-]/g, "")}`;

  const { mid, min, max, maxTotal } = domain;
  const price = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: priceDigits,
    maximumFractionDigits: priceDigits,
  });
  const quantity = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: quantityDigits,
  });
  const tickPrice = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: max - min >= 100 ? 0 : priceDigits,
  });

  const left = MARGIN.left;
  const right = Math.max(left + 1, width - MARGIN.right);
  const top = MARGIN.top;
  const bottom = HEIGHT - MARGIN.bottom;
  // Headroom above the tallest step.
  const yMax = (maxTotal || 1) * 1.1;
  const x = (value: number) =>
    left + ((value - min) / (max - min)) * (right - left);
  const y = (value: number) => bottom - (value / yMax) * (bottom - top);
  const yTicks = niceTicks(yMax, 4).filter((tick) => tick <= yMax);
  const xTicks =
    width < 480
      ? [min, mid, max]
      : [min, (min + mid) / 2, mid, (mid + max) / 2, max];

  const midText = exactMid ?? price.format(mid);
  const range = `±${(((max - mid) / mid) * 100).toFixed(2)}%`;
  const bids = depthAt(curve, mid, min).total;
  const asks = depthAt(curve, mid, max).total;
  const hover =
    hoverPrice === null
      ? null
      : { price: hoverPrice, ...depthAt(curve, mid, hoverPrice) };

  function onPointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / bounds.width;
    setHoverPrice(min + Math.min(1, Math.max(0, ratio)) * (max - min));
  }

  return (
    <div className="space-y-2">
      <p className="min-h-5 font-mono text-xs tabular-nums text-muted-foreground">
        {hover ? (
          <>
            <span className="text-foreground">
              {quantity.format(hover.total)} {base}
            </span>{" "}
            {hover.side === "bids" ? "bid at or above" : "asked at or below"}{" "}
            <span className="text-foreground">{price.format(hover.price)}</span>
          </>
        ) : (
          <>
            Mid <span className="text-foreground">{midText}</span> · {range}{" "}
            shown
          </>
        )}
      </p>
      <div className="h-60 w-full">
        {width > 0 ? (
          <svg
            aria-label={`Market depth for ${label}: ${quantity.format(bids)} ${base} of bids and ${quantity.format(asks)} ${base} of asks within ${range} of the mid price, ${midText}.`}
            className="block text-[11px]"
            height={HEIGHT}
            role="img"
            width={width}
          >
            <defs>
              <clipPath id={clipId}>
                <rect
                  height={bottom - top + 2}
                  width={right - left}
                  x={left}
                  y={top - 2}
                />
              </clipPath>
            </defs>
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  className="stroke-(--market-grid)"
                  x1={left}
                  x2={right}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  className="fill-muted-foreground tabular-nums"
                  dy="0.32em"
                  x={right + 6}
                  y={y(tick)}
                >
                  {quantity.format(tick)}
                </text>
              </g>
            ))}
            {xTicks.map((tick, index) => (
              <text
                className="fill-muted-foreground tabular-nums"
                key={index}
                textAnchor={
                  index === 0
                    ? "start"
                    : index === xTicks.length - 1
                      ? "end"
                      : "middle"
                }
                x={x(tick)}
                y={HEIGHT - 6}
              >
                {tickPrice.format(tick)}
              </text>
            ))}
            <g clipPath={`url(#${clipId})`}>
              <path
                className="fill-(--market-up)"
                d={depthPath(curve.bids, x, y, min, true)}
                fillOpacity={0.1}
              />
              <path
                className="fill-(--market-down)"
                d={depthPath(curve.asks, x, y, max, true)}
                fillOpacity={0.1}
              />
              <path
                className="stroke-(--market-up)"
                d={depthPath(curve.bids, x, y, min)}
                fill="none"
                strokeLinejoin="round"
                strokeWidth={2}
              />
              <path
                className="stroke-(--market-down)"
                d={depthPath(curve.asks, x, y, max)}
                fill="none"
                strokeLinejoin="round"
                strokeWidth={2}
              />
            </g>
            <line
              className="stroke-(--market-axis)"
              x1={left}
              x2={right}
              y1={bottom}
              y2={bottom}
            />
            <line
              className="stroke-(--market-axis)"
              x1={x(mid)}
              x2={x(mid)}
              y1={top}
              y2={bottom}
            />
            {hover ? (
              <g pointerEvents="none">
                <line
                  className="stroke-(--market-crosshair)"
                  x1={x(hover.price)}
                  x2={x(hover.price)}
                  y1={top}
                  y2={bottom}
                />
                <circle
                  className={
                    hover.side === "bids"
                      ? "fill-(--market-up) stroke-card"
                      : "fill-(--market-down) stroke-card"
                  }
                  cx={x(hover.price)}
                  cy={y(hover.total)}
                  r={4}
                  strokeWidth={2}
                />
              </g>
            ) : null}
            <rect
              fill="transparent"
              height={bottom - top}
              onPointerLeave={() => setHoverPrice(null)}
              onPointerMove={onPointerMove}
              style={{ touchAction: "pan-y" }}
              width={right - left}
              x={left}
              y={top}
            />
          </svg>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm border-2 border-(--market-up) bg-(--market-up-wash)" />
          Bids · buy orders
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm border-2 border-(--market-down) bg-(--market-down-wash)" />
          Asks · sell orders
        </li>
      </ul>
    </div>
  );
}
