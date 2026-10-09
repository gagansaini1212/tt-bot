import "server-only";
import {
  combineAccounts,
  DEFAULT_REPORTING_CURRENCY,
  drawdownAcrossAccounts,
  type AccountDay,
  type AccountFigures,
  type CombinedDrawdown,
  type CombinedValuation,
} from "@crypto-trading/domain";
import {
  customerPortfolioSchema,
  exchangeAccountName,
  reportingCurrencyChangeSchema,
  type CustomerPortfolio,
  type PortfolioAccount,
  type ReportingCurrencyChangeRequest,
} from "@crypto-trading/exchanges/portfolio";
import { z } from "zod";
import { getMarketTickers } from "./market-data";
import { tickerPrices, valuePortfolio, type Portfolio } from "./portfolio";
import type { SettingsActionResult } from "./settings";
import { getTestnetAccount, type TestnetAccountState } from "./testnet-account";
import {
  callWorkerForCustomer,
  type WorkerFailureReason,
  type WorkerState,
} from "./worker-client";

/** The venue whose prices the worker's market routes serve. */
const MARKET_VENUE = "binance-spot-testnet";

export type PortfolioState = WorkerState<{ portfolio: Portfolio }>;

/** One exchange account's part in the totals. */
export type AccountTotals = {
  account: PortfolioAccount;
  /** Its venue, then its label if different. */
  name: string;
} & (
  | { status: "valued"; portfolio: Portfolio }
  | { status: "unavailable"; reason: string }
);

/** Net worth across every exchange account, in the reporting currency. */
export type PortfolioOverview = Pick<
  CustomerPortfolio,
  "reportingCurrency" | "options"
> & {
  accounts: AccountTotals[];
  combined: CombinedValuation;
};

export type OverviewState = WorkerState<{ overview: PortfolioOverview }>;

/** The customer's exchange accounts and reporting currency, from the worker. */
async function getCustomerPortfolio(): Promise<
  WorkerState<{ portfolio: CustomerPortfolio }>
> {
  const result = await callWorkerForCustomer({
    path: "/portfolio",
    schema: z.object({ portfolio: customerPortfolioSchema }),
  });
  return result.status === "connected"
    ? { status: "connected", portfolio: result.data.portfolio }
    : { status: result.status, message: result.message };
}

/**
 * The account the worker reads, valued in the customer's reporting
 * currency, and the totals across all of their exchange accounts. Each
 * account is valued only with its own venue's prices (ADR 0009). An account
 * the worker does not read yet, or whose snapshot or prices are unavailable,
 * is left out of the totals and named. Every ticker is fetched because
 * conversion routes need markets other than `<ASSET><CURRENCY>`.
 */
export async function getAccountPortfolio(): Promise<{
  account: TestnetAccountState;
  portfolio: PortfolioState;
  overview: OverviewState;
}> {
  const now = new Date();
  const [account, prices, customer] = await Promise.all([
    getTestnetAccount(),
    getMarketTickers(),
    getCustomerPortfolio(),
  ]);
  const currency =
    customer.status === "connected"
      ? customer.portfolio.reportingCurrency
      : DEFAULT_REPORTING_CURRENCY;
  const value = (venue: string): PortfolioState => {
    if (account.status !== "connected") return account;
    if (venue !== MARKET_VENUE || prices.status !== "connected")
      return {
        status: "unavailable",
        message:
          prices.status === "connected"
            ? "The execution worker has no prices from this account's venue."
            : prices.message,
      };
    return {
      status: "connected",
      portfolio: valuePortfolio(
        account.snapshot.balances,
        currency,
        tickerPrices(venue, prices.tickers),
        now,
      ),
    };
  };
  if (customer.status !== "connected")
    return {
      account,
      portfolio: value(
        account.status === "connected" ? account.snapshot.venue : "",
      ),
      overview: { status: customer.status, message: customer.message },
    };
  const served = customer.portfolio.accounts.find((entry) => entry.served);
  const portfolio: PortfolioState = served
    ? value(served.venue)
    : {
        status: "not_configured",
        message: "The execution worker reads none of your exchange accounts.",
      };
  const accounts = customer.portfolio.accounts.map((summary): AccountTotals => {
    const name = exchangeAccountName(summary);
    if (!summary.served)
      return {
        account: summary,
        name,
        status: "unavailable",
        reason: "The execution worker does not read this account yet.",
      };
    return portfolio.status === "connected"
      ? {
          account: summary,
          name,
          status: "valued",
          portfolio: portfolio.portfolio,
        }
      : {
          account: summary,
          name,
          status: "unavailable",
          reason: portfolio.message,
        };
  });
  return {
    account,
    portfolio,
    overview: {
      status: "connected",
      overview: {
        reportingCurrency: currency,
        options: customer.portfolio.options,
        accounts,
        combined: combineAccounts(
          currency,
          accounts.map((entry): AccountFigures =>
            entry.status === "valued"
              ? {
                  exchangeAccountId: entry.account.id,
                  label: entry.name,
                  status: "valued",
                  valuation: entry.portfolio.valuation,
                }
              : {
                  exchangeAccountId: entry.account.id,
                  label: entry.name,
                  status: "unavailable",
                  reason: entry.reason,
                },
          ),
        ),
      },
    },
  };
}

/**
 * The customer's strategies on every exchange account that trades, since
 * midnight UTC, in the reporting currency: shown only. Each account's own
 * daily drawdown limit, in its accounting currency, is what pauses its
 * strategies (ADR 0009). `today` is the result on the account the worker
 * runs, from its Strategies state, or null if it cannot be measured.
 * Undefined when it would only repeat that account's own figure: one
 * trading account, in the reporting currency already.
 */
export async function getDrawdownAcrossAccounts(
  today: Promise<{ pnl: string; allocation: string } | null>,
): Promise<
  WorkerState<{ drawdown: CombinedDrawdown; accounts: number }> | undefined
> {
  const customer = await getCustomerPortfolio();
  if (customer.status !== "connected") {
    await today;
    return { status: customer.status, message: customer.message };
  }
  const { reportingCurrency, accounts } = customer.portfolio;
  // A read-only account runs no strategies, so it has nothing to count.
  const trading = accounts.filter((account) => account.access === "trade");
  if (
    trading.length <= 1 &&
    trading.every((account) => account.accountingCurrency === reportingCurrency)
  ) {
    await today;
    return undefined;
  }
  const converts = trading.some(
    (account) => account.accountingCurrency !== reportingCurrency,
  );
  const [measured, tickers] = await Promise.all([
    today,
    converts ? getMarketTickers() : undefined,
  ]);
  const days = trading.map((account): AccountDay => {
    const day = {
      exchangeAccountId: account.id,
      label: exchangeAccountName(account),
      accountingCurrency: account.accountingCurrency,
      prices:
        account.venue === MARKET_VENUE && tickers?.status === "connected"
          ? tickerPrices(account.venue, tickers.tickers)
          : () => undefined,
    };
    if (!account.served)
      return {
        ...day,
        unmeasured:
          "The execution worker does not run this account's strategies yet.",
      };
    return measured
      ? { ...day, today: measured }
      : {
          ...day,
          unmeasured: "The worker cannot measure every strategy on it now.",
        };
  });
  return {
    status: "connected",
    drawdown: drawdownAcrossAccounts(reportingCurrency, days, new Date()),
    accounts: trading.length,
  };
}

// The worker did nothing, or the request never left this server.
const NOT_SENT = new Set<WorkerFailureReason>([
  "missing_token",
  "invalid_url",
  "signed_out",
  "worker_not_configured",
  "exchange_keys_unusable",
  "no_exchange_account",
  "database_unavailable",
  "invalid_request",
]);

/** Asks the worker to change the customer's reporting currency. */
export async function saveReportingCurrency(
  request: ReportingCurrencyChangeRequest,
): Promise<SettingsActionResult> {
  const result = await callWorkerForCustomer({
    method: "POST",
    path: "/settings/reporting-currency",
    body: request,
    schema: z.object({ change: reportingCurrencyChangeSchema }),
  });
  if (result.status === "connected")
    return {
      result: result.data.change.result === "saved" ? "saved" : "refused",
      message: result.data.change.message,
    };
  return NOT_SENT.has(result.reason)
    ? { result: "unavailable", message: result.message }
    : {
        result: "unconfirmed",
        message: `${result.message} The change may or may not have been made: check the total after the page refreshes.`,
      };
}
