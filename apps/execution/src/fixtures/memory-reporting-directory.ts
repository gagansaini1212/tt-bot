import {
  DEFAULT_REPORTING_CURRENCY,
  type ReportingCurrencyChoice,
} from "@crypto-trading/domain";
import type {
  ReportingAccount,
  ReportingDirectory,
} from "../reporting-directory";

/** A Binance Spot Testnet account that trades, as the seed makes it. */
export function testnetAccount(
  id: string,
  overrides: Partial<ReportingAccount> = {},
): ReportingAccount {
  return {
    id,
    venue: "binance-spot-testnet",
    venueName: "Binance Spot Testnet",
    label: "Binance Spot Testnet",
    accountingCurrency: "USDT",
    mode: "simulation",
    status: "connected",
    access: "trade",
    ...overrides,
  };
}

/**
 * An in-memory ReportingDirectory for tests of the worker's routes: each
 * customer's accounts, and their reporting currency, USDT until changed.
 * reporting-directory.test.ts proves the PostgreSQL one behaves the same way.
 */
export class MemoryReportingDirectory implements ReportingDirectory {
  readonly #accounts: Map<string, ReportingAccount[]>;
  readonly currencies = new Map<string, string>();
  // Every change, in order, as the audit trail would keep it.
  readonly changes: { customerId: string; reportingCurrency: string }[] = [];

  constructor(accounts: Record<string, ReportingAccount[]> = {}) {
    this.#accounts = new Map(Object.entries(accounts));
  }

  async accounts(customerId: string) {
    return [...(this.#accounts.get(customerId) ?? [])];
  }

  async reportingCurrency(customerId: string) {
    return this.currencies.get(customerId) ?? DEFAULT_REPORTING_CURRENCY;
  }

  async changeReportingCurrency(
    customerId: string,
    currency: ReportingCurrencyChoice,
  ) {
    this.currencies.set(customerId, currency);
    this.changes.push({ customerId, reportingCurrency: currency });
  }
}
