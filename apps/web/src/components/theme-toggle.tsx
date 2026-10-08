"use client";

import { useId, useLayoutEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  applyStoredTheme,
  defaultThemePreference,
  parseThemePreference,
  themeStorageKey,
  type ThemePreference,
} from "@/lib/theme";

const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] satisfies { value: ThemePreference; label: string; icon: typeof Sun }[];

const listeners = new Set<() => void>();

function applyTheme() {
  applyStoredTheme(themeStorageKey, defaultThemePreference);
}

function subscribe(listener: () => void) {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (event: StorageEvent) => {
    if (event.key !== themeStorageKey) return;
    applyTheme();
    listener();
  };
  listeners.add(listener);
  systemTheme.addEventListener("change", applyTheme);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    systemTheme.removeEventListener("change", applyTheme);
    window.removeEventListener("storage", onStorage);
  };
}

function getPreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(themeStorageKey));
  } catch {
    return defaultThemePreference;
  }
}

function setPreference(preference: ThemePreference) {
  try {
    localStorage.setItem(themeStorageKey, preference);
  } catch {
    // Without storage the choice cannot persist, so the theme stays as is.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

export function ThemeToggle() {
  const labelId = useId();
  const preference = useSyncExternalStore(
    subscribe,
    getPreference,
    () => defaultThemePreference,
  );

  // React's development remount resets <html> attributes, dropping the class
  // the inline script set. This is a no-op in production.
  useLayoutEffect(applyTheme, []);

  return (
    <div className="flex items-center justify-between gap-2 pl-2.5">
      <span className="text-sm font-medium" id={labelId}>
        Theme
      </span>
      <div
        aria-labelledby={labelId}
        className="flex gap-0.5 rounded-lg border border-border bg-background/40 p-0.5"
        role="group"
      >
        {options.map(({ value, label, icon: Icon }) => (
          <Button
            aria-label={label}
            aria-pressed={preference === value}
            className={
              preference === value ? undefined : "text-muted-foreground"
            }
            key={value}
            onClick={() => setPreference(value)}
            size="icon-sm"
            title={label}
            variant={preference === value ? "secondary" : "ghost"}
          >
            <Icon />
          </Button>
        ))}
      </div>
    </div>
  );
}
