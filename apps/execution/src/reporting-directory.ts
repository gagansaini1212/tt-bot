import { withCustomerScope, type Database } from "@crypto-trading/database";
import {
  DEFAULT_REPORTING_CURRENCY,
  isInstrument,
  reportingCurrencySchema,
  type Instrument,
  type ReportingCurrencyChoice,
} from "@crypto-trading/domain";
import {
  accountVenue,
  exchangeAccountAccess,
  portfolioAccountSchema,
  type PortfolioAccount,
} from "@crypto-trading/exchanges";
import type {
  ExchangeAccountRecord,
  ExchangeAccountStore,
} from "./exchange-accounts";

// A customer's exchange accounts as totals across them see them, and the
// reporting currency they are added up in (ADR 0009). The assistant's
// proposals check their target account here too. Which account the worker
// trades on is still the AccountResolver's.

/** One of the customer's exchange accounts, for totals and proposals. */
export type ReportingAccount = Omit<PortfolioAccount, "served">;

/**
 * A customer's exchange accounts and reporting currency, each read in the
 * customer's scope, so row-level security hides every other customer's.
 */
export interface ReportingDirectory {
  /** The customer's exchange accounts they have not removed, oldest first. */
  accounts(customerId: string): Promise<ReportingAccount[]>;
  /** The customer's reporting currency, USDT unless they chose another. */
  reportingCurrency(customerId: string): Promise<string>;
  /** Saves a new reporting currency and audits the change. */
  changeReportingCurrency(
    customerId: string,
    currency: ReportingCurrencyChoice,
  ): Promise<void>;
}

/**
 * The account with its access, read only unless its venue can place
 * orders, or undefined for one that breaks the schema, which is left out
 * rather than trusted.
 */
export function reportingAccount(
  record: Pick<
    ExchangeAccountRecord,
    "id" | "venue" | "label" | "mode" | "accountingCurrency" | "status"
  >,
): ReportingAccount | undefined {
  const parsed = portfolioAccountSchema.omit({ served: true }).safeParse({
    id: record.id,
    venue: record.venue,
    venueName: accountVenue(record.venue)?.name ?? record.venue,
    label: record.label,
    accountingCurrency: record.accountingCurrency,
    mode: record.mode,
    status: record.status,
    access: exchangeAccountAccess(record.venue),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The directory in PostgreSQL: the accounts from `ExchangeAccountStore`, and
 * the reporting currency in `customers.reporting_currency`.
 */
export class PostgresReportingDirectory implements ReportingDirectory {
  readonly #database: Database;
  readonly #accounts: Pick<ExchangeAccountStore, "list">;

  constructor(
    database: Database,
    accounts: Pick<ExchangeAccountStore, "list">,
  ) {
    this.#database = database;
    this.#accounts = accounts;
  }

  async accounts(customerId: string) {
    return (await this.#accounts.list(customerId)).flatMap(
      (record) => reportingAccount(record) ?? [],
    );
  }

  reportingCurrency(customerId: string) {
    return withCustomerScope(this.#database, customerId, async (tx) => {
      const [row] = await tx<{ reporting_currency: string }[]>`
        select reporting_currency from customers where id = ${customerId}
      `;
      const saved = reportingCurrencySchema.safeParse(row?.reporting_currency);
      return saved.success ? saved.data : DEFAULT_REPORTING_CURRENCY;
    });
  }

  changeReportingCurrency(
    customerId: string,
    currency: ReportingCurrencyChoice,
  ) {
    return withCustomerScope(this.#database, customerId, async (tx) => {
      const [previous] = await tx<{ reporting_currency: string }[]>`
        select reporting_currency from customers where id = ${customerId}
        for update
      `;
      if (!previous) throw new Error("The customer does not exist.");
      if (previous.reporting_currency === currency) return;
      await tx`
        update customers set reporting_currency = ${currency}
        where id = ${customerId}
      `;
      await tx`
        insert into audit_events
          (customer_id, actor_type, actor_id, event_type, subject_type,
            subject_id, payload)
        values (
          ${customerId}, 'customer', ${customerId},
          'reporting_currency.changed', 'customer', ${customerId},
          ${tx.json({ previous: previous.reporting_currency, reportingCurrency: currency })}
        )
      `;
    });
  }
}

/**
 * The markets a venue lists, for checking that a conversion route exists,
 * or undefined where the worker cannot read the venue's markets.
 */
export type VenueMarkets = (
  venue: string,
) => Promise<((instrument: Instrument) => boolean) | undefined>;

/**
 * The trading markets of the worker's catalogues, by venue ID. A venue
 * without a catalogue, or whose catalogue cannot load, lists nothing the
 * worker can vouch for.
 */
export function catalogueMarkets(
  catalogues: ReadonlyMap<
    string,
    { markets(): Promise<{ instrument: string; status: string }[]> }
  >,
): VenueMarkets {
  return async (venue) => {
    const markets = await catalogues
      .get(venue)
      ?.markets()
      .catch(() => undefined);
    if (!markets) return undefined;
    const listed = new Set(
      markets
        .filter((market) => market.status === "trading")
        .map((market) => market.instrument)
        .filter(isInstrument),
    );
    return (instrument) => listed.has(instrument);
  };
}
