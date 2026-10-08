"use client";

import { useId, useState, useSyncExternalStore } from "react";

import { Switch } from "@/components/ui/switch";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatAmount,
  changeTone,
  formatChange,
  formatDecimal,
  formatPercent,
  formatPrice,
} from "@/lib/format";
import type { Holding } from "@/lib/portfolio";
import { createStoredFlag } from "@/lib/stored-flag";

const hideDust = createStoredFlag(
  "hide-dust-balances",
  true,
  () => localStorage,
);

/** Holdings, highest value first. */
export function Holdings({ holdings }: { holdings: Holding[] }) {
  const switchId = useId();
  const [search, setSearch] = useState("");
  const hiding = useSyncExternalStore(
    hideDust.subscribe,
    hideDust.get,
    () => hideDust.fallback,
  );
  const query = search.trim().toUpperCase();
  const visible = hiding
    ? holdings.filter((holding) => !holding.dust)
    : holdings;
  const shown = visible.filter((holding) => holding.asset.includes(query));
  const hidden = holdings.length - visible.length;
  return (
    <section aria-label="Holdings" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Holdings</h2>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-3 sm:w-auto">
          <div className="flex items-center gap-2">
            <Switch
              checked={hiding}
              id={switchId}
              onCheckedChange={hideDust.set}
            />
            <label className="text-sm" htmlFor={switchId}>
              Hide zero &amp; dust balances (&lt; $1.00)
            </label>
          </div>
          <input
            aria-label="Filter holdings"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:w-48"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search assets…"
            type="search"
            value={search}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {shown.length} of {holdings.length} assets
        {hidden > 0
          ? ` · ${hidden} zero or dust ${hidden === 1 ? "balance" : "balances"} hidden`
          : ""}
        . Dust is worth less than 1 USDT; balances without a price are always
        shown.
      </p>
      <div
        className="max-h-[32rem] overflow-auto rounded-md border border-border"
        aria-label="Holdings table"
        role="region"
        tabIndex={0}
      >
        {/* No Table wrapper: this element scrolls both ways, so the header can stick. */}
        <table className="w-full caption-bottom text-sm">
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Asset</TableHead>
              <TableHead>Available</TableHead>
              <TableHead>Locked</TableHead>
              <TableHead>Price · USDT</TableHead>
              <TableHead>Value · USDT</TableHead>
              <TableHead>24h</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((holding) => (
              <HoldingRow holding={holding} key={holding.asset} />
            ))}
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  {holdings.length === 0
                    ? "No nonzero balances."
                    : visible.length === 0
                      ? "Every balance is zero or dust. Turn off the filter to see them."
                      : "No matching assets."}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </table>
      </div>
    </section>
  );
}

function HoldingRow({ holding }: { holding: Holding }) {
  const { valuation } = holding;
  const change = valuation?.changePercent
    ? {
        percent: formatPercent(valuation.changePercent),
        amount: formatChange(valuation.change),
      }
    : undefined;
  return (
    <TableRow>
      <TableCell className="font-medium">{holding.asset}</TableCell>
      <TableCell className="font-mono text-xs">
        {formatDecimal(holding.free)}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {formatDecimal(holding.locked)}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {valuation ? (
          <span title={`Priced from ${valuation.source}`}>
            {formatPrice(valuation.price)}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {valuation ? (
          formatAmount(valuation.value)
        ) : (
          <span className="font-sans text-muted-foreground">Not priced</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">
        {change ? (
          <>
            <span className={changeTone(change.percent)}>{change.percent}</span>
            <span className="block text-muted-foreground">{change.amount}</span>
          </>
        ) : (
          <span
            className="text-muted-foreground"
            title={valuation ? valuation.source : undefined}
          >
            —
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
