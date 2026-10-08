import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { AccountRefresh } from "@/components/account-refresh";
import { AccountBalances } from "@/components/account-balances";
import { getTestnetAccount } from "@/lib/testnet-account";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Accounts",
};

export default async function AccountsPage() {
  const testnet = await getTestnetAccount();
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Balances, orders, and fills reported by your connected Binance Spot Testnet account."
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
            <AccountBalances balances={testnet.snapshot.balances} />
            <div className="overflow-x-auto">
              <h2 className="mb-3 text-sm font-medium">
                Open orders · BTC/USDT and ETH/USDT
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market / side</TableHead>
                    <TableHead>Client ID</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Filled / quantity</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {testnet.snapshot.orders.map((order) => (
                    <TableRow key={`${order.symbol}-${order.orderId}`}>
                      <TableCell>
                        {order.symbol} {order.side}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {order.clientOrderId}
                      </TableCell>
                      <TableCell className="font-mono">{order.price}</TableCell>
                      <TableCell className="font-mono">
                        {order.executedQty} / {order.origQty}
                      </TableCell>
                      <TableCell>{order.status}</TableCell>
                    </TableRow>
                  ))}
                  {testnet.snapshot.orders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>No open orders.</TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
            <div className="overflow-x-auto">
              <h2 className="mb-3 text-sm font-medium">
                Recent fills · latest 50 across BTC/USDT and ETH/USDT
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market / side</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Fee</TableHead>
                    <TableHead>Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {testnet.snapshot.fills.map((fill) => (
                    <TableRow key={`${fill.symbol}-${fill.id}`}>
                      <TableCell>
                        {fill.symbol} {fill.isBuyer ? "BUY" : "SELL"}
                      </TableCell>
                      <TableCell className="font-mono">{fill.qty}</TableCell>
                      <TableCell className="font-mono">{fill.price}</TableCell>
                      <TableCell>
                        {fill.commission} {fill.commissionAsset}
                      </TableCell>
                      <TableCell>{new Date(fill.time).toISOString()}</TableCell>
                    </TableRow>
                  ))}
                  {testnet.snapshot.fills.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5}>No recent fills.</TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        ) : null}
      </Card>
    </>
  );
}
