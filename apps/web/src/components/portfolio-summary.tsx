import type { ReactNode } from "react";
import Link from "next/link";
import {
  Minus,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  WalletCards,
} from "lucide-react";
import {
  VALUATION_FRESHNESS_MS,
  type CombinedValuation,
} from "@crypto-trading/domain";

import { ReportingCurrencyForm } from "@/components/reporting-currency-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { OverviewState, PortfolioOverview } from "@/lib/account-portfolio";
import {
  changeTone,
  formatAmount,
  formatChange,
  formatDecimal,
  formatPercent,
  formatUtc,
} from "@/lib/format";
import { cn } from "@/lib/utils";

// Holdings left out that are named before the rest are counted.
const NAMED_HOLDINGS = 5;

/**
 * Net worth and its 24-hour change across every exchange account, in the
 * customer's reporting currency, with the accounts and holdings it leaves
 * out. Allocations and limits are not shown here: they stay per account.
 */
export function PortfolioSummary({ overview }: { overview: OverviewState }) {
  return (
    <Card aria-labelledby="net-worth-label" className="mt-6" role="region">
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
        {overview.status === "connected" ? (
          <NetWorth overview={overview.overview} />
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Net worth across your exchange accounts is unavailable.{" "}
            {overview.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function NetWorth({ overview }: { overview: PortfolioOverview }) {
  const { combined, accounts } = overview;
  const currency = combined.currency;
  // With balances but none converted, a total of 0.00 would be wrong.
  const valued =
    combined.counted > 0 &&
    (combined.converted > 0 || combined.unconverted.length === 0);
  return (
    <>
      {valued ? (
        <Figures accounts={accounts.length} combined={combined} />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing could be converted into {currency}, so there is no net worth
          to show.
        </p>
      )}
      {combined.complete ? null : <LeftOut combined={combined} />}
      <ReportingCurrencyForm
        current={overview.reportingCurrency}
        options={overview.options}
      />
      <div
        className="mt-4 space-y-1 border-t border-border pt-3 text-xs leading-5 text-muted-foreground"
        id="net-worth-definitions"
      >
        <p>
          Net worth adds every exchange account&apos;s available and locked
          balances, each converted into {currency} with its own venue&apos;s
          latest prices: directly, or through one market with USDT or USDC. No
          currency counts as another, stablecoins included. A balance without
          such a route, or whose price is more than{" "}
          {VALUATION_FRESHNESS_MS / 1000} seconds old, is left out and named
          here, never counted as zero. Allocations and limits stay in each
          account&apos;s own currency.
        </p>
        <p>
          24h change is each current balance × (last price − the 24-hour open
          price): the change if you had held today&apos;s balances all day, so
          deposits, withdrawals and trades in that time are not separated out.
          Realized P&amp;L is not shown because fills do not record what the
          sold coins cost.
        </p>
      </div>
    </>
  );
}

function Figures({
  combined,
  accounts,
}: {
  combined: CombinedValuation;
  accounts: number;
}) {
  const change = formatChange(combined.change);
  const Icon = change.startsWith("+")
    ? TrendingUp
    : change.startsWith("-")
      ? TrendingDown
      : Minus;
  return (
    <>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-4xl font-semibold tracking-tight sm:text-5xl">
        {formatAmount(combined.total)}
        <span className="text-base font-medium text-muted-foreground">
          {combined.currency}
        </span>
        {combined.complete ? null : (
          <Badge className="self-center" variant="outline">
            Incomplete
          </Badge>
        )}
      </p>
      {accounts > 1 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {combined.counted === accounts
            ? `Across your ${accounts} exchange accounts`
            : `Across ${combined.counted} of your ${accounts} exchange accounts`}
        </p>
      ) : null}
      <p
        aria-describedby="net-worth-definitions"
        className={cn(
          "mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium",
          changeTone(change),
        )}
      >
        <Icon aria-hidden className="size-4" />
        <span>
          {change} {combined.currency}
        </span>
        {combined.changePercent ? (
          <span>({formatPercent(combined.changePercent)})</span>
        ) : null}
        <span className="font-normal text-muted-foreground">
          24h change in value of current holdings
          {combined.withoutOpen
            ? `, except ${combined.withoutOpen === 1 ? "1 holding" : `${combined.withoutOpen} holdings`} without a 24-hour open price`
            : ""}
        </span>
      </p>
    </>
  );
}

/** The accounts and holdings the total leaves out, each in its own currency. */
function LeftOut({ combined }: { combined: CombinedValuation }) {
  const { currency, leftOutAccounts, unconverted } = combined;
  // Name the account only when more than one is counted.
  const where = (label: string) => (combined.counted > 1 ? ` on ${label}` : "");
  const missing = unconverted.filter((holding) => holding.status === "missing");
  const stale = unconverted.flatMap((holding) =>
    holding.status === "stale" ? [holding] : [],
  );
  const listed = (count: number, shown: string[]) =>
    `${shown.join(", ")}${count > shown.length ? ` and ${count - shown.length} more` : ""}`;
  return (
    <ul className="mt-3 space-y-2 text-sm">
      {leftOutAccounts.map((account) => (
        <Note key={account.exchangeAccountId}>
          Not counted: {account.label}. {account.reason}
        </Note>
      ))}
      {missing.length ? (
        <Note>
          Left out, with no market with a price on their venue to convert them
          into {currency}:{" "}
          {listed(
            missing.length,
            missing
              .slice(0, NAMED_HOLDINGS)
              .map(
                (holding) =>
                  `${formatDecimal(holding.quantity)} ${holding.asset}${where(holding.label)}`,
              ),
          )}
          . <HoldingsLink />
        </Note>
      ) : null}
      {stale.length ? (
        <Note>
          Left out, with prices more than {VALUATION_FRESHNESS_MS / 1000}{" "}
          seconds old:{" "}
          {listed(
            stale.length,
            stale
              .slice(0, NAMED_HOLDINGS)
              .map(
                (holding) =>
                  `${formatDecimal(holding.quantity)} ${holding.asset}${where(holding.label)}, priced ${formatUtc(holding.since)}`,
              ),
          )}
          . <HoldingsLink />
        </Note>
      ) : null}
    </ul>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <span>{children}</span>
    </li>
  );
}

function HoldingsLink() {
  return (
    <Link
      className="underline underline-offset-3 hover:text-foreground"
      href="/accounts"
    >
      See holdings
    </Link>
  );
}
