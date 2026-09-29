import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CircleDollarSign,
  Clock3,
  Pause,
  ShieldCheck,
  WalletCards,
} from "lucide-react";

import { AssistantPanel } from "@/components/assistant-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  decisions,
  fixtureSnapshot,
  positions,
  strategies,
} from "@/lib/dashboard-fixtures";

export default function DashboardPage() {
  return (
    <>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Simulation workspace
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Good morning, Alex
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="h-8 px-3" variant="outline">
            Binance mock · USDT
          </Badge>
          <Button size="sm" variant="outline">
            <Pause className="size-4" />
            Pause entries
          </Button>
        </div>
      </header>

      <Alert className="mt-6 border-amber-500/25 bg-amber-500/8 text-amber-100">
        <ShieldCheck className="size-4 text-amber-300" />
        <AlertTitle>Live trading is locked</AlertTitle>
        <AlertDescription className="text-amber-100/70">
          This build uses deterministic fixtures and a mock exchange. It cannot
          submit real orders.
        </AlertDescription>
      </Alert>

      <section
        className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Account summary"
      >
        <MetricCard
          label="Portfolio value"
          value="24,860.42"
          suffix="USDT"
          icon={WalletCards}
        />
        <MetricCard
          label="Today’s P&L"
          value="+184.20"
          suffix="USDT"
          icon={ArrowUpRight}
          positive
        />
        <MetricCard
          label="Available allocation"
          value="6,920.00"
          suffix="USDT"
          icon={CircleDollarSign}
        />
        <MetricCard
          label="Open positions"
          value="2"
          suffix="protected"
          icon={ShieldCheck}
        />
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.8fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>Open positions</CardTitle>
                <CardDescription>
                  Positions opened by the agent on this account.
                </CardDescription>
              </div>
              <Badge variant="secondary">All protected</Badge>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:hidden">
                {positions.map((position) => (
                  <div
                    className="rounded-lg border border-border bg-background/35 p-4"
                    key={position.instrument}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium">
                          {position.instrument}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {position.type} · {position.strategy}
                        </p>
                      </div>
                      <span
                        className={`text-sm ${position.positive ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        {position.pnl}
                      </span>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-muted-foreground">Position</p>
                        <p className="mt-1 font-mono">{position.quantity}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Entry / mark</p>
                        <p className="mt-1 font-mono">
                          {position.entry} / {position.price}
                        </p>
                      </div>
                    </div>
                    <Badge className="mt-4" variant="outline">
                      <Clock3 className="size-3" />
                      {position.deadline} remaining
                    </Badge>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Entry / mark</TableHead>
                      <TableHead>P&amp;L</TableHead>
                      <TableHead className="text-right">Deadline</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map((position) => (
                      <TableRow key={position.instrument}>
                        <TableCell>
                          <div className="font-medium">
                            {position.instrument}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {position.type}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>{position.quantity}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {position.strategy}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <div>{position.entry}</div>
                          <div className="mt-1 text-muted-foreground">
                            {position.price}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              position.positive
                                ? "text-emerald-400"
                                : "text-rose-400"
                            }
                          >
                            {position.positive ? (
                              <ArrowUpRight className="mr-1 inline size-3.5" />
                            ) : (
                              <ArrowDownRight className="mr-1 inline size-3.5" />
                            )}
                            {position.pnl}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline">
                            <Clock3 className="size-3" />
                            {position.deadline}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Strategy allocation</CardTitle>
              <CardDescription>
                Pending orders reserve funds before exchange submission.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {strategies.map((strategy) => (
                <div key={strategy.name} className="space-y-2.5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{strategy.name}</p>
                        <Badge
                          variant={
                            strategy.status === "Paused"
                              ? "outline"
                              : "secondary"
                          }
                        >
                          {strategy.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Version {strategy.version} · {strategy.horizon} maximum
                        hold
                      </p>
                    </div>
                    <p className="font-mono text-sm">
                      {strategy.allocated} USDT
                    </p>
                  </div>
                  <Progress
                    aria-label={`${strategy.name} capital committed or reserved`}
                    value={strategy.used}
                  />
                  <p className="text-right text-xs text-muted-foreground">
                    {strategy.used}% committed or reserved
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <AssistantPanel fixtureSnapshot={fixtureSnapshot} />

          <Card>
            <CardHeader>
              <CardTitle>Recent decisions</CardTitle>
              <CardDescription>
                Latest analysis and execution checks.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {decisions.map((decision, index) => (
                <div key={`${decision.time}-${decision.title}`}>
                  {index > 0 ? <Separator className="mb-4" /> : null}
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {decision.time}
                    </span>
                    <div className="min-w-0">
                      <Badge variant={decision.tone}>{decision.title}</Badge>
                      <p className="mt-2 text-sm leading-5 text-muted-foreground">
                        {decision.detail}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function MetricCard({
  label,
  value,
  suffix,
  icon: Icon,
  positive = false,
}: {
  label: string;
  value: string;
  suffix: string;
  icon: typeof Bot;
  positive?: boolean;
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
        <div className="mt-4 flex items-baseline gap-2">
          <p
            className={`font-mono text-2xl font-semibold tracking-tight ${positive ? "text-emerald-400" : ""}`}
          >
            {value}
          </p>
          <span className="text-xs text-muted-foreground">{suffix}</span>
        </div>
      </CardContent>
    </Card>
  );
}
