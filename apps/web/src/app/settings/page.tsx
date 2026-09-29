import type { Metadata } from "next";
import { Bot, Database, LockKeyhole, Radio } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Settings · Northstar Trading",
};

const settings = [
  {
    icon: LockKeyhole,
    title: "Trading mode",
    description:
      "Simulation only. The worker refuses startup if live mode is enabled.",
    value: "Locked",
  },
  {
    icon: Bot,
    title: "Analysis model",
    description:
      "Eve drafts explanations and proposals from fixture-backed context.",
    value: "Connected",
  },
  {
    icon: Database,
    title: "Data source",
    description:
      "Deterministic local fixtures backed by the PostgreSQL schema.",
    value: "Local",
  },
  {
    icon: Radio,
    title: "Exchange adapter",
    description: "Mock exchange connection for repeatable simulation runs.",
    value: "Online",
  },
];

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        action={<Badge variant="secondary">Read-only fixture</Badge>}
        description="Current local environment and safety configuration. Editable controls will be added with persistence and audit logging."
        eyebrow="Workspace configuration"
        title="Settings"
      />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {settings.map(({ icon: Icon, title, description, value }) => (
          <Card key={title}>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
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
