import { route, type Route } from "../http";
import type { OrderIntentStore } from "../order-intents";
import { execution, type ExecutionReader } from "./execution";
import { depth, klines, tickers } from "./market";
import { deskProvider, orders } from "./orders";
import { createSnapshotCache, snapshot } from "./snapshot";

/**
 * The worker's HTTP endpoints and the dashboard order desk they share with
 * the execution loop. To add an endpoint, write a handler module and list it
 * here: `handler` for a customer's data, `publicHandler` for market data.
 * Each call creates fresh caches; `now` is their clock.
 */
export function createWorker({
  intents,
  reader,
  now = Date.now,
  env = process.env,
}: {
  intents: OrderIntentStore;
  reader?: ExecutionReader;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}) {
  const account = createSnapshotCache(now);
  const desks = deskProvider({ env, now, onChange: account.clear, intents });
  const desk = orders(desks);
  const routes: Route[] = [
    route("GET", "/snapshot", snapshot(account)),
    route("GET", "/execution", execution(reader)),
    route("GET", "/market/tickers", tickers(now)),
    route("GET", "/market/klines", klines(now)),
    route("GET", "/market/depth", depth(now)),
    route("GET", "/orders/ticket", desk.ticket),
    route("POST", "/orders", desk.place),
    route("GET", "/orders/status", desk.status),
    route("POST", "/orders/cancel", desk.cancel),
    route("POST", "/orders/triggers/cancel", desk.cancelTrigger),
  ];
  return {
    routes,
    deskFor: desks.deskFor,
    // Called after the loop changes the account, so the next read is fresh.
    accountChanged: account.clear,
  };
}

/** The worker's HTTP endpoints. */
export function createRoutes(options: Parameters<typeof createWorker>[0]) {
  return createWorker(options).routes;
}
