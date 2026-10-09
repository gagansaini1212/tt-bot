import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import type { ExchangeOrder } from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import { deskFixture, limit } from "./fixtures/fake-exchange";
import {
  PostgresOrderIntents,
  RECONCILE_TOPIC,
  type ManualOrder,
} from "./order-intents";

const entry = (listClientOrderId: string): ManualOrder => ({
  kind: "protected_entry",
  entry: {
    instrument: "BTC-USDT",
    quantity: "0.001",
    price: "60000.5",
    timeInForce: "GTC",
    takeProfitPrice: "63000",
    stopLossPrice: "58000",
    listClientOrderId,
  },
});

const leg = (clientOrderId: string, fields: Partial<ExchangeOrder> = {}) =>
  ({
    instrument: "BTC-USDT",
    orderId: "41",
    clientOrderId,
    price: "60000.5",
    origQty: "0.001",
    executedQty: "0",
    cumulativeQuoteQty: "0",
    status: "NEW",
    type: "LIMIT",
    side: "BUY",
    orderListId: "9",
    ...fields,
  }) satisfies ExchangeOrder;

describe("order intents in PostgreSQL", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  let intents: PostgresOrderIntents;
  let mine: AccountScope;
  let theirs: AccountScope;

  async function customer(): Promise<AccountScope> {
    const scope = { customerId: randomUUID(), exchangeAccountId: randomUUID() };
    await withCustomerScope(database.app, scope.customerId, async (tx) => {
      await tx`insert into customers (id, display_name) values (${scope.customerId}, 'Test')`;
      await tx`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status)
        values (${scope.exchangeAccountId}, ${scope.customerId},
          'binance-spot-testnet', 'Testnet', 'simulation', 'USDT', 'connected')
      `;
    });
    return scope;
  }

  const row = async (clientOrderId: string) => {
    const [intent] = await database.admin<
      {
        id: string;
        customer_id: string;
        status: string;
        completed_at: Date | null;
        available_at: Date;
        created_at: Date;
        last_error: string | null;
      }[]
    >`
      select i.id, i.customer_id, i.status, i.created_at,
        j.completed_at, j.available_at, j.last_error
      from order_intents i
      join outbox_jobs j on j.deduplication_key = ${RECONCILE_TOPIC} || ':' || i.id
      where i.idempotency_key = ${clientOrderId}
    `;
    return intent;
  };
  const events = async (clientOrderId: string) =>
    (
      await database.admin<{ event_type: string }[]>`
        select a.event_type from audit_events a
        join order_intents i on a.subject_id = i.id::text
        where i.idempotency_key = ${clientOrderId}
        order by a.occurred_at, a.event_type
      `
    ).map(({ event_type }) => event_type);

  before(async () => {
    database = await createTestDatabase();
    intents = new PostgresOrderIntents(database.app);
    mine = await customer();
    theirs = await customer();
  });
  after(() => database?.drop());

  test("an intent is saved once, with a reconciliation job and an audit event", async () => {
    assert.equal(
      await intents.record(mine, entry("ct_pg_once"), "dashboard"),
      true,
    );
    assert.equal(
      await intents.record(mine, entry("ct_pg_once"), "dashboard"),
      false,
    );
    // Client order IDs are never reused, even by another customer.
    assert.equal(
      await intents.record(theirs, entry("ct_pg_once"), "dashboard"),
      false,
    );
    const saved = await row("ct_pg_once");
    assert.equal(saved.customer_id, mine.customerId);
    assert.equal(saved.status, "submitting");
    assert.equal(saved.completed_at, null);
    // Due once Binance has had time to finish an unconfirmed submission.
    assert.ok(
      saved.available_at.getTime() - saved.created_at.getTime() >= 59_000,
    );
    assert.deepEqual(await events("ct_pg_once"), ["order_intent.recorded"]);
  });

  test("lookups go by client order ID, in the owner's scope only", async () => {
    await intents.record(mine, entry("ct_pg_lookup"), "dashboard");
    const found = await intents.find(mine, "ct_pg_lookup");
    assert.equal(found?.status, "submitting");
    assert.deepEqual(found?.order, entry("ct_pg_lookup"));
    assert.equal(await intents.find(theirs, "ct_pg_lookup"), undefined);
    assert.deepEqual(
      await intents.entryPrices(mine, ["ct_pg_lookup", "ct_pg_missing"]),
      new Map([["ct_pg_lookup", "60000.5"]]),
    );
    assert.deepEqual(
      await intents.entryPrices(theirs, ["ct_pg_lookup"]),
      new Map(),
    );
  });

  test("an unknown outcome stays unknown until Binance confirms the order", async () => {
    await intents.record(mine, entry("ct_pg_unknown"), "dashboard");
    await intents.settle(mine, "ct_pg_unknown", { status: "unknown" });
    let saved = await row("ct_pg_unknown");
    assert.equal(saved.status, "unknown");
    assert.equal(saved.completed_at, null);
    assert.match(saved.last_error ?? "", /did not confirm/);
    // Neither a refusal nor a repeat can turn it into something else.
    await intents.settle(mine, "ct_pg_unknown", { status: "rejected" });
    await intents.settle(mine, "ct_pg_unknown", { status: "unknown" });
    assert.equal((await row("ct_pg_unknown")).status, "unknown");
    // Another customer cannot settle it.
    await intents.settle(theirs, "ct_pg_unknown", { status: "acknowledged" });
    assert.equal((await row("ct_pg_unknown")).status, "unknown");

    await intents.settle(mine, "ct_pg_unknown", {
      status: "acknowledged",
      orderListId: "9",
    });
    saved = await row("ct_pg_unknown");
    assert.equal(saved.status, "acknowledged");
    assert.ok(saved.completed_at);
    await intents.settle(mine, "ct_pg_unknown", { status: "unknown" });
    assert.equal((await row("ct_pg_unknown")).status, "acknowledged");
    assert.deepEqual(await events("ct_pg_unknown"), [
      "order_intent.recorded",
      "order_intent.unknown",
      "order_intent.acknowledged",
    ]);
  });

  test("Binance's report of each leg is kept, once each leg has a quantity", async () => {
    await intents.record(mine, entry("ct_pg_legs"), "dashboard");
    await intents.settle(mine, "ct_pg_legs", {
      status: "acknowledged",
      orderListId: "9",
      orders: [
        leg("ct_pg_legs_en"),
        // Binance sizes the exits only once the entry fills.
        leg("ct_pg_legs_tp", { orderId: "42", origQty: "0", side: "SELL" }),
        // Not this application's order.
        leg("manual_web_order", { orderId: "43" }),
      ],
    });
    await intents.recordOrders(
      mine,
      [
        leg("ct_pg_legs_en", {
          status: "FILLED",
          executedQty: "0.001",
          cumulativeQuoteQty: "60.0003",
        }),
        leg("ct_pg_legs_tp", {
          orderId: "42",
          origQty: "0.00099",
          side: "SELL",
        }),
      ],
      "order.cancelled",
    );
    const orders = await database.admin`
      select client_order_id, exchange_order_id, status, requested_quantity,
        filled_quantity, average_fill_price
      from exchange_orders order by client_order_id
    `;
    assert.deepEqual(
      orders.map((order) => ({ ...order })),
      [
        {
          client_order_id: "ct_pg_legs_en",
          exchange_order_id: "41",
          status: "FILLED",
          requested_quantity: "0.001000000000000000",
          filled_quantity: "0.001000000000000000",
          average_fill_price: "60000.300000000000000000",
        },
        {
          client_order_id: "ct_pg_legs_tp",
          exchange_order_id: "42",
          status: "NEW",
          requested_quantity: "0.000990000000000000",
          filled_quantity: "0.000000000000000000",
          average_fill_price: null,
        },
      ],
    );
    const cancels = await database.admin`
      select subject_type, subject_id from audit_events
      where event_type = 'order.cancelled' order by subject_id
    `;
    assert.deepEqual(
      cancels.map((event) => ({ ...event })),
      [
        { subject_type: "exchange_order", subject_id: "41" },
        { subject_type: "exchange_order", subject_id: "42" },
      ],
    );
  });

  test("the desk commits the intent before it calls Binance and holds no transaction while it waits", async () => {
    let release!: () => void;
    const fixture = deskFixture({
      intents,
      scope: mine,
      gate: new Promise((done) => (release = done)),
    });
    const placing = fixture.desk.place(limit("ct_pg_desk"));
    while (!fixture.calls.place)
      await new Promise((done) => setTimeout(done, 5));
    // Binance has the request. Another connection already sees the intent.
    assert.equal((await row("ct_pg_desk")).status, "submitting");
    const [{ role }] = await database.app<
      { role: string }[]
    >`select current_user as role`;
    const waiting = await database.admin`
      select state from pg_stat_activity
      where usename = ${role} and state like 'idle in transaction%'
    `;
    assert.equal(waiting.length, 0);
    release();
    assert.equal((await placing).status, "working");
    const settled = await row("ct_pg_desk");
    assert.equal(settled.status, "acknowledged");
    assert.ok(settled.completed_at);
    assert.equal(fixture.calls.place, 1);
    assert.equal(
      (await fixture.desk.place(limit("ct_pg_desk"))).status,
      "duplicate",
    );
    assert.equal(fixture.calls.place, 1);
  });

  test("the desk leaves an unconfirmed order unknown and never resubmits it", async () => {
    const fixture = deskFixture({
      behaviour: "timeout_not_placed",
      intents,
      scope: mine,
    });
    assert.equal(
      (await fixture.desk.place(limit("ct_pg_lost"))).status,
      "unknown",
    );
    fixture.advance(61_000);
    assert.equal((await fixture.desk.status("ct_pg_lost")).status, "not_found");
    const saved = await row("ct_pg_lost");
    assert.equal(saved.status, "unknown");
    assert.equal(saved.completed_at, null);
    assert.equal(
      (await fixture.desk.place(limit("ct_pg_lost"))).status,
      "duplicate",
    );
    assert.equal(fixture.calls.place, 1);
  });

  test("an intent's key can never also name another order's leg or close", async () => {
    // A key ending like a leg or close ID could name another entry's order,
    // on another account or venue alike.
    for (const id of [
      "ct_iso_key_en",
      "ct_iso_key_tp",
      "ct_iso_key_sl",
      "ct_iso_key_c1",
    ])
      await assert.rejects(
        intents.record(mine, entry(id), "dashboard"),
        /ends like a leg or close ID/,
        id,
      );
    // The database refuses it too, whoever writes it.
    await assert.rejects(
      withCustomerScope(
        database.app,
        mine.customerId,
        (tx) => tx`
          insert into order_intents
            (customer_id, exchange_account_id, idempotency_key, status, manual_order)
          values (${mine.customerId}, ${mine.exchangeAccountId}, 'ct_raw_tp',
            'submitting', ${tx.json(entry("ct_raw_tp"))})
        `,
      ),
      /order intent's key may not end like a leg or exit ID/,
    );
    // An exit is keyed by the entry it closes, on the same account.
    assert.ok(await intents.record(mine, entry("ct_iso_closed"), "dashboard"));
    const exit = (closes: string, clientOrderId: string): ManualOrder => ({
      kind: "exit",
      closes,
      reason: "holding_deadline",
      order: { instrument: "BTC-USDT", quantity: "0.001", clientOrderId },
    });
    await assert.rejects(
      intents.record(mine, exit("ct_iso_closed", "ct_iso_other_c1"), "worker"),
      /ends like a leg or close ID/,
    );
    // Another account cannot close it, even with the right key.
    await assert.rejects(
      intents.record(
        { ...mine, exchangeAccountId: theirs.exchangeAccountId },
        exit("ct_iso_closed", "ct_iso_closed_c1"),
        "worker",
      ),
      /exit's key is the key of the entry it closes, on the same exchange account/,
    );
    assert.ok(
      await intents.record(
        mine,
        exit("ct_iso_closed", "ct_iso_closed_c1"),
        "worker",
      ),
    );
  });

  test("an account's intents and orders are its own, though one customer owns both accounts", async () => {
    const other = { ...mine, exchangeAccountId: randomUUID() };
    await withCustomerScope(
      database.app,
      mine.customerId,
      (tx) => tx`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status)
        values (${other.exchangeAccountId}, ${mine.customerId},
          'binance-spot-testnet', 'Second testnet', 'simulation', 'USDT', 'connected')
      `,
    );
    assert.ok(await intents.record(mine, entry("ct_iso_mine"), "dashboard"));
    // The other account's venue reports an order with this entry's leg ID,
    // such as one placed there by hand: it is not this entry's.
    await intents.recordOrders(other, [leg("ct_iso_mine_en")]);
    await intents.settle(other, "ct_iso_mine", { status: "rejected" });
    assert.equal(await intents.find(other, "ct_iso_mine"), undefined);
    assert.equal(await intents.cancelTrigger(other, "ct_iso_mine"), false);
    const orders = await database.admin`
      select o.client_order_id from exchange_orders o
      join order_intents i on i.id = o.order_intent_id
      where i.idempotency_key = 'ct_iso_mine'
    `;
    assert.equal(orders.length, 0);
    assert.equal((await row("ct_iso_mine")).status, "submitting");
    // Its own account records it.
    await intents.recordOrders(mine, [leg("ct_iso_mine_en")]);
    assert.equal(
      (
        await database.admin`
          select 1 from exchange_orders where client_order_id = 'ct_iso_mine_en'
        `
      ).length,
      1,
    );
  });
});
