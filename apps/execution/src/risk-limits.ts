import Decimal from "decimal.js";
import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  protectedLegIds,
  stopLossRisk,
  type ManualRiskLimits,
  type RiskLimitsState,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import type { ManualOrder } from "./order-intents";

/**
 * Platform maximums for manual trading on the testnet: upper bounds the
 * customer's risk limits cannot exceed. A version saved under higher
 * maximums is lowered to these when it is read.
 */
export const PLATFORM_RISK_MAXIMUMS: ManualRiskLimits = {
  maxOrderNotional: "1000",
  maxDailyRisk: "1000",
  defaultStopLossPercent: "50",
};
export const MINIMUM_STOP_LOSS_PERCENT = "0.1";

/** One version of a customer's limits for an exchange account. */
export type RiskLimitsVersion = ManualRiskLimits & {
  version: number;
  createdAt: Date;
};

export type RiskLimitsChangeResult =
  | { status: "saved"; limits: RiskLimitsVersion }
  // Another change saved a newer version first.
  | { status: "conflict"; current: RiskLimitsVersion | undefined };

/**
 * Where the worker keeps each exchange account's risk limits. Every version
 * is kept; the latest applies to new orders.
 */
export interface RiskLimitStore {
  current(scope: AccountScope): Promise<RiskLimitsVersion | undefined>;
  /**
   * Saves `limits` as version `baseVersion + 1`, if `baseVersion` is still
   * the latest (0 for none), and audits the change.
   */
  change(
    scope: AccountScope,
    limits: ManualRiskLimits,
    baseVersion: number,
  ): Promise<RiskLimitsChangeResult>;
  /**
   * The `manualOrderRisk` of the account's manual orders recorded since
   * `since`, summed, apart from the order `excluding` names. Stop-limit
   * entries the worker holds count, since they will spend it when they
   * trigger. Orders nothing was placed for (refused, or cancelled while
   * held), and orders cancelled or expired before anything filled, are left
   * out. Others count in full, whether or not they filled or have closed.
   */
  dailyRiskUsed(
    scope: AccountScope,
    since: Date,
    excluding?: string,
  ): Promise<string>;
}

/**
 * What a manual order counts against the daily risk limit: a dashboard
 * entry's loss if its stop fills at its price, (entry − stop) × quantity,
 * whether it was sent at once or held as a stop-limit entry, and a CLI buy,
 * which has no stop, at its full value. Sells add none: a CLI sell, or an
 * exit the worker sends, is never limited by it.
 * PostgresRiskLimits.dailyRiskUsed sums the same in SQL.
 */
export function manualOrderRisk(order: ManualOrder): Decimal {
  switch (order.kind) {
    case "protected_entry":
      return stopLossRisk(order.entry);
    case "limit_order":
      return order.order.side === "BUY"
        ? new Decimal(order.order.quantity).times(order.order.price)
        : new Decimal(0);
    case "exit":
      return new Decimal(0);
  }
}

/** Problems with `limits` against the platform maximums, as sentences. */
export function riskLimitIssues(limits: ManualRiskLimits): string[] {
  const issues: string[] = [];
  const over = (value: string, maximum: string) =>
    new Decimal(value).greaterThan(maximum);
  if (over(limits.maxOrderNotional, PLATFORM_RISK_MAXIMUMS.maxOrderNotional))
    issues.push(
      `The per-order cap can be at most ${PLATFORM_RISK_MAXIMUMS.maxOrderNotional} USDT.`,
    );
  if (over(limits.maxDailyRisk, PLATFORM_RISK_MAXIMUMS.maxDailyRisk))
    issues.push(
      `The daily risk limit can be at most ${PLATFORM_RISK_MAXIMUMS.maxDailyRisk} USDT.`,
    );
  const stop = new Decimal(limits.defaultStopLossPercent);
  if (
    stop.lessThan(MINIMUM_STOP_LOSS_PERCENT) ||
    over(
      limits.defaultStopLossPercent,
      PLATFORM_RISK_MAXIMUMS.defaultStopLossPercent,
    )
  )
    issues.push(
      `The default stop loss must be from ${MINIMUM_STOP_LOSS_PERCENT}% to ${PLATFORM_RISK_MAXIMUMS.defaultStopLossPercent}% below the entry.`,
    );
  return issues;
}

/** `limits`, each lowered to its platform maximum. */
export function withinPlatformMaximums<T extends ManualRiskLimits>(
  limits: T,
): T {
  const lower = (value: string, maximum: string) =>
    Decimal.min(value, maximum).toFixed();
  return {
    ...limits,
    maxOrderNotional: lower(
      limits.maxOrderNotional,
      PLATFORM_RISK_MAXIMUMS.maxOrderNotional,
    ),
    maxDailyRisk: lower(
      limits.maxDailyRisk,
      PLATFORM_RISK_MAXIMUMS.maxDailyRisk,
    ),
    defaultStopLossPercent: lower(
      limits.defaultStopLossPercent,
      PLATFORM_RISK_MAXIMUMS.defaultStopLossPercent,
    ),
  };
}

/** What the Settings page shows. */
export function riskLimitsState(
  current: RiskLimitsVersion | undefined,
): RiskLimitsState {
  return {
    current: current
      ? {
          version: current.version,
          maxOrderNotional: current.maxOrderNotional,
          maxDailyRisk: current.maxDailyRisk,
          defaultStopLossPercent: current.defaultStopLossPercent,
          createdAt: current.createdAt.toISOString(),
        }
      : null,
    platformMaximums: PLATFORM_RISK_MAXIMUMS,
    minimumStopLossPercent: MINIMUM_STOP_LOSS_PERCENT,
  };
}

type Row = {
  version: number;
  max_order_notional: string;
  max_daily_risk: string;
  default_stop_loss_percent: string;
  created_at: Date;
};

function fromRow(row: Row): RiskLimitsVersion {
  const amount = (value: string) => new Decimal(value).toFixed();
  return {
    version: row.version,
    maxOrderNotional: amount(row.max_order_notional),
    maxDailyRisk: amount(row.max_daily_risk),
    defaultStopLossPercent: amount(row.default_stop_loss_percent),
    createdAt: row.created_at,
  };
}

async function latest(tx: Transaction, scope: AccountScope) {
  const [row] = await tx<Row[]>`
    select version, max_order_notional, max_daily_risk,
      default_stop_loss_percent, created_at
    from manual_risk_limits
    where exchange_account_id = ${scope.exchangeAccountId}
    order by version desc
    limit 1
  `;
  return row && fromRow(row);
}

// PostgreSQL's unique_violation: a concurrent change took the version.
const UNIQUE_VIOLATION = "23505";
// Entry legs in these states, with nothing filled, hold no risk.
const ENDED_UNFILLED = ["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"];

/** Risk limits in PostgreSQL's manual_risk_limits, with audit events. */
export class PostgresRiskLimits implements RiskLimitStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  current(scope: AccountScope) {
    return withCustomerScope(this.#database, scope.customerId, (tx) =>
      latest(tx, scope),
    );
  }

  async change(
    scope: AccountScope,
    limits: ManualRiskLimits,
    baseVersion: number,
  ): Promise<RiskLimitsChangeResult> {
    try {
      return await withCustomerScope(
        this.#database,
        scope.customerId,
        async (tx) => {
          const previous = await latest(tx, scope);
          if ((previous?.version ?? 0) !== baseVersion)
            return { status: "conflict", current: previous };
          const [row] = await tx<(Row & { id: string })[]>`
            insert into manual_risk_limits (
              customer_id, exchange_account_id, version, max_order_notional,
              max_daily_risk, default_stop_loss_percent
            )
            values (
              ${scope.customerId}, ${scope.exchangeAccountId}, ${baseVersion + 1},
              ${limits.maxOrderNotional}::numeric, ${limits.maxDailyRisk}::numeric,
              ${limits.defaultStopLossPercent}::numeric
            )
            returning id, version, max_order_notional, max_daily_risk,
              default_stop_loss_percent, created_at
          `;
          const saved = fromRow(row);
          const limitsOf = ({
            version: _v,
            createdAt: _c,
            ...rest
          }: RiskLimitsVersion) => rest;
          await tx`
            insert into audit_events
              (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
            values (
              ${scope.customerId}, 'customer', ${scope.customerId},
              'risk_limits.changed', 'manual_risk_limits', ${row.id},
              ${tx.json({
                exchangeAccountId: scope.exchangeAccountId,
                version: saved.version,
                limits: limitsOf(saved),
                previous: previous ? limitsOf(previous) : null,
              })}
            )
          `;
          return { status: "saved", limits: saved };
        },
      );
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      return { status: "conflict", current: await this.current(scope) };
    }
  }

  async dailyRiskUsed(scope: AccountScope, since: Date, excluding?: string) {
    const entrySuffix = protectedLegIds("").entry;
    const [row] = await withCustomerScope(
      this.#database,
      scope.customerId,
      (tx) => tx<{ used: string }[]>`
        select coalesce(sum(
          case i.manual_order ->> 'kind'
            when 'protected_entry' then greatest(
              (i.manual_order -> 'entry' ->> 'price')::numeric
                - (i.manual_order -> 'entry' ->> 'stopLossPrice')::numeric,
              0
            ) * (i.manual_order -> 'entry' ->> 'quantity')::numeric
            else (i.manual_order -> 'order' ->> 'price')::numeric
              * (i.manual_order -> 'order' ->> 'quantity')::numeric
          end
        ), 0) as used
        from order_intents i
        where i.exchange_account_id = ${scope.exchangeAccountId}
          and (
            i.manual_order ->> 'kind' = 'protected_entry'
            or (i.manual_order ->> 'kind' = 'limit_order'
              and i.manual_order -> 'order' ->> 'side' = 'BUY')
          )
          and i.created_at >= ${since}
          and i.status not in ('rejected', 'cancelled')
          and i.idempotency_key <> coalesce(${excluding ?? null}::text, '')
          and not exists (
            select from exchange_orders o
            where o.order_intent_id = i.id
              and o.client_order_id = case i.manual_order ->> 'kind'
                when 'protected_entry' then i.idempotency_key || ${entrySuffix}
                else i.idempotency_key
              end
              and o.status in ${tx(ENDED_UNFILLED)}
              and o.filled_quantity = 0
          )
      `,
    );
    return new Decimal(row.used).toFixed();
  }
}
