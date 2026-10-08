/**
 * Serves each key's value for `ttlMs` after it loads. Concurrent requests for a
 * key share one load, so a burst of requests makes a single exchange call.
 * Failed loads are not cached.
 */
export function createCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { value: T; loadedAt: number }>();
  const pending = new Map<string, Promise<T>>();
  // Loads started before the last clear() are served but not stored.
  let generation = 0;
  const cache = (key: string, load: () => Promise<T>): Promise<T> => {
    const entry = entries.get(key);
    const age = entry ? now() - entry.loadedAt : Infinity;
    // A negative age means the clock stepped back since the load.
    if (entry && age >= 0 && age <= ttlMs) return Promise.resolve(entry.value);
    let request = pending.get(key);
    if (!request) {
      const started = generation;
      // Starts after `pending.set`, so even a synchronous throw clears it.
      const loading: Promise<T> = Promise.resolve()
        .then(load)
        .then((value) => {
          if (started === generation)
            entries.set(key, { value, loadedAt: now() });
          return value;
        })
        .finally(() => {
          if (pending.get(key) === loading) pending.delete(key);
        });
      request = loading;
      pending.set(key, request);
    }
    return request;
  };
  /** Drops every value, so the next request loads afresh. */
  cache.clear = () => {
    generation++;
    entries.clear();
    pending.clear();
  };
  return cache;
}
