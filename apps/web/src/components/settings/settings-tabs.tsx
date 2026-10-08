"use client";

import type { ReactNode } from "react";
import { Bell, KeyRound, ShieldAlert } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SETTINGS_TABS, type SettingsTab } from "@/lib/settings-tabs";

const LABELS: Record<SettingsTab, { label: string; icon: typeof KeyRound }> = {
  keys: { label: "Exchange keys", icon: KeyRound },
  risk: { label: "Risk limits", icon: ShieldAlert },
  notifications: { label: "Notifications", icon: Bell },
};

/** The Settings tabs. The open tab is kept in `?tab=`, so a link or reload returns to it. */
export function SettingsTabs({
  initial,
  panels,
  unread,
}: {
  initial: SettingsTab;
  panels: Record<SettingsTab, ReactNode>;
  unread: number;
}) {
  return (
    <Tabs
      className="mt-6"
      defaultValue={initial}
      onValueChange={(tab) => {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", tab);
        window.history.replaceState(null, "", url);
      }}
    >
      <TabsList aria-label="Settings">
        {SETTINGS_TABS.map((tab) => {
          const { label, icon: Icon } = LABELS[tab];
          return (
            <TabsTrigger key={tab} value={tab}>
              <Icon className="hidden sm:block" />
              {label}
              {tab === "notifications" && unread > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-[0.7rem] leading-4 text-primary-foreground">
                  {unread}
                  <span className="sr-only"> unread</span>
                </span>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
      {SETTINGS_TABS.map((tab) => (
        <TabsContent key={tab} value={tab}>
          {panels[tab]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
