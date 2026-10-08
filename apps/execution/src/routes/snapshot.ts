import type { TestnetSnapshot } from "@crypto-trading/exchanges";
import { z } from "zod";
import { createCache } from "../cache";
import { handler } from "../http";

export function createSnapshotCache(now: () => number) {
  return createCache<TestnetSnapshot>(10_000, now);
}

/**
 * The account's balances, open orders and recent fills, served only to the
 * customer who owns it. Cached for up to 10 seconds; order routes clear the
 * cache, so a placement or cancel shows on the next read.
 */
export function snapshot(cache: ReturnType<typeof createSnapshotCache>) {
  return handler({
    query: z.strictObject({}),
    handle: async ({ exchange }) => ({
      status: "connected",
      snapshot: await cache("snapshot", () => exchange.getSnapshot()),
    }),
  });
}
