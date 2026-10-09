import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import { DrawdownAcrossAccounts } from "@/components/strategies/drawdown-across-accounts";
import { StrategiesView } from "@/components/strategies/strategies-view";
import { getDrawdownAcrossAccounts } from "@/lib/account-portfolio";
import { getStrategies } from "@/lib/strategies";

export const metadata: Metadata = { title: "Strategies" };
export const dynamic = "force-dynamic";

export default async function StrategiesPage() {
  const strategies = getStrategies();
  const [state, across] = await Promise.all([
    strategies,
    getDrawdownAcrossAccounts(
      strategies.then((read) =>
        read.status === "connected" ? read.state.today : null,
      ),
    ),
  ]);
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Grid, DCA, AI-managed and standing price instruction strategies on Binance Spot Testnet, each with its own allocation and loss limits. The execution worker runs them and checks every entry before it is sent. Virtual funds; live trading is turned off."
        title="Strategies"
      />
      <StrategiesView
        acrossAccounts={
          across ? <DrawdownAcrossAccounts state={across} /> : undefined
        }
        state={state}
      />
    </>
  );
}
