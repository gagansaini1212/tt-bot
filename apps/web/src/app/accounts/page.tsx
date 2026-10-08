import type { Metadata } from "next";
import { TriangleAlert } from "lucide-react";

import { AccountRefresh } from "@/components/account-refresh";
import { AssetMixChart } from "@/components/asset-mix-chart";
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
import { assetMix, valuePortfolio, type Portfolio } from "@/lib/portfolio";

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
        description="Asset holdings in your connected Binance Spot Testnet account, valued in USDT, and each asset's share of net worth."
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
                    Values and the asset mix will appear when prices load.{" "}
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
  const slices = assetMix(portfolio);
  return (
    <>
      <section aria-labelledby="asset-mix-heading">
        <h2 className="mb-3 text-sm font-medium" id="asset-mix-heading">
          Asset mix
        </h2>
        {slices.length > 0 ? (
          <AssetMixChart slices={slices} total={portfolio.total} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No priced balances to show.
          </p>
        )}
      </section>
      {portfolio.unpriced.length > 0 ? (
        <Alert>
          <TriangleAlert className="text-amber-600 dark:text-amber-400" />
          <AlertTitle>
            Left out of net worth and the asset mix:{" "}
            {portfolio.unpriced.join(", ")}
          </AlertTitle>
          <AlertDescription>
            No market with USDT, or with BTC, ETH or BNB, gives these assets a
            current and 24-hour open price, so they are not priced.
          </AlertDescription>
        </Alert>
      ) : null}
      <Holdings holdings={portfolio.holdings} />
    </>
  );
}
