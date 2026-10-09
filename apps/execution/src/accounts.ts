import {
  assertRowLevelSecurity,
  DEV_EXCHANGE_ACCOUNT_ID,
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  canPlaceOrders,
  venueFor,
  venueIdSchema,
  type VenueId,
} from "@crypto-trading/exchanges";

/** The exchange account a request acts on, and the customer who owns it. */
export type AccountScope = { customerId: string; exchangeAccountId: string };

/**
 * An exchange account as the worker serves it. `readOnly` comes from its
 * venue (ADR 0009): the worker monitors such an account and never trades on
 * it. `status` is `unavailable` while its venue cannot serve it.
 */
export type ExchangeAccount = AccountScope & {
  venue: VenueId;
  label: string;
  accountingCurrency: string;
  status: "connected" | "reconciling" | "unavailable";
  readOnly: boolean;
};

/**
 * Returns the exchange account if `customerId` owns it and the worker serves
 * it, or undefined. Throws if the database cannot answer.
 */
export type AccountResolver = (
  customerId: string,
  exchangeAccountId: string,
) => Promise<AccountScope | undefined>;

/**
 * Every exchange account of the customer that the worker serves, oldest
 * first. Throws if the database cannot answer.
 */
export type AccountLister = (customerId: string) => Promise<AccountScope[]>;

/**
 * The exchange account the worker's .env keys belong to: the seeded dev
 * customer's Binance Spot Testnet account. Every other account trades with
 * keys saved for it in Settings.
 */
export const TESTNET_EXCHANGE_ACCOUNT_ID = DEV_EXCHANGE_ACCOUNT_ID;

type Row = {
  id: string;
  exchange: string;
  label: string;
  mode: "simulation" | "live";
  accounting_currency: string;
  status: string;
};

/**
 * Whether the worker serves an account, and how. An account on a venue it
 * knows is served while it is connected, reconciling or unavailable; a
 * disconnected or handed-over account is never resolved, traded or looped
 * over. A venue that places orders does so on the testnet only, so a live
 * account there is refused. A read-only venue's account is monitored
 * whatever its mode.
 */
function served(customerId: string, row: Row): ExchangeAccount | undefined {
  const venue = venueIdSchema.safeParse(row.exchange);
  if (!venue.success) return undefined;
  if (!["connected", "reconciling", "unavailable"].includes(row.status))
    return undefined;
  const readOnly = !canPlaceOrders(venueFor(venue.data));
  if (!readOnly && row.mode !== "simulation") return undefined;
  return {
    customerId,
    exchangeAccountId: row.id,
    venue: venue.data,
    label: row.label,
    accountingCurrency: row.accounting_currency,
    status: row.status as ExchangeAccount["status"],
    readOnly,
  };
}

/**
 * Reads exchange accounts in the requesting customer's scope, so row-level
 * security hides them from every other customer. Before the first lookup it
 * checks that row-level security applies to the worker's database role at
 * all.
 */
function accountQueries(database: Database) {
  let secured: Promise<void> | undefined;
  let lastLogged: string | undefined;
  return async (customerId: string, exchangeAccountId?: string) => {
    try {
      secured ??= assertRowLevelSecurity(database).catch((error: unknown) => {
        secured = undefined;
        throw error;
      });
      await secured;
      const rows = await withCustomerScope(
        database,
        customerId,
        (transaction) => transaction<Row[]>`
          select id, exchange, label, mode, accounting_currency, status
          from exchange_accounts
          where (${exchangeAccountId ?? null}::uuid is null
              or id = ${exchangeAccountId ?? null}::uuid)
            and status not in ('disconnected', 'handed_over')
          order by created_at, id
        `,
      );
      lastLogged = undefined;
      return rows.flatMap((row) => served(customerId, row) ?? []);
    } catch (error) {
      // Refreshing pages retry every few seconds, so say it once.
      const message = `The execution worker cannot use PostgreSQL: ${error instanceof Error ? error.message : "unknown error"}`;
      if (message !== lastLogged) console.error(message);
      lastLogged = message;
      throw error;
    }
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Looks one exchange account up for the customer who owns it. */
export function accountResolver(
  database: Database,
): (
  customerId: string,
  exchangeAccountId: string,
) => Promise<ExchangeAccount | undefined> {
  const query = accountQueries(database);
  return async (customerId, exchangeAccountId) =>
    UUID.test(exchangeAccountId)
      ? (await query(customerId, exchangeAccountId))[0]
      : undefined;
}

/** Lists the customer's exchange accounts that the worker serves. */
export function accountLister(
  database: Database,
): (customerId: string) => Promise<ExchangeAccount[]> {
  const query = accountQueries(database);
  return (customerId) => query(customerId);
}

/**
 * Records that an account's venue cannot serve it, or serves it again, and
 * resolves whether its status changed, so the caller notifies once per
 * change. `reconciling` is the pass that reconciles it after it recovered.
 * A disconnected or handed-over account is left as it is.
 */
export async function setAccountStatus(
  transaction: Transaction,
  scope: AccountScope,
  status: ExchangeAccount["status"],
) {
  const changed = await transaction`
    update exchange_accounts set status = ${status}
    where id = ${scope.exchangeAccountId} and status <> ${status}
      and status in ('connected', 'reconciling', 'unavailable')
    returning id
  `;
  return changed.length > 0;
}

/**
 * Reads an exchange account's venue in its customer's scope: undefined if
 * the customer has no such account, or it is on a venue the worker does not
 * know.
 */
export function accountVenue(database: Database) {
  return async (scope: AccountScope): Promise<VenueId | undefined> => {
    if ("venue" in scope) return (scope as ExchangeAccount).venue;
    if (!UUID.test(scope.exchangeAccountId)) return undefined;
    const [row] = await withCustomerScope(
      database,
      scope.customerId,
      (transaction) => transaction<{ exchange: string }[]>`
        select exchange from exchange_accounts
        where id = ${scope.exchangeAccountId}
      `,
    );
    const venue = venueIdSchema.safeParse(row?.exchange);
    return venue.success ? venue.data : undefined;
  };
}
