import type { Metadata } from "next";
import { TriangleAlert } from "lucide-react";

import { AccountRefresh } from "@/components/account-refresh";
import { AllocationChart } from "@/components/allocation-chart";
import { Holdings } from "@/components/holdings";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAccountPortfolio } from "@/lib/account-portfolio";
import {
  allocationSlices,
  valuePortfolio,
  type Portfolio,
} from "@/lib/portfolio";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Accounts",
};

export default async function AccountsPage() {
  const { account: testnet, portfolio } = await getAccountPortfolio();
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Asset holdings and allocation in your connected Binance Spot Testnet account, valued in USDT."
        title="Accounts"
      />

      <Card className="mt-6">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Binance Spot Testnet</CardTitle>
            <Badge
              variant={testnet.status === "connected" ? "secondary" : "outline"}
            >
              {testnet.status === "connected"
                ? "Connected · virtual funds"
                : testnet.status === "not_configured"
                  ? "Setup required"
                  : "Unavailable"}
            </Badge>
          </div>
          <CardDescription>
            {testnet.status === "connected"
              ? `Account snapshot ${testnet.snapshot.capturedAt}. Refreshes every 10 seconds. Trading permission: ${testnet.snapshot.canTrade ? "enabled" : "disabled"}.`
              : testnet.message}
          </CardDescription>
        </CardHeader>
        {testnet.status === "connected" ? (
          <CardContent className="space-y-6">
            {portfolio.status === "connected" ? (
              <ValuedHoldings portfolio={portfolio.portfolio} />
            ) : (
              <>
                <Alert>
                  <TriangleAlert className="text-amber-600 dark:text-amber-400" />
                  <AlertTitle>USDT prices are unavailable</AlertTitle>
                  <AlertDescription>
                    Values and allocation will appear when prices load.{" "}
                    {portfolio.message}
                  </AlertDescription>
                </Alert>
                <Holdings
                  holdings={
                    valuePortfolio(testnet.snapshot.balances, []).holdings
                  }
                />
              </>
            )}
          </CardContent>
        ) : null}
      </Card>
    </>
  );
}

function ValuedHoldings({ portfolio }: { portfolio: Portfolio }) {
  const slices = allocationSlices(portfolio);
  return (
    <>
      <section aria-labelledby="allocation-heading">
        <h2 className="mb-3 text-sm font-medium" id="allocation-heading">
          Allocation
        </h2>
        {slices.length > 0 ? (
          <AllocationChart slices={slices} total={portfolio.total} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No priced balances to allocate.
          </p>
        )}
      </section>
      {portfolio.unpriced.length > 0 ? (
        <Alert>
          <TriangleAlert className="text-amber-600 dark:text-amber-400" />
          <AlertTitle>
            Left out of net worth and allocation:{" "}
            {portfolio.unpriced.join(", ")}
          </AlertTitle>
          <AlertDescription>
            These assets have no USDT market, inverse market, or market with
            BTC, ETH or BNB, so they are not priced.
          </AlertDescription>
        </Alert>
      ) : null}
      <Holdings holdings={portfolio.holdings} />
    </>
  );
}
