import type { ReportingDirectory } from "../reporting-directory";
import type { ExchangeAccount } from "../accounts";
import { route, type Route } from "../http";
import type { OrderIntentStore } from "../order-intents";
import type { RiskLimitStore } from "../risk-limits";
import type { TradeProposalStore } from "../trade-proposals";
import { accounts as accountRoutes } from "./accounts";
import { decisions } from "./decisions";
import {
  exchangeAccounts as exchangeAccountRoutes,
  type ExchangeAccountDependencies,
} from "./exchange-accounts";
import { execution, type ExecutionReader } from "./execution";
import { depth, klines, tickers } from "./market";
import { deskProvider, orders } from "./orders";
import { portfolio, type PortfolioDependencies } from "./portfolio";
import { settings, type SettingsDependencies } from "./settings";
import { createSnapshotCache, snapshot } from "./snapshot";
import { strategies as strategyRoutes } from "./strategies";
import type { StrategyRunner } from "../strategy-runner";
import type { AccountQueues } from "../manual-orders";

/**
 * The worker's HTTP endpoints and the dashboard order desks they share with
 * the execution loop. To add an endpoint, write a handler module and list it
 * here: `handler` for a customer's exchange account, `accountHandler` or
 * `customerHandler` for their data without the venue, and `publicHandler`
 * for market data. Each call creates fresh caches; `now` is their clock.
 * Without `settings`, the Settings routes are left out, without
 * `exchangeAccounts`, the exchange account routes, without `proposals`, the
 * AI decision routes, without `strategies`, the strategy routes, and without
 * `listAccounts`, the list of accounts the worker serves. `directory` lists
 * the customer's exchange accounts for totals and the assistant's
 * proposals: without it, the assistant's trade proposals are refused, and
 * without `portfolio` too, the routes for totals across accounts are left
 * out. Dashboard placements and a strategy runner made with `exclusive` run
 * one at a time per account.
 */
export function createWorker({
  intents,
  proposals,
  risk,
  reader,
  settings: settingsDependencies,
  exchangeAccounts,
  strategies,
  directory,
  portfolio: portfolioDependencies,
  listAccounts,
  exclusive,
  now = Date.now,
  env = process.env,
}: {
  intents: OrderIntentStore;
  proposals?: TradeProposalStore;
  directory?: ReportingDirectory;
  portfolio?: Omit<PortfolioDependencies, "directory">;
  risk: Pick<
    RiskLimitStore,
    "current" | "dailyRiskUsed" | "allowedInstruments"
  >;
  reader?: ExecutionReader;
  settings?: SettingsDependencies;
  exchangeAccounts?: ExchangeAccountDependencies;
  strategies?: Pick<
    StrategyRunner,
    "state" | "readOnlyState" | "resumeProblem" | "store" | "approve"
  >;
  listAccounts?: (customerId: string) => Promise<ExchangeAccount[]>;
  exclusive?: AccountQueues;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}) {
  const account = createSnapshotCache(now);
  const desks = deskProvider({
    env,
    now,
    onChange: account.clear,
    intents,
    proposals,
    risk,
    exclusive,
  });
  const desk = orders(desks);
  const routes: Route[] = [
    ...(listAccounts
      ? [route("GET", "/accounts", accountRoutes(listAccounts))]
      : []),
    route(
      "GET",
      "/snapshot",
      snapshot(account, (scope) => risk.allowedInstruments(scope)),
    ),
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
  if (proposals) {
    const ai = decisions({
      proposals,
      now,
      ...desks,
      strategies,
      instruments: (scope) => risk.allowedInstruments(scope),
      directory,
    });
    routes.push(
      route("POST", "/decisions", ai.record),
      route("GET", "/decisions", ai.list),
      route("GET", "/mistakes", ai.mistakes),
      route("GET", "/proposals", ai.proposal),
      route("POST", "/proposals/approve", ai.approve),
      route("POST", "/proposals/reject", ai.reject),
    );
  }
  if (strategies) {
    const strategy = strategyRoutes(strategies);
    routes.push(
      route("GET", "/strategies", strategy.list),
      route("POST", "/strategies", strategy.create),
      route("POST", "/strategies/versions", strategy.newVersion),
      route("POST", "/strategies/pause", strategy.pause),
      route("POST", "/strategies/resume", strategy.resume),
      route("POST", "/strategies/close-all", strategy.closeAll),
      route("POST", "/strategies/kill-switch", strategy.killSwitch),
      route("GET", "/settings/portfolio-limits", strategy.portfolioLimits),
      route(
        "POST",
        "/settings/portfolio-limits",
        strategy.changePortfolioLimits,
      ),
    );
  }
  if (directory && portfolioDependencies) {
    // Totals across exchange accounts, in the reporting currency.
    const totals = portfolio({ directory, ...portfolioDependencies });
    routes.push(
      route("GET", "/portfolio", totals.read),
      route(
        "POST",
        "/settings/reporting-currency",
        totals.changeReportingCurrency,
      ),
    );
  }
  if (exchangeAccounts) {
    // The snapshot was read with the old keys.
    const accounts = exchangeAccountRoutes(exchangeAccounts, account.clear);
    routes.push(
      route("GET", "/exchange-accounts", accounts.list),
      route("POST", "/exchange-accounts", accounts.add),
      route("POST", "/exchange-accounts/label", accounts.relabel),
      route("POST", "/exchange-accounts/keys", accounts.replaceKeys),
      route("POST", "/exchange-accounts/test", accounts.test),
      route("POST", "/exchange-accounts/remove", accounts.remove),
    );
  }
  if (settingsDependencies) {
    const settingsRoutes = settings(settingsDependencies);
    routes.push(
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
