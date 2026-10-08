import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import Decimal from "decimal.js";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import {
  BinanceTestnetError,
  protectedLegIds,
  type ManualOrderRequest,
} from "@crypto-trading/exchanges";
import type { AccountResolver, AccountScope } from "./accounts";
import { ExecutionLoop } from "./execution-loop";
import { requestEntryExit } from "./execution-store";
import { FakeBinance } from "./fixtures/fake-binance";
import { limit } from "./fixtures/fake-exchange";
import { loadManualTradingConfig, ManualOrderDesk } from "./manual-orders";
import { NOTIFICATION_TOPIC } from "./notifications";
import { PostgresOrderIntents, RECONCILE_TOPIC } from "./order-intents";

const config = (() => {
  const loaded = loadManualTradingConfig({
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
    TESTNET_MAX_ORDER_NOTIONAL_USDT: "100",
    TESTNET_MARKET_MAX_SLIPPAGE_PERCENT: "0.5",
  });
  assert.ok(loaded.ok);
  return loaded.config;
})();

const stopLimit = (
  id: string,
  overrides: Partial<Record<string, string>> = {},
): ManualOrderRequest => ({
  type: "stop_limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  stopPrice: "61000",
  price: "61100",
  takeProfitPrice: "64000",
  stopLossPrice: "59000",
  listClientOrderId: id,
  ...overrides,
});

describe("execution loop", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;

  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  async function addCustomer(): Promise<AccountScope> {
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

  /**
   * A customer, a fake Binance, and a desk and loop for them that share the
   * test database. `restart` builds a new desk and loop on the same state,
   * as a restarted worker would.
   */
  async function world({ lockCustomers = true } = {}) {
    const scope = await addCustomer();
    let offset = 0;
    const now = () => new Date(Date.now() + offset);
    const fake = new FakeBinance(now);
    const intents = new PostgresOrderIntents(database.app);
    const accounts: AccountResolver = async (customerId) =>
      customerId === scope.customerId ? scope : undefined;
    const logs: string[] = [];
    const build = () => {
      const desk = new ManualOrderDesk({
        exchange: fake,
        config,
        intents,
        now,
      });
      const loop = new ExecutionLoop({
        database: database.app,
        exchange: fake,
        accounts,
        intents,
        desk,
        now,
        log: (message) => logs.push(message),
        lockCustomers,
      });
      return { desk, loop };
    };
    let { desk, loop } = build();
    return {
      scope,
      fake,
      intents,
      logs,
      get desk() {
        return desk;
      },
      get loop() {
        return loop;
      },
      build,
      restart() {
        ({ desk, loop } = build());
      },
      pass: () => loop.runPass(),
      advance(ms: number) {
        offset += ms;
      },
      place: (request: ManualOrderRequest) => desk.place(scope, request),
    };
  }

  const reconciliation = async (listClientOrderId: string) => {
    const [row] = await database.admin<
      {
        state: string;
        filled_quantity: string;
        held_quantity: string;
        exit_reason: string | null;
        close_blocked_at: Date | null;
        first_fill_at: Date | null;
        detail: string;
      }[]
    >`
      select r.state, r.filled_quantity::text, r.held_quantity::text, r.exit_reason,
        r.close_blocked_at, r.first_fill_at, r.detail
      from entry_reconciliations r
      join order_intents i on i.id = r.order_intent_id
      where i.idempotency_key = ${listClientOrderId}
    `;
    return row
      ? {
          ...row,
          filled: new Decimal(row.filled_quantity).toFixed(),
          held: new Decimal(row.held_quantity).toFixed(),
        }
      : undefined;
  };
  const notifications = async (scope: AccountScope) =>
    (
      await database.admin<{ kind: string; severity: string; body: string }[]>`
        select kind, severity, body from notifications
        where customer_id = ${scope.customerId}
        order by created_at, id
      `
    ).map(({ kind, severity }) => `${severity}:${kind}`);
  const exits = async (listClientOrderId: string) => [
    ...(await database.admin<
      { idempotency_key: string; status: string; quantity: string }[]
    >`
      select c.idempotency_key, c.status, c.manual_order -> 'order' ->> 'quantity' as quantity
      from order_intents c
      join order_intents e on e.id = c.closes_order_intent_id
      where e.idempotency_key = ${listClientOrderId}
      order by c.created_at
    `),
  ];
  const intentStatus = async (clientOrderId: string) => {
    const [row] = await database.admin<{ status: string }[]>`
      select status from order_intents where idempotency_key = ${clientOrderId}
    `;
    return row?.status;
  };

  /** An entry made from a strategy's proposal, sent as an OPOCO list. */
  async function strategyEntry(
    w: Awaited<ReturnType<typeof world>>,
    listClientOrderId: string,
    holdingPeriodSeconds = 120,
  ) {
    const strategyId = randomUUID();
    const proposalId = randomUUID();
    const { scope } = w;
    await withCustomerScope(database.app, scope.customerId, async (tx) => {
      await tx`
        insert into strategies
          (id, customer_id, exchange_account_id, name, status, current_version)
        values (${strategyId}, ${scope.customerId}, ${scope.exchangeAccountId},
          'AI', 'active', 1)
      `;
      await tx`
        insert into strategy_versions (customer_id, strategy_id, version, rules)
        values (${scope.customerId}, ${strategyId}, 1,
          ${tx.json({ kind: "ai_managed", holdingPeriodSeconds })})
      `;
      await tx`
        insert into trade_proposals (
          id, customer_id, exchange_account_id, strategy_id, strategy_version,
          source_snapshot_id, instrument, market_kind, direction, quantity,
          entry_price, stop_loss_price, take_profit_price, leverage,
          entry_expires_at, rationale, status
        )
        values (
          ${proposalId}, ${scope.customerId}, ${scope.exchangeAccountId},
          ${strategyId}, 1, ${randomUUID()}, 'BTC-USDT', 'spot', 'long', 0.001,
          60000, 58000, 63000, 1, now() + interval '1 hour', 'Test', 'authorized'
        )
      `;
      await tx`
        insert into order_intents (customer_id, proposal_id, idempotency_key, status)
        values (${scope.customerId}, ${proposalId}, ${listClientOrderId}, 'acknowledged')
      `;
    });
    await w.fake.placeProtectedEntry({
      instrument: "BTC-USDT",
      quantity: "0.001",
      price: "60000",
      timeInForce: "GTC",
      takeProfitPrice: "63000",
      stopLossPrice: "58000",
      listClientOrderId,
    });
    return strategyId;
  }

  test("a resting entry is tracked until it fills, is protected, and an exit closes it", async () => {
    const w = await world();
    assert.equal((await w.place(limit("ct_loop_rest"))).status, "working");
    await w.pass();
    assert.equal((await reconciliation("ct_loop_rest"))?.state, "working");

    w.fake.fillEntry("ct_loop_rest", "0.001");
    await w.pass();
    const protectedEntry = await reconciliation("ct_loop_rest");
    assert.equal(protectedEntry?.state, "protected");
    assert.equal(protectedEntry?.filled, "0.001");
    assert.equal(protectedEntry?.held, "0.00099");
    assert.ok(protectedEntry?.first_fill_at);
    // Binance's report of each leg, and the entry's fill with its fee.
    const legs = await database.admin<
      { client_order_id: string; status: string }[]
    >`
      select client_order_id, status from exchange_orders
      where client_order_id like 'ct_loop_rest%' order by client_order_id
    `;
    assert.deepEqual(
      legs.map((leg) => `${leg.client_order_id}:${leg.status}`),
      ["ct_loop_rest_en:FILLED", "ct_loop_rest_sl:NEW", "ct_loop_rest_tp:NEW"],
    );
    const [fill] = await database.admin<
      { fee: string; fee_currency: string }[]
    >`
      select f.fee::text, f.fee_currency from fills f
      join exchange_orders o on o.id = f.exchange_order_id
      where o.client_order_id = 'ct_loop_rest_en'
    `;
    assert.equal(new Decimal(fill.fee).toFixed(), "0.000001");
    assert.equal(fill.fee_currency, "BTC");

    // A protected entry costs no more requests than the open orders.
    const reads = w.fake.count("getOrder");
    await w.pass();
    assert.equal(w.fake.count("getOrder"), reads);

    w.fake.fillExit("ct_loop_rest", "takeProfit");
    await w.pass();
    assert.equal((await reconciliation("ct_loop_rest"))?.state, "closed");
    assert.equal(w.fake.count("placeMarketSell"), 0);
    assert.deepEqual(await notifications(w.scope), []);
    assert.ok(w.loop.lastPassAt(w.scope.customerId));
  });

  test("a filled entry whose exits Binance dropped is sold once, with a loud alert", async () => {
    const w = await world();
    await w.place(limit("ct_loop_drop"));
    w.fake.fillEntry("ct_loop_drop", "0.001", { exits: "drop" });
    await w.pass();

    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.deepEqual(await exits("ct_loop_drop"), [
      {
        idempotency_key: "ct_loop_drop_c1",
        status: "acknowledged",
        quantity: "0.00099",
      },
    ]);
    const closed = await reconciliation("ct_loop_drop");
    assert.equal(closed?.state, "closed");
    assert.equal(closed?.exit_reason, "protection_failed");
    assert.deepEqual(await notifications(w.scope), [
      "critical:protection_failed",
      "info:position_closed",
    ]);
    // Each notification is queued for delivery, such as to a webhook.
    const [{ count }] = await database.admin<{ count: string }[]>`
      select count(*) from outbox_jobs
      where customer_id = ${w.scope.customerId} and topic = ${NOTIFICATION_TOPIC}
    `;
    assert.equal(count, "2");

    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.equal((await notifications(w.scope)).length, 2);
  });

  test("a partly filled entry cancelled outside the worker has its quantity sold", async () => {
    const w = await world();
    await w.place(limit("ct_loop_part"));
    w.fake.fillEntry("ct_loop_part", "0.0004");
    await w.pass();
    const partial = await reconciliation("ct_loop_part");
    assert.equal(partial?.state, "partly_filled");
    assert.equal(partial?.filled, "0.0004");

    w.fake.cancelElsewhere("ct_loop_part");
    await w.pass();
    // What filled, less the fee Binance took in BTC, rounded down to the step.
    assert.deepEqual(
      (await exits("ct_loop_part")).map((exit) => exit.quantity),
      ["0.00039"],
    );
    assert.equal((await reconciliation("ct_loop_part"))?.state, "closed");
    assert.deepEqual(await notifications(w.scope), [
      "critical:protection_failed",
      "info:position_closed",
    ]);
  });

  test("a partly filled entry the customer cancelled from the dashboard is handed over", async () => {
    const w = await world();
    await w.place(limit("ct_loop_hand"));
    w.fake.fillEntry("ct_loop_hand", "0.0004");
    const entry = w.fake.orders.get(protectedLegIds("ct_loop_hand").entry)!;
    const unconfirmed = await w.desk.cancel(w.scope, {
      instrument: "BTC-USDT",
      orderId: entry.orderId,
      acceptUnprotected: false,
    });
    assert.equal(unconfirmed.status, "confirmation_required");
    assert.equal(
      (
        await w.desk.cancel(w.scope, {
          instrument: "BTC-USDT",
          orderId: entry.orderId,
          acceptUnprotected: true,
        })
      ).status,
      "cancelled",
    );
    await w.pass();
    assert.equal((await reconciliation("ct_loop_hand"))?.state, "handed_over");
    assert.equal(w.fake.count("placeMarketSell"), 0);
    assert.deepEqual(await notifications(w.scope), ["warning:handed_over"]);

    // So is a filled entry whose exits the customer cancelled.
    await w.place(limit("ct_loop_hand_exits"));
    w.fake.fillEntry("ct_loop_hand_exits", "0.001");
    await w.pass();
    const takeProfit = w.fake.orders.get(
      protectedLegIds("ct_loop_hand_exits").takeProfit,
    )!;
    const cancel = await w.desk.cancel(w.scope, {
      instrument: "BTC-USDT",
      orderId: takeProfit.orderId,
      acceptUnprotected: true,
    });
    assert.equal(cancel.unprotectedQuantity, "0.00099");
    await w.pass();
    assert.equal(
      (await reconciliation("ct_loop_hand_exits"))?.state,
      "handed_over",
    );
    assert.equal(w.fake.count("placeMarketSell"), 0);
  });

  test("a partly filled entry whose market reaches its stop loss is cancelled and sold", async () => {
    const w = await world();
    await w.place(limit("ct_loop_guard"));
    w.fake.fillEntry("ct_loop_guard", "0.0004");
    w.fake.setPrice("BTC-USDT", "58100");
    await w.pass();
    assert.equal(
      (await reconciliation("ct_loop_guard"))?.state,
      "partly_filled",
    );

    w.fake.setPrice("BTC-USDT", "57900");
    await w.pass();
    assert.equal(w.fake.count("cancelOrderList"), 1);
    const sold = await reconciliation("ct_loop_guard");
    assert.equal(sold?.state, "closed");
    assert.equal(sold?.exit_reason, "stop_loss");
    assert.deepEqual(await notifications(w.scope), [
      "warning:stop_loss_reached",
      "info:position_closed",
    ]);
  });

  test("an unknown outcome is settled from its reconciliation job, never resubmitted", async () => {
    const w = await world();
    // Placed, but the answer and the lookup after it both failed.
    w.fake.entryBehaviour = "unknown_placed";
    w.fake.failNext("getOrderList", new BinanceTestnetError("unavailable"));
    assert.equal((await w.place(limit("ct_loop_known"))).status, "unknown");
    // Not placed at all.
    w.fake.entryBehaviour = "place";
    w.fake.failNext(
      "placeProtectedEntry",
      new BinanceTestnetError("unknown_outcome"),
    );
    assert.equal((await w.place(limit("ct_loop_lost"))).status, "unknown");
    assert.equal(await intentStatus("ct_loop_known"), "unknown");

    // Binance may still be working on them during the grace period.
    await w.pass();
    assert.equal(await intentStatus("ct_loop_known"), "unknown");
    assert.equal(await intentStatus("ct_loop_lost"), "unknown");

    w.advance(61_000);
    w.fake.failNext("getOrderList", new BinanceTestnetError("unavailable"));
    await w.pass();
    // The failed lookup is retried later, with its error kept.
    const jobs = await database.admin<
      {
        idempotency_key: string;
        attempts: number;
        last_error: string | null;
        completed_at: Date | null;
      }[]
    >`
      select i.idempotency_key, j.attempts, j.last_error, j.completed_at
      from outbox_jobs j
      join order_intents i on j.deduplication_key = ${RECONCILE_TOPIC} || ':' || i.id
      where i.customer_id = ${w.scope.customerId}
      order by i.idempotency_key
    `;
    const failed = jobs.filter((job) => job.completed_at === null);
    assert.equal(failed.length, 1);
    assert.match(failed[0].last_error ?? "", /unavailable/);

    w.advance(10 * 60_000);
    await w.pass();
    assert.equal(await intentStatus("ct_loop_known"), "acknowledged");
    assert.equal(await intentStatus("ct_loop_lost"), "rejected");
    assert.equal(w.fake.count("placeProtectedEntry"), 2);
    // The found entry is now reconciled like any other.
    assert.equal((await reconciliation("ct_loop_known"))?.state, "working");
  });

  test("after a restart, a sell saved but never sent is settled before another is tried", async () => {
    const w = await world();
    await w.place(limit("ct_loop_crash"));
    w.fake.fillEntry("ct_loop_crash", "0.001", { exits: "drop" });
    // The worker saved its first sell, then stopped before sending it.
    await w.intents.record(
      w.scope,
      {
        kind: "exit",
        closes: "ct_loop_crash",
        reason: "protection_failed",
        order: {
          instrument: "BTC-USDT",
          quantity: "0.00099",
          clientOrderId: "ct_loop_crash_c1",
        },
      },
      "worker",
    );
    w.restart();
    await w.pass();
    // The unsent sell may still reach Binance, so nothing else is sold yet.
    assert.equal(w.fake.count("placeMarketSell"), 0);
    assert.equal((await reconciliation("ct_loop_crash"))?.state, "unprotected");

    w.advance(61_000);
    await w.pass();
    assert.equal(await intentStatus("ct_loop_crash_c1"), "rejected");
    assert.deepEqual(
      (await exits("ct_loop_crash")).map(
        (exit) => `${exit.idempotency_key}:${exit.status}`,
      ),
      ["ct_loop_crash_c1:rejected", "ct_loop_crash_c2:acknowledged"],
    );
    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.equal((await reconciliation("ct_loop_crash"))?.state, "closed");
  });

  for (const lockCustomers of [true, false])
    test(`two workers at once sell, send and alert once (${lockCustomers ? "with" : "without"} the customer lock)`, async () => {
      const w = await world({ lockCustomers });
      const id = lockCustomers ? "ct_loop_twice" : "ct_loop_twice_nolock";
      await w.place(limit(id));
      await w.place(stopLimit(`${id}_stop`));
      w.fake.fillEntry(id, "0.001", { exits: "drop" });
      w.fake.setPrice("BTC-USDT", "61000");
      const other = w.build();
      await Promise.all([w.pass(), other.loop.runPass()]);
      await Promise.all([w.pass(), other.loop.runPass()]);

      assert.equal(w.fake.count("placeMarketSell"), 1);
      assert.equal(w.fake.count("placeProtectedEntry"), 2);
      assert.deepEqual((await notifications(w.scope)).sort(), [
        "critical:protection_failed",
        "info:position_closed",
        "info:stop_limit_sent",
      ]);
    });

  test("a stop-limit entry waits in the worker, survives a restart, and is sent once its stop trades", async () => {
    const w = await world();
    const held = await w.place(stopLimit("ct_loop_stop"));
    assert.equal(held.status, "held");
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
    assert.equal(await intentStatus("ct_loop_stop"), "pending");
    // It reserves its value until it triggers.
    const ticket = await w.desk.ticket(w.scope);
    assert.equal(new Decimal(ticket.policy.reservedBudget).toFixed(), "61.1");

    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
    w.restart();
    w.fake.setPrice("BTC-USDT", "61000");
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 1);
    assert.equal(await intentStatus("ct_loop_stop"), "acknowledged");
    const list = w.fake.orders.get(protectedLegIds("ct_loop_stop").entry);
    assert.equal(list?.price, "61100");
    assert.deepEqual(await notifications(w.scope), ["info:stop_limit_sent"]);

    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 1);
    assert.equal((await reconciliation("ct_loop_stop"))?.state, "working");

    const state = await w.loop.state(w.scope);
    assert.deepEqual(state.triggers, []);
    assert.equal(state.notifications[0].kind, "stop_limit_sent");
  });

  test("a stop-limit entry that fails the checks when it triggers is not sent", async () => {
    const w = await world();
    await w.place(stopLimit("ct_loop_stop_fail"));
    const state = await w.loop.state(w.scope);
    assert.deepEqual(
      state.triggers.map((trigger) => [
        trigger.listClientOrderId,
        trigger.stopPrice,
      ]),
      [["ct_loop_stop_fail", "61000"]],
    );
    w.fake.balances.get("USDT")!.free = new Decimal(10);
    w.fake.setPrice("BTC-USDT", "61500");
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
    assert.equal(await intentStatus("ct_loop_stop_fail"), "rejected");
    assert.deepEqual(await notifications(w.scope), [
      "warning:stop_limit_failed",
    ]);
  });

  test("a stop-limit entry claimed by a worker that stopped before sending it is rejected, not resent", async () => {
    const w = await world();
    await w.place(stopLimit("ct_loop_stop_crash"));
    assert.ok(await w.intents.claimTrigger(w.scope, "ct_loop_stop_crash"));
    w.restart();
    w.fake.setPrice("BTC-USDT", "61500");
    await w.pass();
    w.advance(61_000);
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
    assert.equal(await intentStatus("ct_loop_stop_crash"), "rejected");
    assert.deepEqual(await notifications(w.scope), [
      "warning:stop_limit_failed",
    ]);
  });

  test("a customer can cancel a stop-limit entry until it triggers", async () => {
    const w = await world();
    await w.place(stopLimit("ct_loop_stop_cancel"));
    assert.equal(
      (await w.desk.cancelTrigger(w.scope, "ct_loop_stop_cancel")).status,
      "cancelled",
    );
    assert.equal(
      (await w.desk.cancelTrigger(w.scope, "ct_loop_stop_cancel")).status,
      "not_open",
    );
    assert.equal(
      (await w.desk.status(w.scope, "ct_loop_stop_cancel")).status,
      "cancelled",
    );
    w.fake.setPrice("BTC-USDT", "62000");
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
  });

  test("a strategy entry's holding deadline starts at its first fill, and it is exited when it passes", async () => {
    const w = await world();
    await strategyEntry(w, "ct_loop_deadline", 120);
    w.fake.fillEntry("ct_loop_deadline", "0.0004");
    const firstFill = Date.now();
    await w.pass();
    w.advance(30_000);
    w.fake.fillEntry("ct_loop_deadline", "0.0006");
    await w.pass();
    assert.equal(
      (await reconciliation("ct_loop_deadline"))?.state,
      "protected",
    );
    const [deadline] = await database.admin<
      { deadline_at: Date; status: string; position_status: string }[]
    >`
      select d.deadline_at, d.status, p.status as position_status
      from holding_deadlines d
      join order_intents i on i.id = d.order_intent_id
      join position_ownership p on p.id = d.position_ownership_id
      where i.idempotency_key = 'ct_loop_deadline'
    `;
    // Later fills do not extend it.
    assert.ok(
      Math.abs(deadline.deadline_at.getTime() - (firstFill + 120_000)) < 5_000,
    );
    assert.equal(deadline.status, "pending");
    assert.equal(deadline.position_status, "open");

    w.advance(95_000);
    await w.pass();
    assert.equal(w.fake.count("cancelOrderList"), 1);
    assert.equal(w.fake.count("placeMarketSell"), 1);
    const exited = await reconciliation("ct_loop_deadline");
    assert.equal(exited?.state, "closed");
    assert.equal(exited?.exit_reason, "holding_deadline");
    const [after] = await database.admin<
      { status: string; position_status: string }[]
    >`
      select d.status, p.status as position_status from holding_deadlines d
      join order_intents i on i.id = d.order_intent_id
      join position_ownership p on p.id = d.position_ownership_id
      where i.idempotency_key = 'ct_loop_deadline'
    `;
    assert.deepEqual(after, { status: "satisfied", position_status: "closed" });
    assert.deepEqual(await notifications(w.scope), [
      "info:holding_deadline_reached",
      "info:position_closed",
    ]);
  });

  test("an exit that cannot sell past its deadline is overdue, alerted, and given up after three tries", async () => {
    const w = await world();
    await strategyEntry(w, "ct_loop_overdue", 60);
    w.fake.fillEntry("ct_loop_overdue", "0.001");
    await w.pass();
    w.fake.sellBehaviour = "reject";
    w.advance(61_000);
    await w.pass();
    assert.equal((await reconciliation("ct_loop_overdue"))?.state, "exiting");
    assert.equal(w.fake.count("placeMarketSell"), 1);

    w.advance(61_000);
    await w.pass();
    let state = await w.loop.state(w.scope);
    assert.equal(state.alerts.length, 1);
    assert.equal(state.alerts[0].listClientOrderId, "ct_loop_overdue");
    assert.ok(state.alerts[0].overdueSince);
    assert.equal(state.alerts[0].heldQuantity, "0.00099");

    await w.pass();
    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 3);
    state = await w.loop.state(w.scope);
    assert.equal(state.alerts[0].closeBlocked, true);
    assert.deepEqual(await notifications(w.scope), [
      "info:holding_deadline_reached",
      "critical:exit_overdue",
      "critical:close_failed",
    ]);
    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 3);

    // The customer sells it on Binance themselves.
    w.fake.balances.set("BTC", {
      free: new Decimal(0),
      locked: new Decimal(0),
    });
    await w.pass();
    assert.equal((await reconciliation("ct_loop_overdue"))?.state, "closed");
    assert.deepEqual((await w.loop.state(w.scope)).alerts, []);
    assert.equal((await notifications(w.scope)).at(-1), "info:position_closed");
  });

  test("protection failure on a strategy entry pauses its strategy", async () => {
    const w = await world();
    const strategyId = await strategyEntry(w, "ct_loop_pause");
    w.fake.fillEntry("ct_loop_pause", "0.001", { exits: "drop" });
    await w.pass();
    const [strategy] = await database.admin<{ status: string }[]>`
      select status from strategies where id = ${strategyId}
    `;
    assert.equal(strategy.status, "paused");
    const [event] = await database.admin<{ event_type: string }[]>`
      select event_type from audit_events
      where subject_type = 'strategy' and subject_id = ${strategyId}
    `;
    assert.equal(event.event_type, "strategy.paused");
  });

  test("a requested exit cancels the entry's orders and sells what it holds", async () => {
    const w = await world();
    await w.place(limit("ct_loop_request"));
    w.fake.fillEntry("ct_loop_request", "0.001");
    await w.pass();
    const [{ id }] = await database.admin<{ id: string }[]>`
      select id from order_intents where idempotency_key = 'ct_loop_request'
    `;
    assert.equal(
      await requestEntryExit(database.app, w.scope, id, "close_all"),
      true,
    );
    // Another customer cannot request it.
    const stranger = await addCustomer();
    assert.equal(
      await requestEntryExit(database.app, stranger, id, "close_all"),
      false,
    );
    await w.pass();
    const closed = await reconciliation("ct_loop_request");
    assert.equal(closed?.state, "closed");
    assert.equal(closed?.exit_reason, "close_all");
    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.equal(
      await requestEntryExit(database.app, w.scope, id, "close_all"),
      false,
    );
  });

  test("an entry Binance no longer knows, as after a testnet reset, is reported once", async () => {
    const w = await world();
    await w.place(limit("ct_loop_reset"));
    await w.pass();
    w.fake.reset();
    await w.pass();
    await w.pass();
    assert.equal((await reconciliation("ct_loop_reset"))?.state, "missing");
    assert.deepEqual(await notifications(w.scope), ["warning:order_missing"]);
  });

  test("a customer's loop reads and writes only their own records", async () => {
    const w = await world();
    const other = await world();
    await w.place(limit("ct_loop_mine"));
    w.fake.fillEntry("ct_loop_mine", "0.001", { exits: "drop" });
    await other.pass();
    assert.equal(await reconciliation("ct_loop_mine"), undefined);
    await w.pass();
    assert.deepEqual(await notifications(other.scope), []);
    assert.deepEqual((await other.loop.state(other.scope)).alerts, []);
  });
});
