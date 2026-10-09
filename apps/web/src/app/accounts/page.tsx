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
import { VALUATION_FRESHNESS_MS } from "@crypto-trading/domain";

import { getAccountPortfolio } from "@/lib/account-portfolio";
import { assetMix, unvaluedHoldings, type Portfolio } from "@/lib/portfolio";

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
        description="Asset holdings in your connected Binance Spot Testnet account, valued in your reporting currency, and each asset's share of the account's value."
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
                  <AlertTitle>Values are unavailable</AlertTitle>
                  <AlertDescription>
                    Values and the asset mix will appear when prices load.{" "}
                    {portfolio.message}
                  </AlertDescription>
                </Alert>
                <Holdings
                  currency="—"
                  holdings={unvaluedHoldings(testnet.snapshot.balances)}
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
  const missing = portfolio.holdings.filter(
    (holding) => holding.unconverted?.status === "missing",
  );
  const stale = portfolio.holdings.filter(
    (holding) => holding.unconverted?.status === "stale",
  );
  return (
    <>
      <section aria-labelledby="asset-mix-heading">
        <h2 className="mb-3 text-sm font-medium" id="asset-mix-heading">
          Asset mix
        </h2>
        {slices.length > 0 ? (
          <AssetMixChart
            currency={portfolio.currency}
            slices={slices}
            total={portfolio.total}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No priced balances to show.
          </p>
        )}
      </section>
      {missing.length > 0 ? (
        <Alert>
          <TriangleAlert className="text-amber-600 dark:text-amber-400" />
          <AlertTitle>
            Left out of net worth and the asset mix:{" "}
            {missing.map((holding) => holding.asset).join(", ")}
          </AlertTitle>
          <AlertDescription>
            Binance Spot Testnet has no market with a price that converts these
            into {portfolio.currency}, directly or through USDT or USDC, so they
            have no value here. They are never counted as zero.
          </AlertDescription>
        </Alert>
      ) : null}
      {stale.length > 0 ? (
        <Alert>
          <TriangleAlert className="text-amber-600 dark:text-amber-400" />
          <AlertTitle>
            Left out until their prices are fresh:{" "}
            {stale.map((holding) => holding.asset).join(", ")}
          </AlertTitle>
          <AlertDescription>
            Their markets last traded more than {VALUATION_FRESHNESS_MS / 1000}{" "}
            seconds ago, so their price is stale. Each row says since when.
          </AlertDescription>
        </Alert>
      ) : null}
      <Holdings currency={portfolio.currency} holdings={portfolio.holdings} />
    </>
  );
}
