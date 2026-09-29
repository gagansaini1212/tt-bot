import type { Metadata } from "next";
import { Database, FileCheck2 } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { decisions } from "@/lib/dashboard-fixtures";

export const metadata: Metadata = {
  title: "Decisions · Northstar Trading",
};

export default function DecisionsPage() {
  return (
    <>
      <PageHeader
        action={<Badge variant="outline">Fixture audit trail</Badge>}
        description="Analysis outcomes and independent execution checks in newest-first order."
        eyebrow="Audit history"
        title="Decisions"
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
        <Card>
          <CardHeader>
            <CardTitle>Latest activity</CardTitle>
            <CardDescription>
              Captured at 2026-09-29 10:36:18 UTC
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {decisions.map((decision, index) => (
              <div key={`${decision.time}-${decision.title}`}>
                {index > 0 ? <Separator className="mb-5" /> : null}
                <div className="flex gap-4">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                    <Database className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant={decision.tone}>{decision.title}</Badge>
                      <time className="font-mono text-xs text-muted-foreground">
                        {decision.time}
                      </time>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      {decision.detail}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <FileCheck2 className="size-4" />
            </div>
            <CardTitle className="mt-3">Audit guarantees</CardTitle>
            <CardDescription>
              Every proposal, rejection, order transition, fill, and protection
              check is designed to retain its tenant, account, and
              strategy-version ownership.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </>
  );
}
