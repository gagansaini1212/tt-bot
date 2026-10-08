import Link from "next/link";
import {
  Activity,
  Bitcoin,
  CircleDollarSign,
  Coins,
  ShieldCheck,
} from "lucide-react";

import { AccountRefresh } from "@/components/account-refresh";
import { AssistantPanel } from "@/components/assistant-panel";
import { OpenOrders } from "@/components/open-orders";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
import { WelcomeCard } from "@/components/welcome-card";
import type { TestnetAccountState } from "@/lib/testnet-account";

export function TestnetOverview({ account }: { account: TestnetAccountState }) {
  const connected = account.status === "connected";
  return (
    <>
      <PageHeader
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="h-8 px-3" variant="outline">
              Binance Spot Testnet
            </Badge>
            <AccountRefresh />
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              href="/accounts"
            >
              View account
            </Link>
          </div>
        }
        description="Virtual balances, open orders, and recent fills from your Binance Spot Testnet exchange account."
        title="Overview"
      />

      <WelcomeCard />

      <Alert className="mt-6">
        <ShieldCheck className="size-4" />
        <AlertTitle>
          {connected
            ? "Connected · virtual funds"
            : account.status === "not_configured"
              ? "Testnet setup required"
              : "Testnet account unavailable"}
        </AlertTitle>
        <AlertDescription>
          {connected
            ? `Updated ${account.snapshot.capturedAt.slice(11, 19)} UTC. Refreshes every 10 seconds. These balances and fills come from Binance Spot Testnet.`
            : account.message}
        </AlertDescription>
      </Alert>

      {account.status === "connected" ? (
        <AccountContent account={account} />
      ) : (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Waiting for account data</CardTitle>
            <CardDescription>
              Balances and trade history will appear when the testnet connection
              is available.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </>
  );
}

function AccountContent({
  account,
}: {
  account: Extract<TestnetAccountState, { status: "connected" }>;
}) {
  const { snapshot } = account;
  const available = (asset: string) =>
    snapshot.balances.find((balance) => balance.asset === asset)?.free ?? "0";
  const fills = snapshot.fills.slice(0, 10);
  const accountSnapshot = {
    capturedAt: snapshot.capturedAt,
    dataKind: "Binance Spot Testnet, virtual funds",
    account: {
      venue: "Binance Spot Testnet",
      quoteCurrency: "USDT",
      canTrade: snapshot.canTrade,
      liveTradingLocked: true,
    },
    balanceScope:
      "BTC, ETH and USDT. Other asset balances are listed on Accounts.",
    balances: snapshot.balances.filter((balance) =>
      ["BTC", "ETH", "USDT"].includes(balance.asset),
    ),
    openOrders: snapshot.orders,
    recentFills: fills,
    strategyManagement:
      "Manual development trades. Strategy ownership, protection and profit/loss are not tracked for these holdings.",
  };

  return (
    <>
      <section
        className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Testnet account summary"
      >
        <Metric
          label="Available USDT"
          value={available("USDT")}
          suffix="USDT"
          icon={CircleDollarSign}
        />
        <Metric
          label="Available BTC"
          value={available("BTC")}
          suffix="BTC"
          icon={Bitcoin}
        />
        <Metric
          label="Available ETH"
          value={available("ETH")}
          suffix="ETH"
          icon={Coins}
        />
        <Metric
          label="Open orders"
          value={String(snapshot.orders.length)}
          suffix="BTC / ETH"
          icon={Activity}
        />
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.8fr)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Recent trades</CardTitle>
              <CardDescription>
                Latest 10 fills across BTC/USDT and ETH/USDT. Prices and fees
                are reported by Binance.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market / side</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Fee</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Time · UTC</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fills.map((fill) => (
                    <TableRow key={`${fill.symbol}-${fill.id}`}>
                      <TableCell>
                        <span className="font-medium">{fill.symbol}</span>
                        <Badge
                          className="ml-2"
                          variant={fill.isBuyer ? "secondary" : "outline"}
                        >
                          {fill.isBuyer ? "BUY" : "SELL"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {fill.qty}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {fill.price}
                      </TableCell>
                      <TableCell className="text-xs">
                        {fill.commission} {fill.commissionAsset}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {fill.orderId}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        <time
                          dateTime={new Date(fill.time).toISOString()}
                          title={new Date(fill.time).toISOString()}
                        >
                          {new Date(fill.time).toISOString().slice(11, 19)}
                        </time>
                      </TableCell>
                    </TableRow>
                  ))}
                  {fills.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6}>No trades yet.</TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Open orders</CardTitle>
              <CardDescription>
                Open and pending orders on the connected testnet account. Orders
                in a list, such as an entry with its exits, are grouped.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <OpenOrders snapshot={snapshot} />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <AssistantPanel
            accountSnapshot={accountSnapshot}
            accountLabel="Binance Spot Testnet"
          />
          <Card>
            <CardHeader>
              <CardTitle>Account status</CardTitle>
              <CardDescription>
                Manual trades use virtual funds. Strategy allocations, position
                protection, and P&amp;L tracking are not configured for this
                account.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <Badge variant="outline">
                Trading permission: {snapshot.canTrade ? "enabled" : "disabled"}
              </Badge>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  suffix,
  icon: Icon,
}: {
  label: string;
  value: string;
  suffix: string;
  icon: typeof Activity;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between text-muted-foreground">
          <p className="text-xs font-medium uppercase tracking-wider">
            {label}
          </p>
          <Icon className="size-4" />
        </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-2">
          <p className="font-mono text-xl font-semibold tracking-tight">
            {value}
          </p>
          <span className="text-xs text-muted-foreground">{suffix}</span>
        </div>
      </CardContent>
    </Card>
  );
}
