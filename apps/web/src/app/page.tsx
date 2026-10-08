import { TestnetOverview } from "@/components/testnet-overview";
import { getAccountPortfolio } from "@/lib/account-portfolio";
import { getExecutionState } from "@/lib/execution";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [{ account, portfolio }, execution] = await Promise.all([
    getAccountPortfolio(),
    getExecutionState(),
  ]);
  return (
    <TestnetOverview
      account={account}
      execution={execution}
      portfolio={portfolio}
    />
  );
}
