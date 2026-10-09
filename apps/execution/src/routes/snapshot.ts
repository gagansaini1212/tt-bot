import type { Instrument } from "@crypto-trading/domain";
import type { AccountSnapshot } from "@crypto-trading/exchanges";
import type { AccountScope } from "../accounts";
import { z } from "zod";
import { createCache } from "../cache";
import { handler } from "../http";

export function createSnapshotCache(now: () => number) {
  return createCache<AccountSnapshot>(10_000, now);
}

/**
 * The account's balances, open orders and recent fills, served only to the
 * customer who owns it, with its orders and fills on the instruments the
 * account allows. Cached per account for up to 10 seconds; order routes and
 * key changes clear the cache, so they show on the next read.
 */
export function snapshot(
  cache: ReturnType<typeof createSnapshotCache>,
  instruments: (scope: AccountScope) => Promise<Instrument[]>,
) {
  return handler({
    query: z.strictObject({}),
    handle: async ({ exchange, account }) => ({
      status: "connected",
      snapshot: await cache(account.exchangeAccountId, async () =>
        exchange.getSnapshot(await instruments(account)),
      ),
    }),
  });
}
