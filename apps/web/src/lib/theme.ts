export const themePreferences = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof themePreferences)[number];

export const themeStorageKey = "theme";

// The dashboard was dark-only before the toggle existed, so keep that look
// until the customer picks something else.
export const defaultThemePreference: ThemePreference = "dark";

export function parseThemePreference(value: string | null): ThemePreference {
  return (
    themePreferences.find((preference) => preference === value) ??
    defaultThemePreference
  );
}

/**
 * Sets the `dark` class on <html> from the stored preference. It is also
 * serialized into an inline <head> script that runs before first paint, so it
 * must not reference anything outside its own body.
 */
export function applyStoredTheme(storageKey: string, fallback: string) {
  let preference: string | null = null;
  try {
    preference = localStorage.getItem(storageKey);
  } catch {
    // Storage can be unavailable (privacy settings); use the fallback.
  }
  if (
    preference !== "light" &&
    preference !== "dark" &&
    preference !== "system"
  ) {
    preference = fallback;
  }
  const dark =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : preference === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

export const themeScript = `(${applyStoredTheme.toString()})(${JSON.stringify(
  themeStorageKey,
)},${JSON.stringify(defaultThemePreference)})`;
