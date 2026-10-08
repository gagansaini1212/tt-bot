"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { BacktestResult } from "@crypto-trading/backtest";

import styles from "@/components/backtest/backtest-colors.module.css";
import { formatDay, formatHour, formatUsdt } from "@/lib/backtest-display";
import {
  dayTicks,
  linePath,
  nearestPoint,
  plotPoints,
  valueAxis,
} from "@/lib/equity-chart";

const HEIGHT = 260;
const MARGIN = { top: 12, right: 64, bottom: 24, left: 4 };

const axisValue = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
// Written out in full, so Tailwind finds the classes.
const DOT = {
  strategy: "fill-(--equity-strategy) stroke-card",
  baseline: "fill-(--equity-baseline) stroke-card",
};

/**
 * The strategy's equity against buying and holding, at each hourly close,
 * drawn as SVG so it follows the theme through CSS. The strategy is the
 * accent and the baseline a recessive grey, with a hairline at the
 * allocation both start from.
 */
export function EquityChart({
  equity,
  allocation,
  label,
}: {
  equity: BacktestResult["equity"];
  allocation: string;
  /** Names the market, such as "BTC/USDT". */
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const clipId = `equity-${useId().replace(/[^\w-]/g, "")}`;

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(containerRef.current!);
    return () => observer.disconnect();
  }, []);

  const points = plotPoints(equity);
  const start = points[0].time;
  const end = points[points.length - 1].time;
  const axis = valueAxis(points, Number(allocation));
  const left = MARGIN.left;
  const right = Math.max(left + 1, width - MARGIN.right);
  const top = MARGIN.top;
  const bottom = HEIGHT - MARGIN.bottom;
  const x = (time: number) =>
    left + ((time - start) / Math.max(1, end - start)) * (right - left);
  const y = (value: number) =>
    bottom - ((value - axis.min) / (axis.max - axis.min)) * (bottom - top);
  const days = dayTicks(start, end, width < 480 ? 3 : 6);

  const last = equity[equity.length - 1];
  const shown = active === null ? null : equity[active];

  function onPointerMove(event: PointerEvent<SVGRectElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - bounds.left) / bounds.width),
    );
    setActive(nearestPoint(points, start + ratio * (end - start)));
  }

  function onKeyDown(event: KeyboardEvent<SVGRectElement>) {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      PageDown: -24,
      PageUp: 24,
    };
    if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(points.length - 1);
    else if (event.key === "Escape") setActive(null);
    else if (steps[event.key]) {
      const from = active ?? points.length - 1;
      setActive(
        Math.min(points.length - 1, Math.max(0, from + steps[event.key])),
      );
    } else return;
    event.preventDefault();
  }

  return (
    <div className={`${styles.colors} space-y-2`} ref={containerRef}>
      <p
        aria-live="polite"
        className="min-h-5 text-xs text-muted-foreground tabular-nums"
      >
        {shown ? (
          <>
            {formatHour(shown.time)} UTC · Strategy{" "}
            <span className="font-medium text-foreground">
              {formatUsdt(shown.strategy)}
            </span>{" "}
            · Buy and hold{" "}
            <span className="font-medium text-foreground">
              {formatUsdt(shown.baseline)}
            </span>{" "}
            USDT
          </>
        ) : (
          <>
            At the end · Strategy{" "}
            <span className="font-medium text-foreground">
              {formatUsdt(last.strategy)}
            </span>{" "}
            · Buy and hold{" "}
            <span className="font-medium text-foreground">
              {formatUsdt(last.baseline)}
            </span>{" "}
            USDT
          </>
        )}
      </p>
      <div className="h-[260px] w-full">
        {width > 0 ? (
          <svg
            aria-label={`Equity of the strategy and of buying and holding ${label}, from ${formatUsdt(allocation)} USDT to ${formatUsdt(last.strategy)} and ${formatUsdt(last.baseline)} USDT.`}
            className="block text-[11px]"
            height={HEIGHT}
            role="img"
            width={width}
          >
            <defs>
              <clipPath id={clipId}>
                <rect
                  height={bottom - top + 4}
                  width={right - left + 4}
                  x={left - 2}
                  y={top - 2}
                />
              </clipPath>
            </defs>
            {axis.ticks.map((tick) => (
              <g key={tick}>
                <line
                  className="stroke-(--equity-grid)"
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
                  {axisValue.format(tick)}
                </text>
              </g>
            ))}
            {days.map((time, index) => (
              <text
                className="fill-muted-foreground tabular-nums"
                key={time}
                textAnchor={
                  index === 0 && x(time) - left < 24
                    ? "start"
                    : right - x(time) < 24
                      ? "end"
                      : "middle"
                }
                x={x(time)}
                y={HEIGHT - 6}
              >
                {formatDay(time)}
              </text>
            ))}
            <line
              className="stroke-(--equity-axis)"
              x1={left}
              x2={right}
              y1={bottom}
              y2={bottom}
            />
            <line
              className="stroke-(--equity-reference)"
              x1={left}
              x2={right}
              y1={y(Number(allocation))}
              y2={y(Number(allocation))}
            />
            <g clipPath={`url(#${clipId})`}>
              <path
                className="stroke-(--equity-baseline)"
                d={linePath(points, "baseline", x, y)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
              />
              <path
                className="stroke-(--equity-strategy)"
                d={linePath(points, "strategy", x, y)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
              />
            </g>
            {active === null
              ? (["baseline", "strategy"] as const).map((series) => (
                  <circle
                    className={DOT[series]}
                    cx={x(end)}
                    cy={y(points[points.length - 1][series])}
                    key={series}
                    r={4}
                    strokeWidth={2}
                  />
                ))
              : null}
            {active !== null ? (
              <g pointerEvents="none">
                <line
                  className="stroke-(--equity-crosshair)"
                  x1={x(points[active].time)}
                  x2={x(points[active].time)}
                  y1={top}
                  y2={bottom}
                />
                {(["baseline", "strategy"] as const).map((series) => (
                  <circle
                    className={DOT[series]}
                    cx={x(points[active].time)}
                    cy={y(points[active][series])}
                    key={series}
                    r={4}
                    strokeWidth={2}
                  />
                ))}
              </g>
            ) : null}
            <rect
              aria-label="Equity at a time. Use the arrow keys to move by an hour, Page Up and Page Down by a day."
              className="outline-none focus-visible:stroke-ring"
              fill="transparent"
              height={bottom - top}
              onBlur={() => setActive(null)}
              onKeyDown={onKeyDown}
              onPointerLeave={() => setActive(null)}
              onPointerMove={onPointerMove}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={points.length - 1}
              aria-valuenow={active ?? points.length - 1}
              aria-valuetext={`${formatHour((shown ?? last).time)} UTC`}
              style={{ touchAction: "pan-y" }}
              tabIndex={0}
              width={right - left}
              x={left}
              y={top}
            />
          </svg>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-(--equity-strategy)" />
          Strategy
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-(--equity-baseline)" />
          Buy and hold
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-(--equity-reference)" />
          Allocation, {formatUsdt(allocation)} USDT
        </li>
      </ul>
    </div>
  );
}
