import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Strategies · Northstar Trading" };

export default function StrategiesPage() {
  return (
    <>
      <PageHeader
        action={<Badge variant="outline">Not implemented</Badge>}
        description="Automated strategy configuration and management are not available yet."
        eyebrow="Execution policy"
        title="Strategies"
      />
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Manual testnet trading</CardTitle>
          <CardDescription>
            The connected account currently supports manual development orders.
            Strategy budgets, position ownership, stop-loss protection, and
            holding deadlines still need to be implemented.
          </CardDescription>
          <Link
            className={`${buttonVariants({ variant: "outline" })} mt-4 w-fit`}
            href="/accounts"
          >
            View exchange account
          </Link>
        </CardHeader>
      </Card>
    </>
  );
}
