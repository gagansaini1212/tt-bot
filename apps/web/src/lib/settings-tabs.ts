/** The Settings page's tabs, in order, as they appear in `?tab=`. */
export const SETTINGS_TABS = ["keys", "risk", "notifications"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function settingsTab(value: unknown): SettingsTab {
  return SETTINGS_TABS.find((tab) => tab === value) ?? "keys";
}
