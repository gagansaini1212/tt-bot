/**
 * Serves each key's value for `ttlMs` after it loads. Concurrent requests for a
 * key share one load, so a burst of requests makes a single exchange call.
 * Failed loads are not cached.
 */
export function createCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { value: T; loadedAt: number }>();
  const pending = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const entry = entries.get(key);
    const age = entry ? now() - entry.loadedAt : Infinity;
    // A negative age means the clock stepped back since the load.
    if (entry && age >= 0 && age <= ttlMs) return Promise.resolve(entry.value);
    let request = pending.get(key);
    if (!request) {
      // Starts after `pending.set`, so even a synchronous throw clears it.
      request = Promise.resolve()
        .then(load)
        .then((value) => {
          entries.set(key, { value, loadedAt: now() });
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return request;
  };
}
