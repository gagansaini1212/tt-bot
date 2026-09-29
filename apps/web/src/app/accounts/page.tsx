import type { Metadata } from "next";
import { CircleDollarSign, ShieldCheck, WalletCards } from "lucide-react";

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
import { positions } from "@/lib/dashboard-fixtures";

export const metadata: Metadata = {
  title: "Accounts · Northstar Trading",
};

export default function AccountsPage() {
  return (
    <>
      <PageHeader
        action={<Badge variant="secondary">Connected</Badge>}
        description="Exchange balances, strategy allocation, and positions for the selected simulation account."
        eyebrow="Portfolio control"
        title="Accounts"
      />

      <section
        className="mt-6 grid gap-4 sm:grid-cols-3"
        aria-label="Account summary"
      >
        <SummaryCard
          icon={WalletCards}
          label="Portfolio value"
          value="24,860.42 USDT"
        />
        <SummaryCard
          icon={CircleDollarSign}
          label="Available allocation"
          value="6,920.00 USDT"
        />
        <SummaryCard
          icon={ShieldCheck}
          label="Position protection"
          value="2 of 2 protected"
        />
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[0.7fr_1.3fr]">
        <Card>
          <CardHeader>
            <CardTitle>Binance mock</CardTitle>
            <CardDescription>
              Primary simulated exchange account
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <DetailRow label="Customer" value="Alex" />
            <DetailRow label="Quote currency" value="USDT" />
            <DetailRow label="Trading mode" value="Simulation" />
            <DetailRow label="Live order access" value="Locked" />
            <DetailRow label="Fixture customers" value="10" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open positions</CardTitle>
            <CardDescription>
              Positions owned by active strategy versions on this account.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>P&amp;L</TableHead>
                  <TableHead className="text-right">Exit deadline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((position) => (
                  <TableRow key={position.instrument}>
                    <TableCell>
                      <p className="font-medium">{position.instrument}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {position.type}
                      </p>
                    </TableCell>
                    <TableCell>{position.strategy}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {position.quantity}
                    </TableCell>
                    <TableCell
                      className={
                        position.positive ? "text-emerald-400" : "text-rose-400"
                      }
                    >
                      {position.pnl} USDT
                    </TableCell>
                    <TableCell className="text-right">
                      {position.deadline}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof WalletCards;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          <p className="text-xs font-medium uppercase tracking-wider">
            {label}
          </p>
        </div>
        <p className="mt-4 font-mono text-xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/70 pb-3 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
