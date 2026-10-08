import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { FillsTable } from "@/components/fills-table";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTestnetAccount } from "@/lib/testnet-account";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const account = await getTestnetAccount();
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Recent exchange fills for BTC/USDT and ETH/USDT, reported directly by Binance Spot Testnet."
        title="Activity"
      />
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent fills</CardTitle>
          <CardDescription>
            {account.status === "connected"
              ? `Latest 50 fills across the supported markets. Updated ${account.snapshot.capturedAt}. Refreshes every 10 seconds.`
              : account.message}
          </CardDescription>
        </CardHeader>
        {account.status === "connected" ? (
          <CardContent className="overflow-x-auto">
            <FillsTable
              fills={account.snapshot.fills}
              now={account.snapshot.capturedAt}
              showFillId
            />
          </CardContent>
        ) : null}
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>AI decision history</CardTitle>
          <CardDescription>
            AI decision persistence is not implemented. The exchange fills above
            are manual trading activity.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
