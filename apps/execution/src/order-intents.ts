import Decimal from "decimal.js";
import { z } from "zod";
import {
  withCustomerScope,
  type Database,
  type JSONValue,
  type Transaction,
} from "@crypto-trading/database";
import {
  exitReasonSchema,
  limitOrderSchema,
  marketSellSchema,
  positiveDecimal,
  protectedEntrySchema,
  protectedLeg,
  type TestnetOrder,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";

/**
 * An order sent without a proposal, exactly as it is sent to Binance: one a
 * customer entered by hand, or an exit the worker sends itself.
 */
export const manualOrderSchema = z.discriminatedUnion("kind", [
  // A dashboard buy with its exits, one Binance order list. With a trigger,
  // it is a stop-limit entry the worker holds until its stop price trades.
  z.object({
    kind: z.literal("protected_entry"),
    entry: protectedEntrySchema,
    trigger: z.object({ stopPrice: positiveDecimal }).optional(),
  }),
  // A CLI limit order.
  z.object({ kind: z.literal("limit_order"), order: limitOrderSchema }),
  // A market sell closing the protected entry whose intent is `closes`.
  z.object({
    kind: z.literal("exit"),
    closes: z.string().min(1).max(64),
    reason: exitReasonSchema,
    order: marketSellSchema,
  }),
]);
export type ManualOrder = z.infer<typeof manualOrderSchema>;
export type ProtectedEntryOrder = Extract<
  ManualOrder,
  { kind: "protected_entry" }
>;

/** The ID Binance knows the order by: the list's for a protected entry. */
export function clientOrderIdOf(order: ManualOrder) {
  return order.kind === "protected_entry"
    ? order.entry.listClientOrderId
    : order.order.clientOrderId;
}

/**
 * - pending: a stop-limit entry the worker holds; nothing has been sent.
 * - submitting: saved, and being sent. A crash can leave it here.
 * - unknown: sent, but Binance did not confirm whether it took it.
 * - acknowledged: Binance has it.
 * - rejected: nothing was placed. Binance refused it, the worker's checks
 *   did when a stop-limit entry triggered, or reconciliation found that
 *   Binance never received it.
 * - cancelled: the customer cancelled a pending stop-limit entry.
 */
export type OrderIntentStatus =
  | "pending"
  | "submitting"
  | "unknown"
  | "acknowledged"
  | "rejected"
  | "cancelled";

export type OrderIntent = {
  clientOrderId: string;
  status: OrderIntentStatus;
  order: ManualOrder;
  createdAt: Date;
};

export type Settlement =
  | { status: "acknowledged"; orderListId?: number; orders?: TestnetOrder[] }
  | { status: "rejected" | "unknown"; reason?: string };

export type IntentSource = "dashboard" | "cli" | "journal_import" | "worker";

/**
 * Binance can still be executing a submission it did not confirm, so an
 * unconfirmed order is not looked for until this long after it was saved.
 */
export const UNCONFIRMED_GRACE_MS = 60_000;

/**
 * Outbox topic for intents whose outcome is not known yet. Saving an intent
 * queues one, due after the grace period, and a confirmed or refused
 * submission completes it. A consumer looks the order up by client order ID
 * and must never resubmit it.
 */
export const RECONCILE_TOPIC = "order_intent.reconcile";

/**
 * Where the worker keeps order intents. Each call is one short transaction in
 * the customer's scope; nothing waits on Binance while a transaction is open.
 */
export interface OrderIntentStore {
  /**
   * Saves the intent before anything is sent, and commits. Resolves false if
   * the client order ID was used before, by anyone: it is never sent twice.
   */
  record(
    scope: AccountScope,
    order: ManualOrder,
    source: IntentSource,
    createdAt?: Date,
  ): Promise<boolean>;
  /**
   * Saves a stop-limit entry the worker holds, with status pending. Nothing
   * is sent until `claimTrigger`. Resolves false if the ID was used before.
   */
  hold(
    scope: AccountScope,
    order: ProtectedEntryOrder,
    source: IntentSource,
  ): Promise<boolean>;
  /** Pending stop-limit entries, oldest first. */
  pendingTriggers(scope: AccountScope): Promise<OrderIntent[]>;
  /**
   * Moves a pending stop-limit entry to submitting, queueing its
   * reconciliation, so it can be sent. Resolves undefined if it is no longer
   * pending: another worker claimed it, or the customer cancelled it.
   */
  claimTrigger(
    scope: AccountScope,
    clientOrderId: string,
  ): Promise<OrderIntent | undefined>;
  /** Cancels a pending stop-limit entry. False if it is no longer pending. */
  cancelTrigger(scope: AccountScope, clientOrderId: string): Promise<boolean>;
  /**
   * Notes, just before the customer cancels a partly filled entry from the
   * dashboard, that they accepted leaving its quantity without exits. False
   * clears the note if Binance refused the cancel.
   */
  noteCustomerCancel(
    scope: AccountScope,
    listClientOrderId: string,
    accepted: boolean,
  ): Promise<void>;
  /** Records Binance's answer. An intent never goes back to unknown. */
  settle(
    scope: AccountScope,
    clientOrderId: string,
    settlement: Settlement,
  ): Promise<void>;
  find(
    scope: AccountScope,
    clientOrderId: string,
  ): Promise<OrderIntent | undefined>;
  /** Entry prices of saved protected entries, by list client order ID. */
  entryPrices(
    scope: AccountScope,
    listClientOrderIds: string[],
  ): Promise<Map<string, string>>;
  /**
   * Keeps what Binance last reported for the orders of saved intents. Others,
   * such as orders placed on Binance's website, and exits Binance has not
   * sized yet are left out. `event` also audits each order.
   */
  recordOrders(
    scope: AccountScope,
    orders: TestnetOrder[],
    event?: "order.cancelled",
  ): Promise<void>;
}

/** The statuses each settlement may replace. */
export const SETTLES_FROM: Record<Settlement["status"], OrderIntentStatus[]> = {
  acknowledged: ["submitting", "unknown"],
  rejected: ["submitting"],
  unknown: ["submitting"],
};

/** Order intents in PostgreSQL's order_intents, exchange_orders, outbox_jobs and audit_events. */
export class PostgresOrderIntents implements OrderIntentStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #scoped<T>(scope: AccountScope, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, scope.customerId, work);
  }

  record(
    scope: AccountScope,
    order: ManualOrder,
    source: IntentSource,
    createdAt?: Date,
  ) {
    return this.#insert(scope, order, source, "submitting", createdAt);
  }

  hold(scope: AccountScope, order: ProtectedEntryOrder, source: IntentSource) {
    if (!order.trigger)
      throw new Error("Only stop-limit entries are held by the worker.");
    return this.#insert(scope, order, source, "pending");
  }

  #insert(
    scope: AccountScope,
    order: ManualOrder,
    source: IntentSource,
    status: "submitting" | "pending",
    createdAt?: Date,
  ) {
    const parsed = manualOrderSchema.parse(order);
    const clientOrderId = clientOrderIdOf(parsed);
    return this.#scoped(scope, async (tx) => {
      const [intent] = await tx<{ id: string }[]>`
        insert into order_intents (
          customer_id, exchange_account_id, idempotency_key, status, manual_order,
          closes_order_intent_id, created_at, updated_at
        )
        values (
          ${scope.customerId}, ${scope.exchangeAccountId}, ${clientOrderId},
          ${status}, ${tx.json(order)},
          ${
            parsed.kind === "exit"
              ? tx`(select id from order_intents where idempotency_key = ${parsed.closes})`
              : null
          },
          coalesce(${createdAt ?? null}::timestamptz, now()),
          coalesce(${createdAt ?? null}::timestamptz, now())
        )
        on conflict (idempotency_key) do nothing
        returning id
      `;
      if (!intent) return false;
      if (status === "submitting") await queueReconcile(tx, scope, intent.id);
      await audit(
        tx,
        scope,
        intent.id,
        status === "pending" ? "order_intent.held" : "order_intent.recorded",
        {
          actor: actorFor(source),
          payload: { source, order },
        },
      );
      return true;
    });
  }

  pendingTriggers(scope: AccountScope) {
    return this.#scoped(scope, async (tx) => {
      const rows = await tx<
        {
          idempotency_key: string;
          status: OrderIntentStatus;
          manual_order: unknown;
          created_at: Date;
        }[]
      >`
        select idempotency_key, status, manual_order, created_at from order_intents
        where status = 'pending' and exchange_account_id = ${scope.exchangeAccountId}
        order by created_at, idempotency_key
      `;
      return rows.map((row) => ({
        clientOrderId: row.idempotency_key,
        status: row.status,
        order: manualOrderSchema.parse(row.manual_order),
        createdAt: row.created_at,
      }));
    });
  }

  claimTrigger(scope: AccountScope, clientOrderId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<
        { id: string; manual_order: unknown; created_at: Date }[]
      >`
        update order_intents set status = 'submitting', updated_at = now()
        where idempotency_key = ${clientOrderId} and status = 'pending'
          and exchange_account_id = ${scope.exchangeAccountId}
        returning id, manual_order, created_at
      `;
      if (!row) return undefined;
      await queueReconcile(tx, scope, row.id);
      await audit(tx, scope, row.id, "order_intent.triggered", {
        actor: "execution_worker",
        payload: {},
      });
      return {
        clientOrderId,
        status: "submitting" as const,
        order: manualOrderSchema.parse(row.manual_order),
        createdAt: row.created_at,
      };
    });
  }

  cancelTrigger(scope: AccountScope, clientOrderId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        update order_intents set status = 'cancelled', updated_at = now()
        where idempotency_key = ${clientOrderId} and status = 'pending'
        returning id
      `;
      if (row)
        await audit(tx, scope, row.id, "order_intent.cancelled", {
          actor: "customer",
          payload: {},
        });
      return Boolean(row);
    });
  }

  noteCustomerCancel(
    scope: AccountScope,
    listClientOrderId: string,
    accepted: boolean,
  ) {
    return this.#scoped(scope, async (tx) => {
      await tx`
        insert into entry_reconciliations (customer_id, order_intent_id, state, customer_cancelled_at)
        select ${scope.customerId}, id, 'partly_filled', ${accepted ? tx`now()` : null}
        from order_intents where idempotency_key = ${listClientOrderId}
        on conflict (order_intent_id) do update set
          customer_cancelled_at = excluded.customer_cancelled_at, updated_at = now()
      `;
    });
  }

  settle(scope: AccountScope, clientOrderId: string, settlement: Settlement) {
    return this.#scoped(scope, async (tx) => {
      const [changed] = await tx<{ id: string }[]>`
        update order_intents set status = ${settlement.status}, updated_at = now()
        where idempotency_key = ${clientOrderId}
          and status in ${tx(SETTLES_FROM[settlement.status])}
        returning id
      `;
      if (changed) {
        const job = `${RECONCILE_TOPIC}:${changed.id}`;
        if (settlement.status === "unknown")
          await tx`
            update outbox_jobs set last_error = ${settlement.reason ?? "Binance did not confirm the submission."}
            where deduplication_key = ${job}
          `;
        else
          await tx`
            update outbox_jobs set completed_at = now()
            where deduplication_key = ${job} and completed_at is null
          `;
        await audit(
          tx,
          scope,
          changed.id,
          `order_intent.${settlement.status}`,
          {
            actor: "execution_worker",
            payload:
              settlement.status === "acknowledged"
                ? { orderListId: settlement.orderListId ?? null }
                : { reason: settlement.reason ?? null },
          },
        );
      }
      if (settlement.status === "acknowledged" && settlement.orders)
        await upsertOrders(tx, scope, settlement.orders);
    });
  }

  /**
   * Settles an intent Binance has no record of, once the grace period is
   * over. Only reconciliation may decide this.
   */
  resolveMissing(scope: AccountScope, clientOrderId: string) {
    return this.#scoped(scope, async (tx) => {
      const [changed] = await tx<{ id: string }[]>`
        update order_intents set status = 'rejected', updated_at = now()
        where idempotency_key = ${clientOrderId} and status in ('submitting', 'unknown')
        returning id
      `;
      if (!changed) return false;
      await tx`
        update outbox_jobs set completed_at = now()
        where deduplication_key = ${`${RECONCILE_TOPIC}:${changed.id}`}
          and completed_at is null
      `;
      await audit(tx, scope, changed.id, "order_intent.not_found", {
        actor: "execution_worker",
        payload: {
          reason:
            "Binance has no order with this client ID after the grace period, so it was never placed.",
        },
      });
      return true;
    });
  }

  find(scope: AccountScope, clientOrderId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<
        { status: OrderIntentStatus; manual_order: unknown; created_at: Date }[]
      >`
        select status, manual_order, created_at from order_intents
        where idempotency_key = ${clientOrderId} and manual_order is not null
      `;
      if (!row) return undefined;
      return {
        clientOrderId,
        status: row.status,
        order: manualOrderSchema.parse(row.manual_order),
        createdAt: row.created_at,
      };
    });
  }

  async entryPrices(scope: AccountScope, listClientOrderIds: string[]) {
    if (!listClientOrderIds.length) return new Map<string, string>();
    const rows = await this.#scoped(
      scope,
      (tx) => tx<{ id: string; price: string }[]>`
        select idempotency_key as id, manual_order -> 'entry' ->> 'price' as price
        from order_intents
        where idempotency_key in ${tx(listClientOrderIds)}
          and manual_order ->> 'kind' = 'protected_entry'
      `,
    );
    return new Map(rows.map(({ id, price }) => [id, price]));
  }

  recordOrders(
    scope: AccountScope,
    orders: TestnetOrder[],
    event?: "order.cancelled",
  ) {
    return this.#scoped(scope, async (tx) => {
      await upsertOrders(tx, scope, orders);
      if (event)
        for (const order of orders)
          await audit(tx, scope, String(order.orderId), event, {
            actor: "customer",
            subjectType: "exchange_order",
            payload: {
              symbol: order.symbol,
              clientOrderId: order.clientOrderId,
              orderListId: order.orderListId,
              status: order.status,
            },
          });
    });
  }
}

function queueReconcile(
  tx: Transaction,
  scope: AccountScope,
  intentId: string,
) {
  return tx`
    insert into outbox_jobs (customer_id, topic, deduplication_key, payload, available_at)
    values (
      ${scope.customerId}, ${RECONCILE_TOPIC}, ${`${RECONCILE_TOPIC}:${intentId}`},
      ${tx.json({ orderIntentId: intentId })},
      now() + ${`${UNCONFIRMED_GRACE_MS} milliseconds`}::interval
    )
    on conflict (deduplication_key) do nothing
  `;
}

function actorFor(source: IntentSource) {
  return source === "journal_import"
    ? ("system" as const)
    : source === "worker"
      ? ("execution_worker" as const)
      : ("customer" as const);
}

/** Keeps Binance's report of each order, under its intent. */
export async function upsertOrders(
  tx: Transaction,
  scope: AccountScope,
  orders: TestnetOrder[],
) {
  for (const order of orders) {
    // Binance sizes a list's exits only once its entry fills.
    if (new Decimal(order.origQty).isZero()) continue;
    const executed = new Decimal(order.executedQty);
    const averagePrice = executed.isZero()
      ? null
      : new Decimal(order.cummulativeQuoteQty).dividedBy(executed).toFixed();
    const intent =
      protectedLeg(order.clientOrderId)?.listClientOrderId ??
      order.clientOrderId;
    await tx`
      insert into exchange_orders (
        customer_id, order_intent_id, exchange_order_id, client_order_id, status,
        requested_quantity, filled_quantity, average_fill_price
      )
      select ${scope.customerId}, id, ${String(order.orderId)}, ${order.clientOrderId},
        ${order.status}, ${order.origQty}::numeric, ${order.executedQty}::numeric,
        ${averagePrice}::numeric
      from order_intents where idempotency_key = ${intent}
      on conflict (customer_id, client_order_id) do update set
        exchange_order_id = excluded.exchange_order_id,
        status = excluded.status,
        requested_quantity = excluded.requested_quantity,
        filled_quantity = excluded.filled_quantity,
        average_fill_price = excluded.average_fill_price,
        updated_at = now()
    `;
  }
}

export function audit(
  tx: Transaction,
  scope: AccountScope,
  subjectId: string,
  eventType: string,
  {
    actor,
    subjectType = "order_intent",
    payload,
  }: {
    actor: "customer" | "execution_worker" | "system";
    subjectType?: string;
    payload: Record<string, JSONValue>;
  },
) {
  return tx`
    insert into audit_events
      (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
    values (
      ${scope.customerId}, ${actor},
      ${actor === "customer" ? scope.customerId : "execution-worker"},
      ${eventType}, ${subjectType}, ${subjectId},
      ${tx.json({ exchangeAccountId: scope.exchangeAccountId, ...payload })}
    )
  `;
}
