import { route, type Route } from "../http";
import type { OrderIntentStore } from "../order-intents";
import type { RiskLimitStore } from "../risk-limits";
import { execution, type ExecutionReader } from "./execution";
import { depth, klines, tickers } from "./market";
import { deskProvider, orders } from "./orders";
import { settings, type SettingsDependencies } from "./settings";
import { createSnapshotCache, snapshot } from "./snapshot";

/**
 * The worker's HTTP endpoints and the dashboard order desks they share with
 * the execution loop. To add an endpoint, write a handler module and list it
 * here: `handler` for a customer's exchange account, `accountHandler` or
 * `customerHandler` for their data without Binance, and `publicHandler` for
 * market data. Each call creates fresh caches; `now` is their clock. Without
 * `settings`, the Settings routes are left out.
 */
export function createWorker({
  intents,
  risk,
  reader,
  settings: settingsDependencies,
  now = Date.now,
  env = process.env,
}: {
  intents: OrderIntentStore;
  risk: Pick<RiskLimitStore, "current" | "dailyRiskUsed">;
  reader?: ExecutionReader;
  settings?: SettingsDependencies;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}) {
  const account = createSnapshotCache(now);
  const desks = deskProvider({
    env,
    now,
    onChange: account.clear,
    intents,
    risk,
  });
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
  if (settingsDependencies) {
    // The snapshot was read with the old keys.
    const settingsRoutes = settings(settingsDependencies, account.clear);
    routes.push(
      route("GET", "/settings/exchange-keys", settingsRoutes.keys),
      route("POST", "/settings/exchange-keys", settingsRoutes.saveKeys),
      route("DELETE", "/settings/exchange-keys", settingsRoutes.removeKeys),
      route("POST", "/settings/exchange-keys/test", settingsRoutes.testKeys),
      route("GET", "/settings/risk-limits", settingsRoutes.riskLimits),
      route("POST", "/settings/risk-limits", settingsRoutes.changeRiskLimits),
      route("GET", "/settings/webhook", settingsRoutes.webhook),
      route("POST", "/settings/webhook", settingsRoutes.saveWebhook),
      route("DELETE", "/settings/webhook", settingsRoutes.removeWebhook),
      route("POST", "/settings/webhook/test", settingsRoutes.testWebhook),
      route("GET", "/notifications", settingsRoutes.notifications),
      route(
        "POST",
        "/notifications/read",
        settingsRoutes.markNotificationsRead,
      ),
    );
  }
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
