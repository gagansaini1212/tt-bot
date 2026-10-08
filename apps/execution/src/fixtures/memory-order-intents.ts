import { protectedLeg, type TestnetOrder } from "@crypto-trading/exchanges";
import type { AccountScope } from "../accounts";
import {
  clientOrderIdOf,
  type OrderIntent,
  type OrderIntentStore,
  type Settlement,
} from "../order-intents";

/**
 * An in-memory OrderIntentStore for tests of the worker's order logic.
 * order-intents.test.ts proves the PostgreSQL store behaves the same way.
 */
export class MemoryOrderIntents implements OrderIntentStore {
  readonly intents = new Map<string, OrderIntent & { scope: AccountScope }>();
  readonly orders = new Map<string, TestnetOrder>();
  readonly cancelled: TestnetOrder[] = [];

  async record(
    scope: AccountScope,
    order: OrderIntent["order"],
    _source: string,
    createdAt = new Date(),
  ) {
    const clientOrderId = clientOrderIdOf(order);
    if (this.intents.has(clientOrderId)) return false;
    this.intents.set(clientOrderId, {
      scope,
      clientOrderId,
      status: "submitting",
      order: structuredClone(order),
      createdAt,
    });
    return true;
  }

  async settle(
    scope: AccountScope,
    clientOrderId: string,
    settlement: Settlement,
  ) {
    const intent = this.#owned(scope, clientOrderId);
    if (!intent) return;
    const from =
      settlement.status === "acknowledged"
        ? ["submitting", "unknown"]
        : ["submitting"];
    if (from.includes(intent.status)) intent.status = settlement.status;
    if (settlement.status === "acknowledged" && settlement.orders)
      await this.recordOrders(scope, settlement.orders);
  }

  async find(scope: AccountScope, clientOrderId: string) {
    const intent = this.#owned(scope, clientOrderId);
    if (!intent) return undefined;
    const { scope: _owner, ...found } = intent;
    return structuredClone(found);
  }

  async entryPrices(scope: AccountScope, listClientOrderIds: string[]) {
    const prices = new Map<string, string>();
    for (const id of listClientOrderIds) {
      const intent = this.#owned(scope, id);
      if (intent?.order.kind === "protected_entry")
        prices.set(id, intent.order.entry.price);
    }
    return prices;
  }

  async recordOrders(
    scope: AccountScope,
    orders: TestnetOrder[],
    event?: string,
  ) {
    for (const order of orders) {
      if (event) this.cancelled.push(order);
      if (!/[1-9]/.test(order.origQty)) continue;
      const intent =
        protectedLeg(order.clientOrderId)?.listClientOrderId ??
        order.clientOrderId;
      if (this.#owned(scope, intent))
        this.orders.set(order.clientOrderId, order);
    }
  }

  #owned(scope: AccountScope, clientOrderId: string) {
    const intent = this.intents.get(clientOrderId);
    return intent?.scope.customerId === scope.customerId ? intent : undefined;
  }
}
