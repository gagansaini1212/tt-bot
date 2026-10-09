// Browser-safe: a customer's exchange accounts and reporting currency, as the
// execution worker reports them for totals across accounts (ADR 0009).
import {
  accountAccessSchema,
  assetCodeSchema,
  reportingCurrencyChoiceSchema,
  reportingCurrencySchema,
  type ReportingCurrencyOption,
} from "@crypto-trading/domain";
import { z } from "zod";
import {
  exchangeAccountModeSchema,
  exchangeAccountStatusSchema,
} from "./exchange-accounts";

/**
 * One of the customer's exchange accounts in totals across accounts,
 * without its keys or balances.
 */
export const portfolioAccountSchema = z.object({
  id: z.uuid(),
  // The venue ID the account is stored with. It may name a venue this build
  // has no adapter for, whose account is then read only.
  venue: z.string().max(100),
  venueName: z.string().max(100),
  label: z.string().max(200),
  accountingCurrency: assetCodeSchema,
  mode: exchangeAccountModeSchema,
  status: exchangeAccountStatusSchema,
  // From the venue's adapter: a read-only account is monitored, never traded.
  access: accountAccessSchema,
  // Whether this worker reads the account now: /snapshot serves its
  // balances. An account it does not read is left out of totals.
  served: z.boolean(),
});
export type PortfolioAccount = z.infer<typeof portfolioAccountSchema>;

/** How the dashboard names an account: its venue, then its label if different. */
export function exchangeAccountName(
  account: Pick<PortfolioAccount, "venueName" | "label">,
) {
  return account.label === account.venueName
    ? account.label
    : `${account.venueName} · ${account.label}`;
}

export const reportingCurrencyOptionSchema = z.object({
  currency: reportingCurrencyChoiceSchema,
  available: z.boolean(),
  // The accounts whose venue has no route to the currency.
  unavailableFor: z.array(z.string().max(300)),
}) satisfies z.ZodType<ReportingCurrencyOption>;
export type ReportingCurrencyOptionView = z.infer<
  typeof reportingCurrencyOptionSchema
>;

/** The customer's reporting currency, the choices, and their accounts. */
export const customerPortfolioSchema = z.object({
  reportingCurrency: reportingCurrencySchema,
  options: z.array(reportingCurrencyOptionSchema),
  // Oldest first.
  accounts: z.array(portfolioAccountSchema),
});
export type CustomerPortfolio = z.infer<typeof customerPortfolioSchema>;

export const reportingCurrencyChangeRequestSchema = z.strictObject({
  reportingCurrency: reportingCurrencyChoiceSchema,
});
export type ReportingCurrencyChangeRequest = z.infer<
  typeof reportingCurrencyChangeRequestSchema
>;

export const reportingCurrencyChangeSchema = z.object({
  result: z.enum(["saved", "refused"]),
  message: z.string().max(500),
  reportingCurrency: reportingCurrencySchema,
});
export type ReportingCurrencyChange = z.infer<
  typeof reportingCurrencyChangeSchema
>;
