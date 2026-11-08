import type { Metadata } from "next";

import {
  defaultAccount,
  type ServedAccount,
} from "@crypto-trading/exchanges/served-accounts";
import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import { DrawdownAcrossAccounts } from "@/components/strategies/drawdown-across-accounts";
import { StrategiesView } from "@/components/strategies/strategies-view";
import { getDrawdownAcrossAccounts } from "@/lib/account-portfolio";
import { getStrategies } from "@/lib/strategies";
import { getServedAccounts } from "@/lib/worker-client";

export const metadata: Metadata = { title: "Strategies" };
export const dynamic = "force-dynamic";

export default async function StrategiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ account?: string }>;
}) {
  const params = await searchParams;
  const accountsResult = await getServedAccounts();
  const accounts: ServedAccount[] =
    accountsResult.status === "connected" ? accountsResult.data.accounts : [];

  const activeAccount =
    (params?.account
      ? accounts.find((acc) => acc.id === params.account)
      : undefined) ?? defaultAccount(accounts);

  const activeAccountId = activeAccount?.id;
  const strategies = getStrategies(activeAccountId);
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
        description="Grid, DCA, AI-managed and standing price instruction strategies across your exchange accounts (Binance Spot Testnet, Binance Spot Live, and HTX Spot), each with its own allocation and loss limits. The execution worker runs them and checks every entry before it is sent."
        title="Strategies"
      />
      <StrategiesView
        accounts={accounts}
        activeAccount={activeAccount}
        acrossAccounts={
          across ? <DrawdownAcrossAccounts state={across} /> : undefined
        }
        state={state}
      />
    </>
  );
}
