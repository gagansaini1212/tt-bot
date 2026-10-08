/**
 * An on/off preference kept in browser storage, shaped for
 * useSyncExternalStore. When storage is unavailable or refuses a write, the
 * choice still applies for the rest of the page's life.
 */
export function createStoredFlag(
  key: string,
  fallback: boolean,
  storage: () => Storage,
) {
  const listeners = new Set<() => void>();
  // The latest choice made here, which wins over storage until another tab
  // changes the stored value.
  let choice: boolean | undefined;

  function get() {
    if (choice !== undefined) return choice;
    try {
      const stored = storage().getItem(key);
      if (stored === "true" || stored === "false") return stored === "true";
    } catch {
      // Storage can be unavailable (privacy settings); use the fallback.
    }
    return fallback;
  }

  function set(value: boolean) {
    choice = value;
    try {
      storage().setItem(key, String(value));
    } catch {
      // Without storage the choice lasts until the page is reloaded.
    }
    listeners.forEach((listener) => listener());
  }

  function subscribe(listener: () => void) {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      choice = undefined;
      listener();
    };
    listeners.add(listener);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  return { get, set, subscribe, fallback };
}
