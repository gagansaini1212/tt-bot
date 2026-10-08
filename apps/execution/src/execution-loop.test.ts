import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
import { requestEntryExit, stopStrategyEntries } from "./execution-store";
import { FakeBinance } from "./fixtures/fake-binance";
import { limit, market } from "./fixtures/fake-exchange";
import { loadManualTradingConfig, ManualOrderDesk } from "./manual-orders";
import { PostgresOrderIntents, RECONCILE_TOPIC } from "./order-intents";
import { NotificationWebhooks, WEBHOOK_TOPIC } from "./notification-webhooks";
import { PostgresRiskLimits } from "./risk-limits";
import { SecretBox } from "./secret-box";
import {
  PostgresTradeProposals,
  proposalClientOrderId,
} from "./trade-proposals";

const config = (() => {
  const loaded = loadManualTradingConfig({
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
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
  async function world({
    lockCustomers = true,
    webhooks,
  }: { lockCustomers?: boolean; webhooks?: NotificationWebhooks } = {}) {
    const scope = await addCustomer();
    let offset = 0;
    const now = () => new Date(Date.now() + offset);
    const fake = new FakeBinance(now);
    const intents = new PostgresOrderIntents(database.app);
    const proposals = new PostgresTradeProposals(database.app);
    const risk = new PostgresRiskLimits(database.app);
    await risk.change(
      scope,
      {
        maxOrderNotional: "100",
        maxDailyRisk: "1000",
        defaultStopLossPercent: "2",
      },
      0,
    );
    const accounts: AccountResolver = async (customerId) =>
      customerId === scope.customerId ? scope : undefined;
    const logs: string[] = [];
    const build = () => {
      const desk = new ManualOrderDesk({
        exchange: fake,
        config,
        intents,
        proposals,
        risk,
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
        webhooks,
      });
      return { desk, loop };
    };
    let { desk, loop } = build();
    return {
      scope,
      fake,
      intents,
      proposals,
      risk,
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

  test("every alert the loop raises is posted to the customer's webhook exactly once", async () => {
    const posts: string[] = [];
    const webhooks = new NotificationWebhooks({
      database: database.app,
      box: new SecretBox(randomBytes(32)),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)).content);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const w = await world({ webhooks });
    await webhooks.save(
      w.scope.customerId,
      `https://discord.com/api/webhooks/123456789012345678/${"T".repeat(68)}`,
    );
    await w.place(limit("ct_loop_hook"));
    w.fake.fillEntry("ct_loop_hook", "0.001", { exits: "drop" });
    await w.pass();
    // Due by PostgreSQL's clock, which may be a little ahead of this one.
    w.advance(5_000);
    await w.loop.deliverAlerts();
    await w.loop.deliverAlerts();
    assert.deepEqual(await notifications(w.scope), [
      "critical:protection_failed",
      "info:position_closed",
    ]);
    // One post for each, in any order.
    assert.deepEqual(posts.map((post) => post.split(":")[0]).sort(), [
      "**Critical",
      "**Info",
    ]);
    // Later passes and rounds post nothing again.
    await w.pass();
    await w.loop.deliverAlerts();
    assert.equal(posts.length, 2);
    const jobs = await database.admin<{ completed: boolean }[]>`
      select completed_at is not null as completed from outbox_jobs
      where customer_id = ${w.scope.customerId} and topic = ${WEBHOOK_TOPIC}
    `;
    assert.deepEqual(
      jobs.map((job) => job.completed),
      [true, true],
    );
  });

  test("exits are never held back by the risk limits", async () => {
    const w = await world();
    await w.place(limit("ct_loop_exit_risk"));
    // Far below what the entry risks: new entries would be refused.
    await w.risk.change(
      w.scope,
      {
        maxOrderNotional: "1",
        maxDailyRisk: "0.01",
        defaultStopLossPercent: "2",
      },
      1,
    );
    w.fake.fillEntry("ct_loop_exit_risk", "0.001", { exits: "drop" });
    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.equal((await reconciliation("ct_loop_exit_risk"))?.state, "closed");
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
    // The sale's fill is kept, although it closed the entry in the same pass.
    const [sold] = await database.admin<{ quantity: string }[]>`
      select f.quantity::text from fills f
      join exchange_orders o on o.id = f.exchange_order_id
      where o.client_order_id = 'ct_loop_drop_c1'
    `;
    assert.equal(new Decimal(sold.quantity).toFixed(), "0.00099");
    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.equal((await notifications(w.scope)).length, 2);
  });

  test("an approved assistant proposal is watched like a dashboard entry, and its unprotected quantity is sold", async () => {
    const w = await world();
    const decision = await w.proposals.record(
      w.scope,
      {
        kind: "trade_proposal",
        proposal: {
          instrument: "BTC-USDT",
          marketKind: "spot",
          direction: "long",
          quantity: "0.001",
          entryPrice: "59900",
          stopLossPrice: "58000",
          takeProfitPrice: "63000",
          leverage: 1,
          entryExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        model: "test-model",
        promptVersion: "test",
        sourceSnapshotId: randomUUID(),
        rationale: "Support held.",
        idempotencyKey: `loop:${randomUUID()}`,
      },
      new Date(),
    );
    const id = decision.proposal!.id;
    const listId = proposalClientOrderId(id);
    assert.equal((await w.desk.approve(w.scope, id)).status, "working");
    await w.pass();
    assert.equal((await reconciliation(listId))?.state, "working");
    let view = await w.proposals.view(w.scope, id, new Date());
    assert.equal(view?.status, "submitted");
    assert.equal(view?.order?.reconciliation?.state, "working");

    w.fake.fillEntry(listId, "0.001", { exits: "drop" });
    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 1);
    assert.deepEqual(
      (await exits(listId)).map((exit) => exit.status),
      ["acknowledged"],
    );
    const closed = await reconciliation(listId);
    assert.equal(closed?.state, "closed");
    assert.equal(closed?.exit_reason, "protection_failed");
    assert.deepEqual(await notifications(w.scope), [
      "critical:protection_failed",
      "info:position_closed",
    ]);
    view = await w.proposals.view(w.scope, id, new Date());
    assert.equal(view?.status, "filled");
    assert.equal(view?.order?.reconciliation?.state, "closed");
    assert.ok(view?.order?.reconciliation?.detail);
    // It belongs to no strategy: no holding deadline, nothing to pause.
    const [{ count }] = await database.admin<{ count: string }[]>`
      select count(*) from holding_deadlines d
      join order_intents i on i.id = d.order_intent_id
      where i.idempotency_key = ${listId}
    `;
    assert.equal(count, "0");
    await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 1);
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

  test("a stop-limit entry meets the latest risk limits when it triggers, counting its own risk once", async () => {
    const w = await world();
    // Each risks 0.001 × (61100 − 59000) = 2.1 at its stop.
    await w.place(stopLimit("ct_loop_risk_a"));
    await w.place(stopLimit("ct_loop_risk_b"));
    await w.place(stopLimit("ct_loop_risk_c"));
    // Lowered while they are held: room for two, not three.
    await w.risk.change(
      w.scope,
      {
        maxOrderNotional: "100",
        maxDailyRisk: "4.2",
        defaultStopLossPercent: "2",
      },
      1,
    );
    // Held entries count, so a third, placed now, is refused at once.
    const refused = await w.place(stopLimit("ct_loop_risk_d"));
    assert.equal(refused.status, "rejected");
    w.fake.setPrice("BTC-USDT", "61000");
    await w.pass();
    // The first to trigger still sees the other two held, all three over
    // the limit, and is rejected unsent. The other two then fit exactly:
    // each counts its own risk once, not twice.
    assert.equal(w.fake.count("placeProtectedEntry"), 2);
    const statuses = await Promise.all(
      ["a", "b", "c"].map((id) => intentStatus(`ct_loop_risk_${id}`)),
    );
    assert.deepEqual(statuses.sort(), [
      "acknowledged",
      "acknowledged",
      "rejected",
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

  test("an exit that cannot sell past its deadline is unprotected, overdue, alerted, and given up after three tries", async () => {
    const w = await world();
    const strategyId = await strategyEntry(w, "ct_loop_overdue", 60);
    w.fake.fillEntry("ct_loop_overdue", "0.001");
    await w.pass();
    w.fake.sellBehaviour = "reject";
    w.advance(61_000);
    await w.pass();
    // Its exits are cancelled and the sale was refused, so nothing protects
    // it: a protection failure, which pauses the strategy.
    assert.equal(
      (await reconciliation("ct_loop_overdue"))?.state,
      "unprotected",
    );
    assert.equal(w.fake.count("placeMarketSell"), 1);
    const [strategy] = await database.admin<{ status: string }[]>`
      select status from strategies where id = ${strategyId}
    `;
    assert.equal(strategy.status, "paused");

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
      "critical:protection_failed",
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

  test("exits Binance rejected, or has not placed a minute after the fill, leave the entry unprotected", async () => {
    const w = await world();
    await w.place(limit("ct_loop_rejected"));
    w.fake.fillEntry("ct_loop_rejected", "0.001", { exits: "reject" });
    await w.pass();
    assert.equal((await reconciliation("ct_loop_rejected"))?.state, "closed");
    // Unsized, so it sells what the entry received less the fee.
    assert.deepEqual(
      (await exits("ct_loop_rejected")).map((exit) => exit.quantity),
      ["0.00099"],
    );

    await w.place(limit("ct_loop_pending"));
    w.fake.fillEntry("ct_loop_pending", "0.001", { exits: "pending" });
    await w.pass();
    assert.equal(
      (await reconciliation("ct_loop_pending"))?.state,
      "awaiting_exits",
    );
    w.advance(61_000);
    await w.pass();
    // Its list is still open, so it is cancelled before the sale.
    assert.equal(w.fake.count("cancelOrderList"), 1);
    assert.equal((await reconciliation("ct_loop_pending"))?.state, "closed");
    assert.deepEqual(await notifications(w.scope), [
      "critical:protection_failed",
      "info:position_closed",
      "critical:protection_failed",
      "info:position_closed",
    ]);
  });

  test("an entry that filled when it was placed has its fills and first fill kept", async () => {
    const w = await world();
    w.fake.entryBehaviour = "fill_now";
    assert.equal((await w.place(market("ct_loop_fok"))).status, "protected");
    w.advance(30_000);
    await w.pass();
    const entry = await reconciliation("ct_loop_fok");
    assert.equal(entry?.state, "protected");
    // The fill's own time, not the pass's.
    assert.ok(Date.now() - entry!.first_fill_at!.getTime() < 10_000);
    const [{ count }] = await database.admin<{ count: string }[]>`
      select count(*) from fills f
      join exchange_orders o on o.id = f.exchange_order_id
      where o.client_order_id = 'ct_loop_fok_en'
    `;
    assert.equal(count, "1");
  });

  test("a stop-limit entry the worker could not check when it triggered is held again", async () => {
    const w = await world();
    await w.place(stopLimit("ct_loop_stop_retry"));
    w.fake.setPrice("BTC-USDT", "61500");
    w.fake.failNext("getAccount", new BinanceTestnetError("unavailable"));
    await w.pass();
    assert.equal(await intentStatus("ct_loop_stop_retry"), "pending");
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
    assert.ok(w.logs.some((line) => line.includes("ct_loop_stop_retry")));
    await w.pass();
    assert.equal(await intentStatus("ct_loop_stop_retry"), "acknowledged");
    assert.equal(w.fake.count("placeProtectedEntry"), 1);
    // Held again, its reconciliation was not left due to reject it.
    w.advance(61_000);
    await w.pass();
    assert.equal(await intentStatus("ct_loop_stop_retry"), "acknowledged");
  });

  test("more filled than the customer accepted leaving bare is sold, not handed over", async () => {
    const w = await world();
    await w.place(limit("ct_loop_accepted"));
    w.fake.fillEntry("ct_loop_accepted", "0.0004");
    // The customer confirmed leaving 0.0004 bare, but the entry filled
    // completely before the cancel reached Binance.
    await w.intents.noteCustomerCancel(w.scope, "ct_loop_accepted", "0.0004");
    w.fake.fillEntry("ct_loop_accepted", "0.0006");
    w.fake.cancelElsewhere("ct_loop_accepted");
    await w.pass();
    const sold = await reconciliation("ct_loop_accepted");
    assert.equal(sold?.state, "closed");
    assert.equal(sold?.exit_reason, "protection_failed");
  });

  test("sells refused only for a rate limit do not count towards giving up", async () => {
    const w = await world();
    await w.place(limit("ct_loop_limited"));
    w.fake.fillEntry("ct_loop_limited", "0.001", { exits: "drop" });
    w.fake.sellBehaviour = "rate_limited";
    for (let pass = 0; pass < 4; pass++) await w.pass();
    assert.equal(w.fake.count("placeMarketSell"), 4);
    const limited = await reconciliation("ct_loop_limited");
    assert.equal(limited?.state, "unprotected");
    assert.equal(limited?.close_blocked_at, null);
    w.fake.sellBehaviour = "fill";
    await w.pass();
    assert.equal((await reconciliation("ct_loop_limited"))?.state, "closed");
    assert.deepEqual(await notifications(w.scope), [
      "critical:protection_failed",
      "info:position_closed",
    ]);
  });

  test("pausing a strategy cancels its pending entries and keeps the exits of filled ones; close all sells them", async () => {
    const w = await world();
    const strategyId = await strategyEntry(w, "ct_loop_pause_filled");
    w.fake.fillEntry("ct_loop_pause_filled", "0.001");
    await withCustomerScope(database.app, w.scope.customerId, async (tx) => {
      const [proposal] = await tx<{ id: string }[]>`
        insert into trade_proposals (
          id, customer_id, exchange_account_id, strategy_id, strategy_version,
          source_snapshot_id, instrument, market_kind, direction, quantity,
          entry_price, stop_loss_price, take_profit_price, leverage,
          entry_expires_at, rationale, status
        )
        values (
          ${randomUUID()}, ${w.scope.customerId}, ${w.scope.exchangeAccountId},
          ${strategyId}, 1, ${randomUUID()}, 'BTC-USDT', 'spot', 'long', 0.001,
          59000, 58000, 63000, 1, now() + interval '1 hour', 'Test', 'authorized'
        )
        returning id
      `;
      await tx`
        insert into order_intents (customer_id, proposal_id, idempotency_key, status)
        values (${w.scope.customerId}, ${proposal.id}, 'ct_loop_pause_open', 'acknowledged')
      `;
    });
    await w.fake.placeProtectedEntry({
      instrument: "BTC-USDT",
      quantity: "0.001",
      price: "59000",
      timeInForce: "GTC",
      takeProfitPrice: "63000",
      stopLossPrice: "58000",
      listClientOrderId: "ct_loop_pause_open",
    });
    await w.pass();
    assert.equal(
      (await stopStrategyEntries(database.app, w.scope, strategyId, "pause"))
        .length,
      2,
    );
    await w.pass();
    assert.equal(
      (await reconciliation("ct_loop_pause_open"))?.state,
      "not_filled",
    );
    assert.equal(
      (await reconciliation("ct_loop_pause_filled"))?.state,
      "protected",
    );
    assert.equal(w.fake.count("placeMarketSell"), 0);

    await stopStrategyEntries(database.app, w.scope, strategyId, "close_all");
    await w.pass();
    const closed = await reconciliation("ct_loop_pause_filled");
    assert.equal(closed?.state, "closed");
    assert.equal(closed?.exit_reason, "close_all");
    assert.equal(w.fake.count("placeMarketSell"), 1);
  });
});
