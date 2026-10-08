import Decimal from "decimal.js";
import { z } from "zod";
import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  limitOrderSchema,
  protectedEntrySchema,
  protectedLeg,
  type TestnetOrder,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";

/** An order a customer entered by hand, exactly as it is sent to Binance. */
export const manualOrderSchema = z.discriminatedUnion("kind", [
  // A dashboard buy with its exits, one Binance order list.
  z.object({ kind: z.literal("protected_entry"), entry: protectedEntrySchema }),
  // A CLI limit order.
  z.object({ kind: z.literal("limit_order"), order: limitOrderSchema }),
]);
export type ManualOrder = z.infer<typeof manualOrderSchema>;

/** The ID Binance knows the order by: the list's for a protected entry. */
export function clientOrderIdOf(order: ManualOrder) {
  return order.kind === "protected_entry"
    ? order.entry.listClientOrderId
    : order.order.clientOrderId;
}

/**
 * - submitting: saved, and being sent. A crash can leave it here.
 * - unknown: sent, but Binance did not confirm whether it took it.
 * - acknowledged: Binance has it.
 * - rejected: Binance refused it, so nothing was placed.
 */
export type OrderIntentStatus =
  "submitting" | "unknown" | "acknowledged" | "rejected";

export type OrderIntent = {
  clientOrderId: string;
  status: OrderIntentStatus;
  order: ManualOrder;
  createdAt: Date;
};

export type Settlement =
  | { status: "acknowledged"; orderListId?: number; orders?: TestnetOrder[] }
  | { status: "rejected" | "unknown"; reason?: string };

export type IntentSource = "dashboard" | "cli" | "journal_import";

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

const SETTLES_FROM: Record<Settlement["status"], OrderIntentStatus[]> = {
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
    const clientOrderId = clientOrderIdOf(manualOrderSchema.parse(order));
    return this.#scoped(scope, async (tx) => {
      const [intent] = await tx<{ id: string }[]>`
        insert into order_intents (
          customer_id, exchange_account_id, idempotency_key, status, manual_order,
          created_at, updated_at
        )
        values (
          ${scope.customerId}, ${scope.exchangeAccountId}, ${clientOrderId},
          'submitting', ${tx.json(order)},
          coalesce(${createdAt ?? null}::timestamptz, now()),
          coalesce(${createdAt ?? null}::timestamptz, now())
        )
        on conflict (idempotency_key) do nothing
        returning id
      `;
      if (!intent) return false;
      await tx`
        insert into outbox_jobs (customer_id, topic, deduplication_key, payload, available_at)
        values (
          ${scope.customerId}, ${RECONCILE_TOPIC}, ${`${RECONCILE_TOPIC}:${intent.id}`},
          ${tx.json({ orderIntentId: intent.id, clientOrderId })},
          now() + ${`${UNCONFIRMED_GRACE_MS} milliseconds`}::interval
        )
      `;
      await audit(tx, scope, intent.id, "order_intent.recorded", {
        actor: source === "journal_import" ? "system" : "customer",
        payload: { source, order },
      });
      return true;
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

async function upsertOrders(
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

function audit(
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
    payload: Record<string, unknown>;
  },
) {
  return tx`
    insert into audit_events
      (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
    values (
      ${scope.customerId}, ${actor},
      ${actor === "customer" ? scope.customerId : "execution-worker"},
      ${eventType}, ${subjectType}, ${subjectId},
      ${tx.json({ exchangeAccountId: scope.exchangeAccountId, ...payload } as never)}
    )
  `;
}
