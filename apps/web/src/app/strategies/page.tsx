import type { Metadata } from "next";
import { Activity, Clock3, ShieldCheck } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { strategies } from "@/lib/dashboard-fixtures";

export const metadata: Metadata = {
  title: "Strategies · Northstar Trading",
};

export default function StrategiesPage() {
  return (
    <>
      <PageHeader
        action={<Badge variant="outline">2 configured</Badge>}
        description="Versioned strategy budgets and controls. Each strategy is isolated from every other allocation."
        eyebrow="Execution policy"
        title="Strategies"
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {strategies.map((strategy) => (
          <Card key={strategy.name}>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>{strategy.name}</CardTitle>
                  <CardDescription>
                    Active version {strategy.version}
                  </CardDescription>
                </div>
                <Badge
                  variant={
                    strategy.status === "Paused" ? "outline" : "secondary"
                  }
                >
                  {strategy.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Capital committed
                  </span>
                  <span className="font-mono">{strategy.used}%</span>
                </div>
                <Progress
                  aria-label={`${strategy.name} capital committed or reserved`}
                  value={strategy.used}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <PolicyValue
                  icon={Activity}
                  label="Allocation"
                  value={`${strategy.allocated} USDT`}
                />
                <PolicyValue
                  icon={Clock3}
                  label="Maximum hold"
                  value={strategy.horizon}
                />
                <PolicyValue
                  icon={ShieldCheck}
                  label="Execution"
                  value="Checks required"
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Hard execution boundary</CardTitle>
          <CardDescription>
            Strategy prompts can draft proposals. The execution worker still
            verifies allocation, leverage, protection, expiry, and the live-mode
            lock independently.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}

function PolicyValue({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/35 p-3">
      <Icon className="size-4 text-muted-foreground" />
      <p className="mt-3 text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}
