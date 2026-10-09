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
import { venueIdSchema, type Ticker } from "@crypto-trading/exchanges";
import { z } from "zod";
import { getMarketTickers } from "./market-data";
import { tickerPrices, valuePortfolio, type Portfolio } from "./portfolio";
import type { SettingsActionResult } from "./settings";
import { getStrategies } from "./strategies";
import { getTestnetAccount, type TestnetAccountState } from "./testnet-account";
import {
  callWorkerForCustomer,
  currentExchangeAccountId,
  type WorkerFailureReason,
  type WorkerState,
} from "./worker-client";

/**
 * Each venue's tickers, read once however many accounts are on it. A venue
 * the worker serves no market data for has none.
 */
function venueTickers() {
  const read = new Map<string, Promise<WorkerState<{ tickers: Ticker[] }>>>();
  return (venue: string) => {
    let tickers = read.get(venue);
    if (!tickers) {
      const known = venueIdSchema.safeParse(venue);
      tickers = known.success
        ? getMarketTickers(undefined, known.data)
        : Promise.resolve({
            status: "unavailable" as const,
            message:
              "The execution worker has no prices from this account's venue.",
          });
      read.set(venue, tickers);
    }
    return tickers;
  };
}

export type PortfolioState = WorkerState<{ portfolio: Portfolio }>;

/** One exchange account's part in the totals. */
export type AccountTotals = {
  account: PortfolioAccount;
  /** Its venue, then its label if different. */
  name: string;
  /** Whether it is the account the dashboard acts on. */
  current: boolean;
  /**
   * The account's own snapshot, as the worker read it, for an account it
   * serves. Never another account's (ADR 0009).
   */
  snapshot?: TestnetAccountState;
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
 * The current exchange account, valued in the customer's reporting
 * currency, and the totals across all of their exchange accounts: every
 * account the worker serves is read and counted. Each account is valued
 * only with its own venue's prices (ADR 0009). An account the worker does
 * not serve, or whose snapshot or prices are unavailable, such as while its
 * venue cannot serve it, is left out of the totals and named. Every ticker
 * is fetched because conversion routes need markets other than
 * `<ASSET><CURRENCY>`.
 */
export async function getAccountPortfolio(): Promise<{
  account: TestnetAccountState;
  portfolio: PortfolioState;
  overview: OverviewState;
}> {
  const now = new Date();
  const [customer, currentId] = await Promise.all([
    getCustomerPortfolio(),
    currentExchangeAccountId(),
  ]);
  const currency =
    customer.status === "connected"
      ? customer.portfolio.reportingCurrency
      : DEFAULT_REPORTING_CURRENCY;
  const tickers = venueTickers();
  const snapshots = new Map<string, Promise<TestnetAccountState>>();
  const snapshot = (exchangeAccountId?: string) => {
    const key = exchangeAccountId ?? "";
    let read = snapshots.get(key);
    if (!read) {
      read = getTestnetAccount(exchangeAccountId);
      snapshots.set(key, read);
    }
    return read;
  };
  const value = async (
    state: TestnetAccountState,
    venue: string,
  ): Promise<PortfolioState> => {
    if (state.status !== "connected") return state;
    const prices = await tickers(venue);
    if (prices.status !== "connected")
      return { status: prices.status, message: prices.message };
    return {
      status: "connected",
      portfolio: valuePortfolio(
        state.snapshot.balances,
        currency,
        tickerPrices(venue, prices.tickers),
        now,
      ),
    };
  };
  const account = await snapshot(currentId);
  const portfolio = await value(
    account,
    account.status === "connected" ? account.snapshot.venue : "",
  );
  if (customer.status !== "connected")
    return {
      account,
      portfolio,
      overview: { status: customer.status, message: customer.message },
    };
  const accounts = await Promise.all(
    customer.portfolio.accounts.map(async (summary): Promise<AccountTotals> => {
      const name = exchangeAccountName(summary);
      if (!summary.served)
        return {
          account: summary,
          name,
          current: summary.id === currentId,
          status: "unavailable",
          reason: "The execution worker does not read this account.",
        };
      const own =
        summary.id === currentId ? account : await snapshot(summary.id);
      const valued =
        summary.id === currentId ? portfolio : await value(own, summary.venue);
      return valued.status === "connected"
        ? {
            account: summary,
            name,
            current: summary.id === currentId,
            snapshot: own,
            status: "valued",
            portfolio: valued.portfolio,
          }
        : {
            account: summary,
            name,
            current: summary.id === currentId,
            snapshot: own,
            status: "unavailable",
            reason: valued.message,
          };
    }),
  );
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
 * strategies (ADR 0009). `today` is the result on the current exchange
 * account, from its Strategies state, or null if it cannot be measured; each
 * other account the worker serves is read the same way.
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
  const [measured, currentId] = await Promise.all([
    today,
    currentExchangeAccountId(),
  ]);
  const tickers = venueTickers();
  const days = await Promise.all(
    trading.map(async (account): Promise<AccountDay> => {
      const prices = converts ? await tickers(account.venue) : undefined;
      const day = {
        exchangeAccountId: account.id,
        label: exchangeAccountName(account),
        accountingCurrency: account.accountingCurrency,
        prices:
          prices?.status === "connected"
            ? tickerPrices(account.venue, prices.tickers)
            : () => undefined,
      };
      if (!account.served)
        return {
          ...day,
          unmeasured:
            "The execution worker does not run this account's strategies.",
        };
      const result =
        account.id === currentId
          ? measured
          : await getStrategies(account.id).then((read) =>
              read.status === "connected" ? read.state.today : null,
            );
      return result
        ? { ...day, today: result }
        : {
            ...day,
            unmeasured: "The worker cannot measure every strategy on it now.",
          };
    }),
  );
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
