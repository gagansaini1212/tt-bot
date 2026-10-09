/** The Settings page's tabs, in order, as they appear in `?tab=`. */
export const SETTINGS_TABS = ["accounts", "risk", "notifications"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function settingsTab(value: unknown): SettingsTab {
  // Exchange accounts were "keys" while there was one account.
  return SETTINGS_TABS.find((tab) => tab === value) ?? "accounts";
}
