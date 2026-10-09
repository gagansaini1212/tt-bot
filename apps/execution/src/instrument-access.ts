import {
  type AccountAccess,
  instrumentAssets,
  instrumentLabel,
  isInstrument,
  type Instrument,
} from "@crypto-trading/domain";
import type { Transaction } from "@crypto-trading/database";
import { exchangeAccountAccess } from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";

/** What an exchange account allows to be traded. */
export type AccountInstruments = {
  // The customer's allowed instruments for the account.
  allowed: Instrument[];
  accountingCurrency: string;
  // From the account's venue: a read-only account is never traded, whatever
  // it allows (ADR 0009).
  access: AccountAccess;
};

/**
 * `scope`'s exchange account's allowed instruments, accounting currency and
 * access, in its customer's scope. An account the customer does not own
 * allows nothing and is read only. A value that is not a BASE-QUOTE
 * instrument is ignored rather than trusted.
 */
export async function selectAccountInstruments(
  tx: Transaction,
  scope: AccountScope,
): Promise<AccountInstruments> {
  const [account] = await tx<
    {
      allowed_instruments: string[];
      accounting_currency: string;
      exchange: string;
    }[]
  >`
    select allowed_instruments, accounting_currency, exchange
    from exchange_accounts
    where id = ${scope.exchangeAccountId}
      and customer_id = ${scope.customerId}
  `;
  return {
    allowed: [...new Set(account?.allowed_instruments ?? [])].filter(
      isInstrument,
    ),
    accountingCurrency: account?.accounting_currency ?? "",
    access: account ? exchangeAccountAccess(account.exchange) : "read_only",
  };
}

/**
 * Why nothing may be traded on the account, or undefined if it can trade.
 * A read-only exchange account is monitored, but never the target of a
 * strategy, proposal or order (ADR 0009).
 */
export function accountTradingRefusal(account: AccountInstruments) {
  return account.access === "read_only"
    ? "This exchange account is read only: the product monitors it but never trades on it (ADR 0009)."
    : undefined;
}

/**
 * Why the account cannot trade `instrument`, or undefined if it can: the
 * customer allows it, and it is quoted in the account's accounting currency,
 * so its allocation and limits need no conversion (ADR 0009). Whether the
 * venue lists it is the market catalogue's to say.
 */
export function instrumentRefusal(
  account: AccountInstruments,
  instrument: Instrument,
): string | undefined {
  if (!account.allowed.includes(instrument))
    return `${instrumentLabel(instrument)} is not among this exchange account's allowed instruments: ${account.allowed.map(instrumentLabel).join(", ") || "none"}.`;
  const { quote } = instrumentAssets(instrument);
  if (quote !== account.accountingCurrency)
    return `${instrumentLabel(instrument)} is quoted in ${quote}, not in this exchange account's accounting currency, ${account.accountingCurrency}.`;
  return undefined;
}

/** The account's instruments that it can trade. */
export function tradableInstruments(account: AccountInstruments) {
  return account.allowed.filter(
    (instrument) => instrumentRefusal(account, instrument) === undefined,
  );
}
