import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { DecisionHistory } from "@/components/decision-history";
import { FillsTable } from "@/components/fills-table";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDecisionHistory } from "@/lib/decisions";
import { getTestnetAccount } from "@/lib/testnet-account";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const [decisions, account] = await Promise.all([
    getDecisionHistory(),
    getTestnetAccount(),
  ]);
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="The analysis assistant's decisions and what became of each proposal, and recent exchange fills for BTC/USDT and ETH/USDT, reported directly by Binance Spot Testnet."
        title="Activity"
      />
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>AI decisions</CardTitle>
          <CardDescription>
            {decisions.status === "connected"
              ? "Trade proposals and decisions not to trade, newest first. You approve or reject each proposal, and the execution worker checks it again before anything is sent. Latest 50."
              : decisions.message}
          </CardDescription>
        </CardHeader>
        {decisions.status === "connected" ? (
          <CardContent>
            <DecisionHistory
              decisions={decisions.decisions}
              now={decisions.readAt}
            />
          </CardContent>
        ) : null}
      </Card>
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
    </>
  );
}
