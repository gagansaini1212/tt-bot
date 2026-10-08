import { route, type Route } from "../http";
import { depth, klines, tickers } from "./market";
import { orders } from "./orders";
import { createSnapshotCache, snapshot } from "./snapshot";

/**
 * The worker's HTTP endpoints. To add one, write a handler module and list it
 * here. Each call creates fresh caches; `now` is their clock.
 */
export function createRoutes(
  now: () => number = Date.now,
  env: NodeJS.ProcessEnv = process.env,
): Route[] {
  const account = createSnapshotCache(now);
  const desk = orders({ env, now, onChange: account.clear });
  return [
    route("GET", "/snapshot", snapshot(account)),
    route("GET", "/market/tickers", tickers(now)),
    route("GET", "/market/klines", klines(now)),
    route("GET", "/market/depth", depth(now)),
    route("GET", "/orders/ticket", desk.ticket),
    route("POST", "/orders", desk.place),
    route("GET", "/orders/status", desk.status),
    route("POST", "/orders/cancel", desk.cancel),
  ];
}
