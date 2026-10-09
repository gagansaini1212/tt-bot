import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEV_CUSTOMER_ID,
  DEV_EXCHANGE_ACCOUNT_ID,
  DEV_LOGIN_EMAIL,
} from "@crypto-trading/database/dev-seed";
import type { ServedAccount } from "@crypto-trading/exchanges/served-accounts";
import type { CurrentCustomer } from "./current-customer";

export const DEV_CUSTOMER: CurrentCustomer = {
  id: DEV_CUSTOMER_ID,
  name: "Development customer",
  email: DEV_LOGIN_EMAIL,
};

/** The dev customer's testnet exchange account, as the worker lists it. */
export const DEV_ACCOUNT: ServedAccount = {
  id: DEV_EXCHANGE_ACCOUNT_ID,
  venue: "binance-spot-testnet",
  venueName: "Binance Spot Testnet",
  label: "Binance Spot Testnet",
  accountingCurrency: "USDT",
  readOnly: false,
  status: "connected",
};

/**
 * Stands in for a Better Auth session, which needs a request: modules this
 * test file imports afterwards act for `customer`, on `account`. Import them
 * dynamically, after calling this. The test script enables module mocks.
 */
export function signInForTesting(
  customer: CurrentCustomer | null = DEV_CUSTOMER,
  account: ServedAccount | undefined = DEV_ACCOUNT,
) {
  mock.module(pathToFileURL(join(__dirname, "current-customer.ts")).href, {
    exports: { getCurrentCustomer: async () => customer },
  });
  mock.module(pathToFileURL(join(__dirname, "current-account.ts")).href, {
    exports: { getCurrentExchangeAccount: async () => account },
  });
}
