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
import {
  ExecutionAlerts,
  NotificationsCard,
} from "@/components/execution-alerts";
import { FillsTable } from "@/components/fills-table";
import { OpenOrders } from "@/components/open-orders";
import { OtherAccounts } from "@/components/other-accounts";
import { PageHeader } from "@/components/page-header";
import { PortfolioSummary } from "@/components/portfolio-summary";
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
import { WelcomeCard } from "@/components/welcome-card";
import type { OverviewState } from "@/lib/account-portfolio";
import { assistantAccounts } from "@/lib/assistant-context";
import type { ExecutionView } from "@/lib/execution";
import { accountVenue, isReadOnly } from "@/lib/exchange-account-display";
import type { TestnetAccountState } from "@/lib/testnet-account";

export function TestnetOverview({
  account,
  overview,
  execution,
}: {
  account: TestnetAccountState;
  overview: OverviewState;
  execution: ExecutionView;
}) {
  const connected = account.status === "connected";
  // The account the dashboard acts on: its oldest that trades, by default.
  const venue = connected ? accountVenue(account.snapshot.venue) : undefined;
  const readOnly = venue ? isReadOnly(venue) : false;
  return (
    <>
      <PageHeader
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="h-8 px-3" variant="outline">
              {venue?.name ?? "Binance Spot Testnet"}
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
            ? readOnly
              ? "Connected · read only"
              : "Connected · virtual funds"
            : account.status === "not_configured"
              ? "Testnet setup required"
              : "Testnet account unavailable"}
        </AlertTitle>
        <AlertDescription>
          {connected
            ? `Updated ${account.snapshot.capturedAt.slice(11, 19)} UTC. Refreshes every 10 seconds. These balances and fills come from ${venue?.name ?? account.snapshot.venue}${readOnly ? ", which the product only monitors and never trades" : ""}.`
            : account.message}
        </AlertDescription>
      </Alert>

      {execution.status === "connected" ? (
        <ExecutionAlerts alerts={execution.execution.alerts} />
      ) : null}

      {account.status === "connected" ? (
        <AccountContent
          account={account}
          execution={execution}
          overview={overview}
          readOnly={readOnly}
        />
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
  overview,
  execution,
  readOnly,
}: {
  account: Extract<TestnetAccountState, { status: "connected" }>;
  overview: OverviewState;
  execution: ExecutionView;
  // On a venue the product only reads: its orders have no cancel buttons.
  readOnly: boolean;
}) {
  const { snapshot } = account;
  const available = (asset: string) =>
    snapshot.balances.find((balance) => balance.asset === asset)?.free ?? "0";
  const fills = snapshot.fills.slice(0, 10);

  return (
    <>
      <PortfolioSummary overview={overview} />

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
                Latest 10 fills across the markets your account allows. Prices
                and fees are reported by Binance.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <FillsTable fills={fills} now={snapshot.capturedAt} />
            </CardContent>
          </Card>

          <Card className="scroll-mt-20" id="open-orders">
            <CardHeader>
              <CardTitle>Open orders</CardTitle>
              <CardDescription>
                Open and pending orders on the connected testnet account, and
                stop-limit entries the worker holds. Orders in a list, such as
                an entry with its exits, are grouped.
              </CardDescription>
            </CardHeader>
            {/* Focusable so keyboard users can scroll the table sideways. */}
            <CardContent
              aria-label="Open orders"
              className="overflow-x-auto rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              role="region"
              tabIndex={0}
            >
              <OpenOrders
                execution={
                  execution.status === "connected"
                    ? execution.execution
                    : undefined
                }
                readOnly={readOnly}
                snapshot={snapshot}
              />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {/* AI decisions name the account snapshot they were based on. */}
          <AssistantPanel accounts={assistantAccounts(account, overview)} />
          <NotificationsCard execution={execution} />
          <Card>
            <CardHeader>
              <CardTitle>Account status</CardTitle>
              <CardDescription>
                Manual trades use virtual funds. The execution worker watches
                every order&apos;s exits. Strategy allocations and P&amp;L
                tracking are not configured for this account.
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

      <OtherAccounts overview={overview} />
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
