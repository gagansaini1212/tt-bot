import type { Metadata } from "next";

import { AccountRefresh } from "@/components/account-refresh";
import { PageHeader } from "@/components/page-header";
import { ExchangeKeysPanel } from "@/components/settings/exchange-keys-panel";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { RiskLimitsPanel } from "@/components/settings/risk-limits-panel";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import {
  getExchangeKeys,
  getNotifications,
  getRiskLimits,
  getWebhook,
} from "@/lib/settings";
import { settingsTab } from "@/lib/settings-tabs";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: PageProps<"/settings">) {
  const initial = settingsTab((await searchParams).tab);
  const [keys, limits, webhook, notifications] = await Promise.all([
    getExchangeKeys(),
    getRiskLimits(),
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
        description="Your Binance Spot Testnet keys, the limits on orders you place by hand, and where alerts go. Testnet only: live trading is turned off."
        title="Settings"
      />
      <SettingsTabs
        initial={initial}
        panels={{
          keys: <ExchangeKeysPanel state={keys} />,
          risk: <RiskLimitsPanel state={limits} />,
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
