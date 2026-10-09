import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  MAX_EXCHANGE_ACCOUNTS,
  venueCapabilitiesSchema,
  type ExchangeAccountMode,
  type ExchangeAccountStatus,
  type SupportedFeatures,
  type Venue,
  type VenueCapabilities,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import { TERMINAL_STATES } from "./entry-assessment";
import {
  deleteSavedKeys,
  writeSealedKeys,
  type SealedKeys,
} from "./exchange-credentials";

/** An exchange account the customer has not removed. */
export type ExchangeAccountRecord = {
  id: string;
  // A venue ID. Rows may name a venue this build has no adapter for.
  venue: string;
  label: string;
  mode: ExchangeAccountMode;
  accountingCurrency: string;
  status: ExchangeAccountStatus;
  supportedFeatures: SupportedFeatures | null;
  supportedFeaturesRefreshedAt: Date | null;
  createdAt: Date;
};

/**
 * What the product still manages on an account, each of which keeps it from
 * being removed: running strategies, open positions, and orders the worker
 * holds, is sending, or has not finished reconciling.
 */
export type OpenWork = {
  strategies: number;
  positions: number;
  orders: number;
};

export type NewExchangeAccount = {
  venue: Venue;
  label: string;
  mode: ExchangeAccountMode;
  accountingCurrency: string;
};

type Row = {
  id: string;
  exchange: string;
  label: string;
  mode: ExchangeAccountMode;
  accounting_currency: string;
  status: ExchangeAccountStatus;
  supported_features: unknown;
  supported_features_refreshed_at: Date | null;
  created_at: Date;
};

// Removed accounts keep their rows, so their orders and fills still name
// them, but nothing here returns or changes them.
const REMOVED = ["disconnected", "handed_over"];
const TERMINAL = TERMINAL_STATES as readonly string[];

function toRecord(row: Row): ExchangeAccountRecord {
  const features = venueCapabilitiesSchema.safeParse(row.supported_features);
  return {
    id: row.id,
    venue: row.exchange,
    label: row.label,
    mode: row.mode,
    accountingCurrency: row.accounting_currency,
    status: row.status,
    supportedFeatures: features.success ? features.data : null,
    supportedFeaturesRefreshedAt: row.supported_features_refreshed_at,
    createdAt: row.created_at,
  };
}

/**
 * A customer's exchange accounts in PostgreSQL. Every query runs in the
 * customer's scope, so row-level security hides other customers' accounts,
 * and every change is audited. Keys are written with the account they
 * belong to, through `ExchangeCredentialStore`'s sealing.
 */
export class ExchangeAccountStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #scoped<T>(customerId: string, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, customerId, work);
  }

  /** The customer's accounts, oldest first. */
  async list(customerId: string): Promise<ExchangeAccountRecord[]> {
    const rows = await this.#scoped(
      customerId,
      (tx) => tx<Row[]>`
        select id, exchange, label, mode, accounting_currency, status,
          supported_features, supported_features_refreshed_at, created_at
        from exchange_accounts
        where status not in ${tx(REMOVED)}
        order by created_at, id
      `,
    );
    return rows.map(toRecord);
  }

  async get(scope: AccountScope): Promise<ExchangeAccountRecord | undefined> {
    const [row] = await this.#scoped(
      scope.customerId,
      (tx) => tx<Row[]>`
        select id, exchange, label, mode, accounting_currency, status,
          supported_features, supported_features_refreshed_at, created_at
        from exchange_accounts
        where id = ${scope.exchangeAccountId} and status not in ${tx(REMOVED)}
      `,
    );
    return row && toRecord(row);
  }

  /**
   * Adds an account with its keys, sealed for `scope`, and records what its
   * venue's adapter supports, all in one transaction. Throws
   * `KeysInUseError` if another account holds the same API key.
   */
  add(
    scope: AccountScope,
    account: NewExchangeAccount,
    keys: SealedKeys,
  ): Promise<
    { result: "added" } | { result: "label_taken" | "limit_reached" }
  > {
    return this.#scoped(scope.customerId, async (tx) => {
      // Adds and relabels for one customer wait for each other, so the
      // checks below hold when the account is inserted.
      await lockCustomer(tx, scope.customerId);
      const [{ count }] = await tx<{ count: number }[]>`
        select count(*)::int as count from exchange_accounts
        where status not in ${tx(REMOVED)}
      `;
      if (count >= MAX_EXCHANGE_ACCOUNTS)
        return { result: "limit_reached" as const };
      if (await labelTaken(tx, account.label))
        return { result: "label_taken" as const };
      await tx`
        insert into exchange_accounts (
          id, customer_id, exchange, label, mode, accounting_currency, status,
          supported_features, supported_features_refreshed_at
        )
        values (
          ${scope.exchangeAccountId}, ${scope.customerId}, ${account.venue.id},
          ${account.label}, ${account.mode}, ${account.accountingCurrency},
          'connected', ${tx.json(account.venue.capabilities)}, now()
        )
      `;
      await writeSealedKeys(tx, scope, keys);
      await audit(tx, scope, "exchange_account.added", {
        venue: account.venue.id,
        label: account.label,
        mode: account.mode,
        accountingCurrency: account.accountingCurrency,
      });
      return { result: "added" as const };
    });
  }

  relabel(
    scope: AccountScope,
    label: string,
  ): Promise<{ result: "saved" | "not_found" | "label_taken" }> {
    return this.#scoped(scope.customerId, async (tx) => {
      await lockCustomer(tx, scope.customerId);
      const [current] = await tx<{ label: string }[]>`
        select label from exchange_accounts
        where id = ${scope.exchangeAccountId} and status not in ${tx(REMOVED)}
      `;
      if (!current) return { result: "not_found" as const };
      if (current.label === label) return { result: "saved" as const };
      if (await labelTaken(tx, label, scope.exchangeAccountId))
        return { result: "label_taken" as const };
      await tx`
        update exchange_accounts set label = ${label}
        where id = ${scope.exchangeAccountId}
      `;
      await audit(tx, scope, "exchange_account.relabelled", {
        from: current.label,
        to: label,
      });
      return { result: "saved" as const };
    });
  }

  /**
   * Records what the venue's adapter declares it supports, when the account
   * connects. Resolves false if the account is gone.
   */
  async refreshFeatures(
    scope: AccountScope,
    capabilities: VenueCapabilities,
  ): Promise<boolean> {
    const rows = await this.#scoped(
      scope.customerId,
      (tx) => tx`
        update exchange_accounts set
          supported_features = ${tx.json(capabilities)},
          supported_features_refreshed_at = now()
        where id = ${scope.exchangeAccountId} and status not in ${tx(REMOVED)}
        returning id
      `,
    );
    return rows.length > 0;
  }

  /**
   * Disconnects the account and deletes its keys, unless the product still
   * manages something there. Its row stays, marked `disconnected`, so its
   * history keeps naming it.
   */
  remove(
    scope: AccountScope,
  ): Promise<
    { result: "removed" | "not_found" } | { result: "open"; open: OpenWork }
  > {
    return this.#scoped(scope.customerId, async (tx) => {
      const [account] = await tx<{ label: string; exchange: string }[]>`
        select label, exchange from exchange_accounts
        where id = ${scope.exchangeAccountId} and status not in ${tx(REMOVED)}
        for update
      `;
      if (!account) return { result: "not_found" as const };
      const open = await openWork(tx, scope.exchangeAccountId);
      if (open.strategies || open.positions || open.orders)
        return { result: "open" as const, open };
      await tx`
        update exchange_accounts
        set status = 'disconnected', disconnected_at = now()
        where id = ${scope.exchangeAccountId}
      `;
      await deleteSavedKeys(tx, scope);
      await audit(tx, scope, "exchange_account.disconnected", {
        venue: account.exchange,
        label: account.label,
      });
      return { result: "removed" as const };
    });
  }
}

async function lockCustomer(tx: Transaction, customerId: string) {
  await tx`select id from customers where id = ${customerId} for update`;
}

async function labelTaken(tx: Transaction, label: string, except = "") {
  const [row] = await tx`
    select id from exchange_accounts
    where lower(label) = lower(${label}) and status not in ${tx(REMOVED)}
      and id::text <> ${except}
  `;
  return row !== undefined;
}

/** What the product still manages on the account. */
export async function openWork(
  tx: Transaction,
  exchangeAccountId: string,
): Promise<OpenWork> {
  const [counts] = await tx<OpenWork[]>`
    select
      (
        select count(*) from strategies
        where exchange_account_id = ${exchangeAccountId}
          and status in ('simulation', 'active')
      )::int as strategies,
      (
        select count(*) from position_ownership
        where exchange_account_id = ${exchangeAccountId}
          and status in ('open', 'closing')
      )::int as positions,
      (
        select count(*) from order_intents i
        left join trade_proposals p on p.id = i.proposal_id
        left join entry_reconciliations r on r.order_intent_id = i.id
        where coalesce(i.exchange_account_id, p.exchange_account_id)
            = ${exchangeAccountId}
          and (
            -- Held stop-limit entries, and orders being sent or whose
            -- outcome is unknown.
            i.status in ('pending', 'submitting', 'unknown')
            -- Protected entries the loop has not finished with.
            or (
              i.status = 'acknowledged'
              and (
                i.manual_order ->> 'kind' = 'protected_entry'
                or i.proposal_id is not null
              )
              and (r.state is null or r.state not in ${tx(TERMINAL)})
            )
          )
      )::int as orders
  `;
  return counts;
}

function audit(
  tx: Transaction,
  scope: AccountScope,
  eventType: string,
  payload: Record<string, string>,
) {
  return tx`
    insert into audit_events
      (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
    values (
      ${scope.customerId}, 'customer', ${scope.customerId}, ${eventType},
      'exchange_account', ${scope.exchangeAccountId}, ${tx.json(payload)}
    )
  `;
}
