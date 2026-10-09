import Decimal from "decimal.js";
import { instrumentSchema } from "@crypto-trading/domain";
import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  protectedEntrySchema,
  type EntryAlert,
  type ProtectedEntry,
  type ExchangeFill,
  type MarketSellRequest,
  type ExchangeOrder,
} from "@crypto-trading/exchanges";
import type { JSONValue } from "@crypto-trading/database";
import type { AccountScope } from "./accounts";
import {
  CANCEL_ONLY_REASONS,
  TERMINAL_STATES,
  type EntryState,
  type LegState,
} from "./entry-assessment";
import { raiseNotification, type NewNotification } from "./notifications";
import {
  audit,
  manualOrderSchema,
  upsertOrders,
  type ManualOrder,
  type OrderIntentStatus,
} from "./order-intents";

// Binance's statuses for an order that will not change again.
const FINAL = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
]);

export type Reconciliation = {
  state: EntryState;
  filledQuantity: string;
  heldQuantity: string;
  firstFillAt: Date | null;
  exitReason: string | null;
  closeBlockedAt: Date | null;
  // What the customer accepted leaving without exits, if they cancelled it.
  customerAccepted: string | null;
  rateLimitedSells: number;
  detail: string;
};

/** A protected entry the loop still has to watch, with what it last saw. */
export type TrackedEntry = {
  orderIntentId: string;
  listClientOrderId: string;
  entry: ProtectedEntry;
  // Entries made from a proposal belong to a strategy, whose version sets
  // their holding period. Dashboard entries have neither.
  strategy: {
    strategyId: string;
    strategyVersion: number;
    holdingPeriodSeconds: number | null;
  } | null;
  reconciliation: Reconciliation | null;
  // Binance's last report of each of its orders, by client order ID.
  legs: Map<string, LegState & { final: boolean }>;
  closes: {
    orderIntentId: string;
    clientOrderId: string;
    status: OrderIntentStatus;
    order: MarketSellRequest;
  }[];
  // Fills of its orders and of the worker's sells, by client order ID.
  fills: {
    clientOrderId: string;
    quantity: string;
    fee: string;
    feeAsset: string;
    at: Date;
  }[];
};

export type ReconciliationUpdate = {
  state: EntryState;
  filled: string;
  held: string;
  firstFillAt: Date | null;
  exitReason: string | null;
  closeBlocked?: boolean;
  // Sells Binance refused this pass only because of a rate limit.
  rateLimitedSells?: number;
  detail: string;
};

/** Changes made in the same transaction as a reconciliation update. */
export type TransitionEffects = (
  tx: Transaction,
  previous: Reconciliation | null,
) => Promise<void>;

/**
 * Pauses a strategy whose entry lost its protection. The strategies module
 * may supply its own; this default stores the paused status and audits it.
 */
export type StrategyPauser = (
  tx: Transaction,
  scope: AccountScope,
  strategyId: string,
  reason: string,
) => Promise<void>;

export const pauseStrategyInDatabase: StrategyPauser = async (
  tx,
  scope,
  strategyId,
  reason,
) => {
  // The worker's next pass cancels the strategy's pending entries.
  const [paused] = await tx<{ id: string }[]>`
    update strategies set status = 'paused',
      pause_reason = 'protection_failed', paused_at = now(),
      exit_request = coalesce(exit_request, 'pause'), updated_at = now()
    where id = ${strategyId} and status in ('simulation', 'active')
    returning id
  `;
  if (paused)
    await audit(tx, scope, strategyId, "strategy.paused", {
      actor: "execution_worker",
      subjectType: "strategy",
      payload: { reason },
    });
};

/** After its deadline, an exit not finished within this long is overdue. */
export const OVERDUE_AFTER_MS = 60_000;

const terminal = TERMINAL_STATES as readonly string[];
const cancelOnly = CANCEL_ONLY_REASONS as readonly string[];

/** The execution loop's records in PostgreSQL, one customer scope at a time. */
export class ExecutionStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #scoped<T>(scope: AccountScope, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, scope.customerId, work);
  }

  /**
   * Acknowledged protected entries on the account that the loop has not
   * finished with: dashboard entries, and entries made from proposals.
   */
  trackedEntries(scope: AccountScope): Promise<TrackedEntry[]> {
    return this.#scoped(scope, async (tx) => {
      const rows = await tx<EntryRow[]>`
        select i.id, i.idempotency_key, i.manual_order,
          p.instrument, p.quantity, p.entry_price, p.stop_loss_price,
          p.take_profit_price, p.strategy_id, p.strategy_version,
          v.rules ->> 'holdingPeriodSeconds' as holding_period_seconds,
          r.state, r.filled_quantity, r.held_quantity, r.first_fill_at,
          r.exit_reason, r.close_blocked_at, r.customer_accepted_quantity,
          r.rate_limited_sells, r.detail
        from order_intents i
        left join trade_proposals p on p.id = i.proposal_id
        left join strategy_versions v
          on v.strategy_id = p.strategy_id and v.version = p.strategy_version
        left join entry_reconciliations r on r.order_intent_id = i.id
        where i.status = 'acknowledged'
          and coalesce(i.exchange_account_id, p.exchange_account_id) = ${scope.exchangeAccountId}
          and (
            i.manual_order ->> 'kind' = 'protected_entry'
            or (i.proposal_id is not null and p.market_kind = 'spot' and p.direction = 'long')
          )
          and (r.state is null or r.state not in ${tx(terminal)})
        order by i.created_at, i.id
      `;
      const entries = rows.flatMap((row) => toTrackedEntry(row));
      if (!entries.length) return [];
      const ids = entries.map((entry) => entry.orderIntentId);
      const closes = await tx<
        {
          id: string;
          closes_order_intent_id: string;
          idempotency_key: string;
          status: OrderIntentStatus;
          manual_order: unknown;
        }[]
      >`
        select id, closes_order_intent_id, idempotency_key, status, manual_order
        from order_intents
        where closes_order_intent_id in ${tx(ids)}
        order by created_at, id
      `;
      const legs = await tx<
        {
          order_intent_id: string;
          client_order_id: string;
          exchange_order_id: string | null;
          status: string;
          requested_quantity: string;
          filled_quantity: string;
        }[]
      >`
        select order_intent_id, client_order_id, exchange_order_id, status,
          requested_quantity, filled_quantity
        from exchange_orders
        where order_intent_id in ${tx([...ids, ...closes.map((close) => close.id)])}
      `;
      const byId = new Map(
        entries.map((entry) => [entry.orderIntentId, entry]),
      );
      const owned = [...ids, ...closes.map((close) => close.id)];
      const fills = await tx<
        {
          order_intent_id: string;
          client_order_id: string;
          quantity: string;
          fee: string;
          fee_currency: string;
          filled_at: Date;
        }[]
      >`
        select o.order_intent_id, o.client_order_id, f.quantity, f.fee,
          f.fee_currency, f.filled_at
        from fills f join exchange_orders o on o.id = f.exchange_order_id
        where o.order_intent_id in ${tx(owned)}
      `;
      const closeOwner = new Map(
        closes.map((close) => [close.id, close.closes_order_intent_id]),
      );
      const ownerOf = (intentId: string) =>
        byId.get(closeOwner.get(intentId) ?? intentId);
      for (const leg of legs) {
        ownerOf(leg.order_intent_id)?.legs.set(leg.client_order_id, {
          clientOrderId: leg.client_order_id,
          orderId: leg.exchange_order_id,
          status: leg.status,
          origQty: amount(leg.requested_quantity),
          executedQty: amount(leg.filled_quantity),
          final: FINAL.has(leg.status),
        });
      }
      for (const close of closes) {
        const order = manualOrderSchema.safeParse(close.manual_order);
        if (order.success && order.data.kind === "exit")
          byId.get(close.closes_order_intent_id)?.closes.push({
            orderIntentId: close.id,
            clientOrderId: close.idempotency_key,
            status: close.status,
            order: order.data.order,
          });
      }
      for (const fill of fills)
        ownerOf(fill.order_intent_id)?.fills.push({
          clientOrderId: fill.client_order_id,
          quantity: amount(fill.quantity),
          fee: amount(fill.fee),
          feeAsset: fill.fee_currency,
          at: fill.filled_at,
        });
      return entries;
    });
  }

  /** An order intent by ID. `order` is null for one made from a proposal. */
  intent(scope: AccountScope, orderIntentId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<
        {
          idempotency_key: string;
          status: OrderIntentStatus;
          manual_order: unknown;
        }[]
      >`
        select idempotency_key, status, manual_order from order_intents
        where id = ${orderIntentId}
          and exchange_account_id = ${scope.exchangeAccountId}
      `;
      if (!row) return undefined;
      return {
        clientOrderId: row.idempotency_key,
        status: row.status,
        order:
          row.manual_order === null
            ? null
            : (manualOrderSchema.parse(row.manual_order) as ManualOrder),
      };
    });
  }

  audit(
    scope: AccountScope,
    orderIntentId: string,
    eventType: string,
    payload: Record<string, JSONValue>,
  ) {
    return this.#scoped(scope, (tx) =>
      audit(tx, scope, orderIntentId, eventType, {
        actor: "execution_worker",
        payload,
      }),
    );
  }

  /** Keeps Binance's report of each order under the intent it belongs to. */
  recordOrders(scope: AccountScope, orders: ExchangeOrder[]) {
    if (!orders.length) return Promise.resolve();
    return this.#scoped(scope, (tx) => upsertOrders(tx, scope, orders));
  }

  /** Keeps an order's fills. Record the order itself first. */
  recordFills(
    scope: AccountScope,
    clientOrderId: string,
    fills: ExchangeFill[],
  ) {
    if (!fills.length) return Promise.resolve();
    return this.#scoped(scope, async (tx) => {
      for (const fill of fills)
        await tx`
          insert into fills (
            customer_id, exchange_order_id, exchange_fill_id, quantity, price,
            fee, fee_currency, filled_at
          )
          select ${scope.customerId}, o.id, ${String(fill.id)}, ${fill.qty}::numeric,
            ${fill.price}::numeric, ${fill.commission}::numeric,
            ${fill.commissionAsset}, ${new Date(fill.time)}
          from exchange_orders o
          where o.client_order_id = ${clientOrderId}
            and exists (
              select from order_intents i
              where i.id = o.order_intent_id
                and i.exchange_account_id = ${scope.exchangeAccountId}
            )
          on conflict (exchange_order_id, exchange_fill_id) do nothing
        `;
    });
  }

  /**
   * Saves the loop's finding for an entry and runs `effects` in the same
   * transaction, against the finding it replaces. The row is locked first,
   * so when two workers check the same entry, the second sees the first's
   * finding and repeats no notification. An exit reason, once set, stays.
   */
  transition(
    scope: AccountScope,
    entry: TrackedEntry,
    update: ReconciliationUpdate,
    effects?: TransitionEffects,
  ): Promise<Reconciliation | null> {
    return this.#scoped(scope, async (tx) => {
      const inserted = await tx`
        insert into entry_reconciliations (customer_id, order_intent_id, state)
        values (${scope.customerId}, ${entry.orderIntentId}, ${update.state})
        on conflict (order_intent_id) do nothing
        returning id
      `;
      const [row] = await tx<ReconciliationRow[]>`
        select state, filled_quantity, held_quantity, first_fill_at, exit_reason,
          close_blocked_at, customer_accepted_quantity, rate_limited_sells, detail
        from entry_reconciliations
        where order_intent_id = ${entry.orderIntentId}
        for update
      `;
      const previous = inserted.length ? null : toReconciliation(row);
      // Another worker may have finished the entry first.
      if (previous && terminal.includes(previous.state)) return previous;
      await tx`
        update entry_reconciliations set
          state = ${update.state},
          filled_quantity = ${update.filled}::numeric,
          held_quantity = ${update.held}::numeric,
          first_fill_at = coalesce(first_fill_at, ${update.firstFillAt}),
          exit_requested_at = case
            when (exit_reason is null or exit_reason in ${tx(cancelOnly)}) and ${update.exitReason}::text is not null
              then now() else exit_requested_at end,
          exit_reason = case
            when (exit_reason is null or exit_reason in ${tx(cancelOnly)}) then coalesce(${update.exitReason}, exit_reason)
            else exit_reason end,
          rate_limited_sells = rate_limited_sells + ${update.rateLimitedSells ?? 0},
          close_blocked_at = case
            when ${update.closeBlocked ?? false} then coalesce(close_blocked_at, now())
            else close_blocked_at end,
          detail = ${update.detail},
          checked_at = now(),
          updated_at = case when state = ${update.state} then updated_at else now() end
        where order_intent_id = ${entry.orderIntentId}
      `;
      if (
        update.firstFillAt &&
        !previous?.firstFillAt &&
        entry.strategy?.holdingPeriodSeconds
      )
        await startHoldingDeadline(tx, scope, entry, update.firstFillAt);
      if (terminal.includes(update.state))
        await satisfyHoldingDeadline(tx, entry.orderIntentId);
      await effects?.(tx, previous);
      return previous;
    });
  }

  /**
   * Starts the exit of every entry whose holding deadline has passed.
   * `notify` describes each one's notification.
   */
  startDueExits(
    scope: AccountScope,
    now: Date,
    notify: (entry: DeadlineEntry) => NewNotification,
  ) {
    return this.#scoped(scope, async (tx) => {
      const due = await tx<DeadlineRow[]>`
        update holding_deadlines d set status = 'triggered'
        from order_intents i
        where d.order_intent_id = i.id and d.status = 'pending'
          and i.exchange_account_id = ${scope.exchangeAccountId}
          and d.deadline_at <= ${now}
        returning d.order_intent_id, d.deadline_at, i.idempotency_key
      `;
      for (const row of due) {
        await tx`
          insert into entry_reconciliations (customer_id, order_intent_id, state)
          values (${scope.customerId}, ${row.order_intent_id}, 'exiting')
          on conflict (order_intent_id) do nothing
        `;
        await tx`
          update entry_reconciliations set
            exit_requested_at = case when (exit_reason is null or exit_reason in ${tx(cancelOnly)}) then now() else exit_requested_at end,
            exit_reason = case when (exit_reason is null or exit_reason in ${tx(cancelOnly)}) then 'holding_deadline' else exit_reason end,
            updated_at = now()
          where order_intent_id = ${row.order_intent_id}
        `;
        await raiseNotification(tx, scope.customerId, notify(toDeadline(row)));
      }
      return due.length;
    });
  }

  /** Marks exits still held `OVERDUE_AFTER_MS` past their deadline overdue. */
  markOverdueExits(
    scope: AccountScope,
    now: Date,
    notify: (entry: DeadlineEntry) => NewNotification,
  ) {
    return this.#scoped(scope, async (tx) => {
      const overdue = await tx<DeadlineRow[]>`
        update holding_deadlines d set status = 'overdue'
        from order_intents i, entry_reconciliations r
        where d.order_intent_id = i.id and r.order_intent_id = i.id
          and i.exchange_account_id = ${scope.exchangeAccountId}
          and d.status = 'triggered'
          and d.deadline_at <= ${new Date(now.getTime() - OVERDUE_AFTER_MS)}
          and r.state not in ${tx(terminal)}
        returning d.order_intent_id, d.deadline_at, i.idempotency_key
      `;
      for (const row of overdue)
        await raiseNotification(tx, scope.customerId, notify(toDeadline(row)));
      return overdue.length;
    });
  }

  /** Saves a notification on its own, outside any other change. */
  notify(scope: AccountScope, notification: NewNotification) {
    return this.#scoped(scope, (tx) =>
      raiseNotification(tx, scope.customerId, notification),
    );
  }

  /** Entries the customer must know about now, for the dashboard. */
  alerts(scope: AccountScope): Promise<EntryAlert[]> {
    return this.#scoped(scope, async (tx) => {
      const rows = await tx<
        {
          idempotency_key: string;
          instrument: string | null;
          state: EntryAlert["state"];
          held_quantity: string;
          exit_reason: string | null;
          detail: string;
          close_blocked_at: Date | null;
          deadline_status: string | null;
          deadline_at: Date | null;
          updated_at: Date;
        }[]
      >`
        select i.idempotency_key,
          coalesce(i.manual_order -> 'entry' ->> 'instrument', p.instrument) as instrument,
          r.state, r.held_quantity, r.exit_reason, r.detail, r.close_blocked_at,
          d.status as deadline_status, d.deadline_at, r.updated_at
        from entry_reconciliations r
        join order_intents i on i.id = r.order_intent_id
        left join trade_proposals p on p.id = i.proposal_id
        left join holding_deadlines d on d.order_intent_id = i.id
        where i.exchange_account_id = ${scope.exchangeAccountId}
          and (r.state in ('unprotected', 'exiting')
            or (d.status = 'overdue' and r.state in ('protected', 'partly_filled')))
        order by r.updated_at desc, i.id
      `;
      return rows.flatMap((row) => {
        const instrument = instrumentSchema.safeParse(row.instrument);
        if (!instrument.success) return [];
        return [
          {
            listClientOrderId: row.idempotency_key,
            instrument: instrument.data,
            state: row.state,
            heldQuantity: amount(row.held_quantity),
            exitReason: row.exit_reason,
            detail: row.detail.slice(0, 500),
            closeBlocked: row.close_blocked_at !== null,
            overdueSince:
              row.deadline_status === "overdue" && row.deadline_at
                ? row.deadline_at.toISOString()
                : null,
            since: row.updated_at.toISOString(),
          },
        ];
      });
    });
  }
}

/**
 * Asks the worker to stop a protected entry: cancel whatever is still open
 * on Binance, the entry's unfilled remainder and its exits, and sell whatever
 * it holds at market. The request is saved, so it survives a restart, and
 * the execution loop carries it out on its next pass. Close all and loss
 * limits use this, or `stopStrategyEntries` for a whole strategy. Resolves
 * false if the entry is not on this account or already finished.
 */
export function requestEntryExit(
  database: Database,
  scope: AccountScope,
  orderIntentId: string,
  reason: string,
): Promise<boolean> {
  checkReason(reason);
  return withCustomerScope(database, scope.customerId, async (tx) => {
    const [intent] = await tx<{ id: string }[]>`
      select i.id from order_intents i
      left join trade_proposals p on p.id = i.proposal_id
      where i.id = ${orderIntentId} and i.status = 'acknowledged'
        and coalesce(i.exchange_account_id, p.exchange_account_id) = ${scope.exchangeAccountId}
    `;
    return intent ? requestExit(tx, scope, intent.id, reason) : false;
  });
}

/**
 * Stops every protected entry a strategy has on the account, as
 * `requestEntryExit` does. With reason `pause`, an entry that has filled
 * completely keeps its exits and holding deadline: only entries still on
 * the book are cancelled, and what a partly filled one bought is sold,
 * because Binance cannot protect it. Resolves the IDs of the order intents
 * it stopped.
 */
export function stopStrategyEntries(
  database: Database,
  scope: AccountScope,
  strategyId: string,
  reason: string,
): Promise<string[]> {
  return withCustomerScope(database, scope.customerId, (tx) =>
    requestStrategyExits(tx, scope, strategyId, reason),
  );
}

/**
 * `stopStrategyEntries` in `tx`. With `unrequested`, only entries that have
 * no exit request yet, or only a pause when `reason` is stronger, are
 * stopped, so it can run on every pass without repeating itself.
 */
export async function requestStrategyExits(
  tx: Transaction,
  scope: AccountScope,
  strategyId: string,
  reason: string,
  { unrequested = false }: { unrequested?: boolean } = {},
): Promise<string[]> {
  checkReason(reason);
  const replaceable = cancelOnly.includes(reason) ? [] : cancelOnly;
  const entries = await tx<{ id: string }[]>`
    select i.id from order_intents i
    join trade_proposals p on p.id = i.proposal_id
    left join entry_reconciliations r on r.order_intent_id = i.id
    where p.strategy_id = ${strategyId} and i.status = 'acknowledged'
      and p.exchange_account_id = ${scope.exchangeAccountId}
      and (r.state is null or r.state not in ${tx(terminal)})
      and (
        not ${unrequested}
        or r.exit_reason is null
        or r.exit_reason in ${tx(replaceable.length ? replaceable : [""])}
      )
    order by i.created_at, i.id
  `;
  const stopped: string[] = [];
  for (const { id } of entries)
    if (await requestExit(tx, scope, id, reason)) stopped.push(id);
  return stopped;
}

/** `requestEntryExit` in `tx`, for an entry already known to be on the account. */
export function requestExitIn(
  tx: Transaction,
  scope: AccountScope,
  orderIntentId: string,
  reason: string,
) {
  checkReason(reason);
  return requestExit(tx, scope, orderIntentId, reason);
}

function checkReason(reason: string) {
  if (!/^[a-z_]{1,40}$/.test(reason))
    throw new Error("Exit reasons are lowercase words joined by underscores.");
}

async function requestExit(
  tx: Transaction,
  scope: AccountScope,
  orderIntentId: string,
  reason: string,
) {
  await tx`
    insert into entry_reconciliations (customer_id, order_intent_id, state)
    values (${scope.customerId}, ${orderIntentId}, 'working')
    on conflict (order_intent_id) do nothing
  `;
  // A stronger request replaces a pause; nothing replaces another reason.
  const [requested] = await tx<{ id: string }[]>`
    update entry_reconciliations set
      exit_reason = case when (exit_reason is null or exit_reason in ${tx(cancelOnly)}) then ${reason} else exit_reason end,
      exit_requested_at = case when (exit_reason is null or exit_reason in ${tx(cancelOnly)}) then now() else exit_requested_at end,
      updated_at = now()
    where order_intent_id = ${orderIntentId}
      and state not in ${tx(terminal)}
    returning id
  `;
  if (requested)
    await audit(tx, scope, orderIntentId, "entry.exit_requested", {
      actor: "execution_worker",
      payload: { reason },
    });
  return Boolean(requested);
}

async function startHoldingDeadline(
  tx: Transaction,
  scope: AccountScope,
  entry: TrackedEntry,
  firstFillAt: Date,
) {
  const strategy = entry.strategy!;
  // One strategy owns an instrument's position on an account. A closed
  // position is reopened for the strategy filling an entry in it now.
  const [position] = await tx<{ id: string }[]>`
    insert into position_ownership as p (
      customer_id, exchange_account_id, strategy_id, strategy_version,
      instrument, status, first_fill_at
    )
    values (
      ${scope.customerId}, ${scope.exchangeAccountId}, ${strategy.strategyId},
      ${strategy.strategyVersion}, ${entry.entry.instrument}, 'open', ${firstFillAt}
    )
    on conflict (exchange_account_id, instrument) do update set
      strategy_id = case when p.status = 'closed' then excluded.strategy_id else p.strategy_id end,
      strategy_version = case when p.status = 'closed' then excluded.strategy_version else p.strategy_version end,
      first_fill_at = case when p.status = 'closed' then excluded.first_fill_at else p.first_fill_at end,
      status = case when p.status = 'closed' then 'open' else p.status end
    returning id
  `;
  await tx`
    insert into holding_deadlines (
      customer_id, position_ownership_id, order_intent_id, deadline_at, status
    )
    values (
      ${scope.customerId}, ${position.id}, ${entry.orderIntentId},
      ${new Date(firstFillAt.getTime() + strategy.holdingPeriodSeconds! * 1000)},
      'pending'
    )
    on conflict (order_intent_id) do nothing
  `;
}

async function satisfyHoldingDeadline(tx: Transaction, orderIntentId: string) {
  const satisfied = await tx<{ position_ownership_id: string }[]>`
    update holding_deadlines set status = 'satisfied'
    where order_intent_id = ${orderIntentId}
      and status in ('pending', 'triggered', 'overdue')
    returning position_ownership_id
  `;
  for (const { position_ownership_id: position } of satisfied)
    await tx`
      update position_ownership set status = 'closed'
      where id = ${position} and status = 'open'
        and not exists (
          select from holding_deadlines
          where position_ownership_id = ${position}
            and status in ('pending', 'triggered', 'overdue')
        )
    `;
}

export type DeadlineEntry = {
  orderIntentId: string;
  listClientOrderId: string;
  deadlineAt: Date;
};

type DeadlineRow = {
  order_intent_id: string;
  deadline_at: Date;
  idempotency_key: string;
};

function toDeadline(row: DeadlineRow): DeadlineEntry {
  return {
    orderIntentId: row.order_intent_id,
    listClientOrderId: row.idempotency_key,
    deadlineAt: row.deadline_at,
  };
}

type ReconciliationRow = {
  state: EntryState;
  filled_quantity: string;
  held_quantity: string;
  first_fill_at: Date | null;
  exit_reason: string | null;
  close_blocked_at: Date | null;
  customer_accepted_quantity: string | null;
  rate_limited_sells: number;
  detail: string;
};

type EntryRow = Partial<ReconciliationRow> & {
  id: string;
  idempotency_key: string;
  manual_order: unknown;
  instrument: string | null;
  quantity: string | null;
  entry_price: string | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  strategy_id: string | null;
  strategy_version: number | null;
  holding_period_seconds: string | null;
};

function toReconciliation(row: ReconciliationRow): Reconciliation {
  return {
    state: row.state,
    filledQuantity: amount(row.filled_quantity),
    heldQuantity: amount(row.held_quantity),
    firstFillAt: row.first_fill_at,
    exitReason: row.exit_reason,
    closeBlockedAt: row.close_blocked_at,
    customerAccepted:
      row.customer_accepted_quantity === null
        ? null
        : amount(row.customer_accepted_quantity),
    rateLimitedSells: row.rate_limited_sells,
    detail: row.detail,
  };
}

function toTrackedEntry(row: EntryRow): TrackedEntry[] {
  let entry: ProtectedEntry;
  const manual = manualOrderSchema.safeParse(row.manual_order);
  if (manual.success && manual.data.kind === "protected_entry") {
    entry = manual.data.entry;
  } else {
    // An entry made from a proposal is sent as a GTC limit OPOCO list whose
    // ID is the intent's idempotency key.
    const parsed = protectedEntrySchema.safeParse({
      instrument: row.instrument,
      quantity: row.quantity && amount(row.quantity),
      price: row.entry_price && amount(row.entry_price),
      timeInForce: "GTC",
      takeProfitPrice: row.take_profit_price && amount(row.take_profit_price),
      stopLossPrice: row.stop_loss_price && amount(row.stop_loss_price),
      listClientOrderId: row.idempotency_key,
    });
    if (!parsed.success) return [];
    entry = parsed.data;
  }
  const holding = Number(row.holding_period_seconds);
  return [
    {
      orderIntentId: row.id,
      listClientOrderId: row.idempotency_key,
      entry,
      strategy:
        row.strategy_id && row.strategy_version
          ? {
              strategyId: row.strategy_id,
              strategyVersion: row.strategy_version,
              holdingPeriodSeconds:
                Number.isSafeInteger(holding) && holding > 0 ? holding : null,
            }
          : null,
      reconciliation: row.state
        ? toReconciliation(row as ReconciliationRow)
        : null,
      legs: new Map(),
      closes: [],
      fills: [],
    },
  ];
}

/** PostgreSQL numeric → plain decimal string. */
function amount(value: string) {
  return new Decimal(value).toFixed();
}
