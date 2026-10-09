import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import { ExchangeAccountsPanel } from "@/components/settings/exchange-accounts-panel";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { PortfolioLimitsPanel } from "@/components/settings/portfolio-limits-panel";
import { RiskLimitsPanel } from "@/components/settings/risk-limits-panel";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import {
  getExchangeAccounts,
  getNotifications,
  getRiskLimits,
  getWebhook,
} from "@/lib/settings";
import { settingsTab } from "@/lib/settings-tabs";
import { getPortfolioLimits } from "@/lib/strategies";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: PageProps<"/settings">) {
  const initial = settingsTab((await searchParams).tab);
  const [accounts, limits, portfolio, webhook, notifications] =
    await Promise.all([
      getExchangeAccounts(),
      getRiskLimits(),
      getPortfolioLimits(),
      getWebhook(),
      getNotifications(),
    ]);
  const unread =
    notifications.status === "connected"
      ? notifications.notifications.filter((entry) => !entry.readAt).length
      : 0;
  return (
    <>
      <PageHeader
        action={<AccountRefresh />}
        description="Your exchange accounts and their keys, the limits on orders you place by hand and on your strategies together, and where alerts go. Testnet only: live trading is turned off."
        title="Settings"
      />
      <SettingsTabs
        initial={initial}
        panels={{
          accounts: <ExchangeAccountsPanel state={accounts} />,
          risk: (
            <>
              <RiskLimitsPanel state={limits} />
              <PortfolioLimitsPanel state={portfolio} />
            </>
          ),
          notifications: (
            <NotificationsPanel
              notifications={notifications}
              webhook={webhook}
            />
          ),
        }}
        unread={unread}
      />
    </>
  );
}
