import { TestnetOverview } from "@/components/testnet-overview";
import { getTestnetAccount } from "@/lib/testnet-account";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const account = await getTestnetAccount();
  return <TestnetOverview account={account} />;
}
