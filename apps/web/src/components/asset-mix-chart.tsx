"use client";

import { useState } from "react";

import { formatAmount } from "@/lib/format";
import type { MIX_SLICES, MixSlice } from "@/lib/portfolio";
import { cn } from "@/lib/utils";

// One categorical slot per slice, in a fixed order, with light and dark steps
// that pass the colour-vision checks as neighbours, including slot 6 next to
// slot 1. "Other" is a recessive grey that stays distinct from its neighbours.
const SLOT_COLORS = [
  "text-[#2a78d6] dark:text-[#3987e5]",
  "text-[#eb6834] dark:text-[#d95926]",
  "text-[#1baf7a] dark:text-[#199e70]",
  "text-[#eda100] dark:text-[#c98500]",
  "text-[#e87ba4] dark:text-[#d55181]",
  "text-[#008300] dark:text-[#008300]",
] as const satisfies { length: typeof MIX_SLICES };
const OTHER_COLOR = "text-[#c3c2b7] dark:text-[#4a4945]";

const SIZE = 176;
const CENTER = SIZE / 2;
const OUTER = 88;
const INNER = 64;

/** A ring segment between two fractions of a turn, clockwise from 12 o'clock. */
function segment(start: number, end: number) {
  // Rounded so the server and every browser write the same path.
  const point = (turn: number, radius: number) =>
    `${(CENTER + radius * Math.sin(turn * 2 * Math.PI)).toFixed(2)} ${(CENTER - radius * Math.cos(turn * 2 * Math.PI)).toFixed(2)}`;
  const large = end - start > 0.5 ? 1 : 0;
  return [
    `M${point(start, OUTER)}`,
    `A${OUTER} ${OUTER} 0 ${large} 1 ${point(end, OUTER)}`,
    `L${point(end, INNER)}`,
    `A${INNER} ${INNER} 0 ${large} 0 ${point(start, INNER)}`,
    "Z",
  ].join(" ");
}

function name(slice: MixSlice) {
  return slice.folded > 0 ? `Other (${slice.folded} assets)` : slice.label;
}

function share(slice: MixSlice) {
  return `${formatAmount(slice.share)}%`;
}

/** The asset mix: each priced holding's share of net worth, as a donut with a legend. */
export function AssetMixChart({
  slices,
  total,
}: {
  slices: MixSlice[];
  total: string;
}) {
  const [active, setActive] = useState<number>();
  const colors = slices.map((slice, index) =>
    slice.folded > 0 ? OTHER_COLOR : SLOT_COLORS[index],
  );
  // Angles only place the marks; the values shown come from the decimals.
  let turn = 0;
  const arcs = slices.map((slice) => {
    const start = turn;
    turn += Number(slice.share) / 100;
    return { start, end: Math.min(turn, 1) };
  });
  const focus = active === undefined ? undefined : slices[active];
  const summary = slices
    .map((slice) => `${name(slice)} ${share(slice)}`)
    .join(", ");

  return (
    <figure className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg
          aria-label={`Share of net worth by asset: ${summary}.`}
          height={SIZE}
          role="img"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width={SIZE}
        >
          {slices.length === 1 ? (
            <circle
              className={colors[0]}
              cx={CENTER}
              cy={CENTER}
              fill="none"
              r={(OUTER + INNER) / 2}
              stroke="currentColor"
              strokeWidth={OUTER - INNER}
            />
          ) : (
            arcs.map(({ start, end }, index) => (
              <path
                className={cn(
                  colors[index],
                  "stroke-card transition-opacity",
                  active !== undefined && active !== index && "opacity-35",
                )}
                d={segment(start, end)}
                fill="currentColor"
                key={slices[index].label}
                onPointerEnter={() => setActive(index)}
                onPointerLeave={() => setActive(undefined)}
                // A 2px surface gap between neighbouring segments.
                strokeWidth={2}
              />
            ))
          )}
        </svg>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center"
        >
          <span className="text-xs text-muted-foreground">
            {focus ? name(focus) : "Total"}
          </span>
          <span className="text-sm font-semibold tabular-nums">
            {focus ? share(focus) : formatAmount(total)}
          </span>
          <span className="text-xs text-muted-foreground">
            {focus ? `${formatAmount(focus.value)} USDT` : "USDT"}
          </span>
        </div>
      </div>
      <figcaption className="w-full min-w-0 sm:max-w-md sm:flex-1">
        <ul className="space-y-1 text-sm">
          {slices.map((slice, index) => (
            <li
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1",
                active === index && "bg-muted",
              )}
              key={slice.label}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(undefined)}
            >
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 rounded-sm bg-current",
                  colors[index],
                )}
              />
              <span className="min-w-0 flex-1 truncate">{name(slice)}</span>
              <span className="font-medium tabular-nums">{share(slice)}</span>
              <span className="w-28 text-right text-xs tabular-nums text-muted-foreground">
                {formatAmount(slice.value)}
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
