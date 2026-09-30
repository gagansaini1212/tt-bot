import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getTestnetAccount } from "@/lib/testnet-account";

export const metadata: Metadata = { title: "Activity · Northstar Trading" };
export const dynamic = "force-dynamic";

export default async function DecisionsPage() {
  const account = await getTestnetAccount();
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Recent exchange fills for BTC/USDT and ETH/USDT, reported directly by Binance Spot Testnet."
        eyebrow="Exchange history"
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time · UTC</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Fee</TableHead>
                  <TableHead>Order ID</TableHead>
                  <TableHead>Fill ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {account.snapshot.fills.map((fill) => (
                  <TableRow key={`${fill.symbol}-${fill.id}`}>
                    <TableCell className="whitespace-nowrap text-xs">
                      <time dateTime={new Date(fill.time).toISOString()}>
                        {new Date(fill.time).toISOString()}
                      </time>
                    </TableCell>
                    <TableCell>{fill.symbol}</TableCell>
                    <TableCell>{fill.isBuyer ? "BUY" : "SELL"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {fill.qty}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fill.price}
                    </TableCell>
                    <TableCell>
                      {fill.commission} {fill.commissionAsset}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fill.orderId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fill.id}
                    </TableCell>
                  </TableRow>
                ))}
                {account.snapshot.fills.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8}>No recorded fills.</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
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
