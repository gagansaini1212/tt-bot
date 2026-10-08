import type { TestnetSnapshot } from "@crypto-trading/exchanges";
import { z } from "zod";
import { createCache } from "../cache";
import { handler } from "../http";

/** Balances, open orders and recent fills, cached for up to 10 seconds. */
export function snapshot(now: () => number) {
  const cache = createCache<TestnetSnapshot>(10_000, now);
  return handler({
    query: z.strictObject({}),
    handle: async ({ exchange }) => ({
      status: "connected",
      snapshot: await cache("snapshot", () => exchange.getSnapshot()),
    }),
  });
}
