import type { Metadata } from "next";
import { Bot, Database, LockKeyhole, Radio } from "lucide-react";

import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTestnetAccount } from "@/lib/testnet-account";

export const metadata: Metadata = { title: "Settings · Northstar Trading" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const account = await getTestnetAccount();
  const settings = [
    {
      icon: LockKeyhole,
      title: "Trading mode",
      description:
        "Binance Spot Testnet orders use virtual funds. Production trading is disabled by the execution service.",
      value: "Testnet",
    },
    {
      icon: Bot,
      title: "Analysis assistant",
      description:
        "Uses the displayed exchange account snapshot when you send a message from Overview. Model connectivity is checked when a request is sent.",
      value: "On demand",
    },
    {
      icon: Database,
      title: "Data source",
      description:
        account.status === "connected"
          ? `Balances, orders, and fills come from Binance Spot Testnet. Last successful snapshot: ${account.snapshot.capturedAt}.`
          : account.message,
      value:
        account.status === "connected" ? "Binance Spot Testnet" : "Unavailable",
    },
    {
      icon: Radio,
      title: "Exchange connection",
      description:
        account.status === "connected"
          ? `Authenticated account reads are working. Trading permission: ${account.snapshot.canTrade ? "enabled" : "disabled"}.`
          : account.message,
      value:
        account.status === "connected"
          ? "Connected"
          : account.status === "not_configured"
            ? "Setup required"
            : "Unavailable",
    },
  ];
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Current exchange connection and application capabilities."
        eyebrow="Workspace configuration"
        title="Settings"
      />
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {settings.map(({ icon: Icon, title, description, value }) => (
          <Card key={title}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <Icon className="size-4" />
                </div>
                <Badge variant="outline">{value}</Badge>
              </div>
              <CardTitle className="mt-3">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="leading-6">
                {description}
              </CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
