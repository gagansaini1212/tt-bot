import { Eye } from "lucide-react";

import { FillsTable } from "@/components/fills-table";
import { Holdings } from "@/components/holdings";
import { OpenOrders } from "@/components/open-orders";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AccountTotals, OverviewState } from "@/lib/account-portfolio";
import { unvaluedHoldings } from "@/lib/portfolio";

/**
 * The customer's other exchange accounts that the worker reads, beside the
 * one the dashboard acts on: each with its own balances, open orders and
 * recent fills, from its own snapshot (ADR 0009). A plain list for M4; the
 * account switcher and combined views come with #25. Nothing here places or
 * cancels anything: a read-only account takes no orders, and another
 * account's orders are not this page's to cancel.
 */
export function OtherAccounts({ overview }: { overview: OverviewState }) {
  if (overview.status !== "connected") return null;
  const others = overview.overview.accounts.filter(
    (entry) => !entry.current && entry.account.served,
  );
  if (!others.length) return null;
  return (
    <section
      aria-labelledby="other-accounts-heading"
      className="mt-6 space-y-4"
    >
      <h2 className="text-base font-semibold" id="other-accounts-heading">
        Other exchange accounts
      </h2>
      {others.map((entry) => (
        <OtherAccount entry={entry} key={entry.account.id} />
      ))}
    </section>
  );
}

function OtherAccount({ entry }: { entry: AccountTotals }) {
  const readOnly = entry.account.access === "read_only";
  const state = entry.snapshot;
  const snapshot = state?.status === "connected" ? state.snapshot : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {entry.name}
          {readOnly ? (
            <Badge variant="outline">
              <Eye aria-hidden />
              Read only
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription className="leading-6">
          {snapshot
            ? `Updated ${snapshot.capturedAt.slice(11, 19)} UTC. ${
                readOnly
                  ? `The product only monitors this ${entry.account.venueName} account and never trades it.`
                  : "Shown for reference: orders are placed and cancelled on the account the dashboard acts on."
              }`
            : state?.status !== "connected" && state
              ? state.message
              : entry.status === "unavailable"
                ? entry.reason
                : "Its balances are unavailable."}
        </CardDescription>
      </CardHeader>
      {snapshot ? (
        <CardContent className="space-y-6">
          {entry.status === "valued" ? (
            <Holdings
              currency={entry.portfolio.currency}
              holdings={entry.portfolio.holdings}
            />
          ) : (
            <Holdings
              currency="—"
              holdings={unvaluedHoldings(snapshot.balances)}
            />
          )}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Open orders</h3>
            <div
              aria-label={`Open orders on ${entry.name}`}
              className="overflow-x-auto rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              role="region"
              tabIndex={0}
            >
              <OpenOrders readOnly snapshot={snapshot} />
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recent trades</h3>
            <FillsTable
              fills={snapshot.fills.slice(0, 10)}
              now={snapshot.capturedAt}
            />
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
