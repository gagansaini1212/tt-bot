import { reportingCurrencyOptions } from "@crypto-trading/domain";
import {
  exchangeAccountName,
  reportingCurrencyChangeRequestSchema,
  type CustomerPortfolio,
  type ReportingCurrencyChange,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountResolver } from "../accounts";
import type {
  ReportingAccount,
  ReportingDirectory,
  VenueMarkets,
} from "../reporting-directory";
import { customerHandler } from "../http";

export type PortfolioDependencies = {
  directory: ReportingDirectory;
  // The markets each venue lists, to tell which reporting currencies every
  // account can convert into.
  markets: VenueMarkets;
  // The account this worker reads for a customer: its snapshot is the one
  // /snapshot serves. Other accounts are listed, but not read yet.
  served: AccountResolver;
};

/**
 * Totals across a customer's exchange accounts (ADR 0009): their accounts,
 * which of them this worker reads, and the reporting currency the dashboard
 * adds them up in. Nothing here reads balances, keys or prices, so it needs
 * no exchange keys; the dashboard values each account from its snapshot.
 */
export function portfolio({
  directory,
  markets,
  served,
}: PortfolioDependencies) {
  const options = async (accounts: ReportingAccount[]) =>
    reportingCurrencyOptions(
      await Promise.all(
        accounts.map(async (account) => ({
          label: exchangeAccountName(account),
          accountingCurrency: account.accountingCurrency,
          lists: await markets(account.venue),
        })),
      ),
    );
  const read = async (customerId: string): Promise<CustomerPortfolio> => {
    const [accounts, reportingCurrency, scope] = await Promise.all([
      directory.accounts(customerId),
      directory.reportingCurrency(customerId),
      served(customerId),
    ]);
    return {
      reportingCurrency,
      options: await options(accounts),
      accounts: accounts.map((account) => ({
        ...account,
        served: account.id === scope?.exchangeAccountId,
      })),
    };
  };
  return {
    read: customerHandler({
      query: z.strictObject({}),
      handle: async ({ customerId }) => ({
        status: "connected",
        portfolio: await read(customerId),
      }),
    }),
    /**
     * Changes the reporting currency, if every one of the customer's
     * accounts has a conversion route to it on its own venue. It changes
     * only what the dashboard shows.
     */
    changeReportingCurrency: customerHandler({
      query: z.strictObject({}),
      body: reportingCurrencyChangeRequestSchema,
      async handle({ customerId, body }) {
        const accounts = await directory.accounts(customerId);
        const option = (await options(accounts)).find(
          (entry) => entry.currency === body.reportingCurrency,
        );
        let change: ReportingCurrencyChange;
        if (!option?.available)
          change = {
            result: "refused",
            message: (option?.unavailableFor.length
              ? `${body.reportingCurrency} is not offered: ${option.unavailableFor.join(", ")} cannot convert to it with its own venue's markets.`
              : `${body.reportingCurrency} is not offered without an exchange account.`
            ).slice(0, 500),
            reportingCurrency: await directory.reportingCurrency(customerId),
          };
        else {
          await directory.changeReportingCurrency(
            customerId,
            body.reportingCurrency,
          );
          change = {
            result: "saved",
            message: `Totals now show in ${body.reportingCurrency}. Allocations and limits stay in each account's accounting currency.`,
            reportingCurrency: body.reportingCurrency,
          };
        }
        return { status: "connected", change };
      },
    }),
  };
}
