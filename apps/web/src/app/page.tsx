import { TestnetOverview } from "@/components/testnet-overview";
import { getAccountPortfolio } from "@/lib/account-portfolio";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { account, portfolio } = await getAccountPortfolio();
  return <TestnetOverview account={account} portfolio={portfolio} />;
}
