import "server-only";
import { getMarketTickers } from "./market-data";
import { valuePortfolio, type Portfolio } from "./portfolio";
import { getTestnetAccount, type TestnetAccountState } from "./testnet-account";
import type { WorkerState } from "./worker-client";

export type PortfolioState = WorkerState<{ portfolio: Portfolio }>;

/**
 * The testnet account and its balances valued in USDT. Every ticker is
 * fetched because inverse and bridge prices need markets other than
 * `<ASSET>USDT`.
 */
export async function getAccountPortfolio(): Promise<{
  account: TestnetAccountState;
  portfolio: PortfolioState;
}> {
  const [account, prices] = await Promise.all([
    getTestnetAccount(),
    getMarketTickers(),
  ]);
  if (account.status !== "connected") return { account, portfolio: account };
  if (prices.status !== "connected")
    return {
      account,
      portfolio: { status: prices.status, message: prices.message },
    };
  return {
    account,
    portfolio: {
      status: "connected",
      portfolio: valuePortfolio(account.snapshot.balances, prices.tickers),
    },
  };
}
