import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import { StrategiesView } from "@/components/strategies/strategies-view";
import { getStrategies } from "@/lib/strategies";

export const metadata: Metadata = { title: "Strategies" };
export const dynamic = "force-dynamic";

export default async function StrategiesPage() {
  const state = await getStrategies();
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Grid, DCA, AI-managed and standing price instruction strategies on Binance Spot Testnet, each with its own allocation and loss limits. The execution worker runs them and checks every entry before it is sent. Virtual funds; live trading is turned off."
        title="Strategies"
      />
      <StrategiesView state={state} />
    </>
  );
}
