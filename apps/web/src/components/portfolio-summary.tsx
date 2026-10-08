import Link from "next/link";
import {
  Minus,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  WalletCards,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { PortfolioState } from "@/lib/account-portfolio";
import { formatAmount, formatChange, formatPercent } from "@/lib/format";
import type { Portfolio } from "@/lib/portfolio";
import { cn } from "@/lib/utils";

// Unpriced assets named before the rest are counted.
const LISTED_UNPRICED = 5;

export function PortfolioSummary({ portfolio }: { portfolio: PortfolioState }) {
  return (
    <Card className="mt-6" aria-labelledby="net-worth-label">
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-center justify-between text-muted-foreground">
          <h2
            className="text-xs font-medium uppercase tracking-wider"
            id="net-worth-label"
          >
            Net worth
          </h2>
          <WalletCards className="size-4" />
        </div>
        {portfolio.status === "connected" ? (
          <Valuation portfolio={portfolio.portfolio} />
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Net worth needs current USDT prices, which are unavailable.{" "}
            {portfolio.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Valuation({ portfolio }: { portfolio: Portfolio }) {
  const change = formatChange(portfolio.change);
  const direction = change.startsWith("+")
    ? "up"
    : change.startsWith("-")
      ? "down"
      : "flat";
  const Icon = { up: TrendingUp, down: TrendingDown, flat: Minus }[direction];
  const unpriced = portfolio.unpriced;
  const named = unpriced.slice(0, LISTED_UNPRICED).join(", ");
  return (
    <>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-4xl font-semibold tracking-tight sm:text-5xl">
        {formatAmount(portfolio.total)}
        <span className="text-base font-medium text-muted-foreground">
          USDT
        </span>
      </p>
      <p
        aria-describedby="net-worth-definitions"
        className={cn(
          "mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium",
          direction === "up" && "text-emerald-700 dark:text-emerald-400",
          direction === "down" && "text-destructive",
        )}
      >
        <Icon aria-hidden className="size-4" />
        <span>{change} USDT</span>
        {portfolio.changePercent ? (
          <span>({formatPercent(portfolio.changePercent)})</span>
        ) : null}
        <span className="font-normal text-muted-foreground">
          24h change in value of current holdings
        </span>
      </p>
      {unpriced.length > 0 ? (
        <p className="mt-3 flex gap-2 text-sm">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <span>
            Left out:{" "}
            {unpriced.length === 1 ? "1 asset" : `${unpriced.length} assets`}{" "}
            with no USDT price ({named}
            {unpriced.length > LISTED_UNPRICED
              ? ` and ${unpriced.length - LISTED_UNPRICED} more`
              : ""}
            ).{" "}
            <Link
              className="underline underline-offset-3 hover:text-foreground"
              href="/accounts"
            >
              See holdings
            </Link>
          </span>
        </p>
      ) : null}
      <div
        className="mt-4 space-y-1 border-t border-border pt-3 text-xs leading-5 text-muted-foreground"
        id="net-worth-definitions"
      >
        <p>
          Net worth adds available and locked balances at the latest Binance
          Spot Testnet prices. USDT counts as 1; other assets use their USDT
          market, its inverse, or a market with BTC, ETH or BNB.
        </p>
        <p>
          24h change is each current balance × (last price − Binance&apos;s
          24-hour open price): the change if you had held today&apos;s balances
          all day, so deposits, withdrawals and trades in that time are not
          separated out. Realized P&amp;L is not shown because fills do not
          record what the sold coins cost.
        </p>
      </div>
    </>
  );
}
