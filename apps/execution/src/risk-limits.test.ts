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
import { PostgresOrderIntents, type ManualOrder } from "./order-intents";
import {
  PLATFORM_RISK_MAXIMUMS,
  PostgresRiskLimits,
  riskLimitIssues,
  withinPlatformMaximums,
} from "./risk-limits";

const limits = {
  maxOrderNotional: "100",
  maxDailyRisk: "20",
  defaultStopLossPercent: "2",
};

test("limits above the platform maximums are refused, and lowered when read", () => {
  assert.deepEqual(riskLimitIssues(limits), []);
  assert.deepEqual(riskLimitIssues(PLATFORM_RISK_MAXIMUMS), []);
  assert.equal(
    riskLimitIssues({ ...limits, maxOrderNotional: "1000.01" }).length,
    1,
  );
  assert.equal(riskLimitIssues({ ...limits, maxDailyRisk: "5000" }).length, 1);
  assert.match(
    riskLimitIssues({ ...limits, defaultStopLossPercent: "0.05" })[0],
    /from 0.1% to 50%/,
  );
  assert.equal(
    riskLimitIssues({ ...limits, defaultStopLossPercent: "51" }).length,
    1,
  );
  assert.deepEqual(
    withinPlatformMaximums({
      maxOrderNotional: "2500",
      maxDailyRisk: "10",
      defaultStopLossPercent: "75",
    }),
    {
      maxOrderNotional: "1000",
      maxDailyRisk: "10",
      defaultStopLossPercent: "50",
    },
  );
});

describe("risk limits in PostgreSQL", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  let store: PostgresRiskLimits;

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

  before(async () => {
    database = await createTestDatabase();
    store = new PostgresRiskLimits(database.app);
  });
  after(() => database?.drop());

  test("each change adds a version from the one it edited, and is audited", async () => {
    const mine = await customer();
    assert.equal(await store.current(mine), undefined);
    const first = await store.change(mine, limits, 0);
    assert.equal(first.status, "saved");
    const second = await store.change(
      mine,
      { ...limits, maxOrderNotional: "250.5" },
      1,
    );
    assert.equal(second.status, "saved");
    const current = await store.current(mine);
    assert.equal(current?.version, 2);
    assert.equal(current?.maxOrderNotional, "250.5");
    assert.equal(current?.defaultStopLossPercent, "2");

    // Saved from a stale version: refused, and nothing changes.
    const stale = await store.change(mine, { ...limits, maxDailyRisk: "1" }, 1);
    assert.equal(stale.status, "conflict");
    assert.equal(stale.status === "conflict" && stale.current?.version, 2);
    assert.equal((await store.current(mine))?.maxDailyRisk, "20");

    const events = await database.admin<
      { event_type: string; payload: { version: number; previous: unknown } }[]
    >`
      select event_type, payload from audit_events
      where customer_id = ${mine.customerId} order by occurred_at, payload->>'version'
    `;
    assert.deepEqual(
      events.map((event) => [event.event_type, event.payload.version]),
      [
        ["risk_limits.changed", 1],
        ["risk_limits.changed", 2],
      ],
    );
    assert.equal(events[0].payload.previous, null);
    assert.deepEqual(events[1].payload.previous, limits);
  });

  test("concurrent changes from the same version save only one", async () => {
    const mine = await customer();
    const results = await Promise.all(
      ["10", "20", "30"].map((cap) =>
        store.change(mine, { ...limits, maxOrderNotional: cap }, 0),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "saved").length,
      1,
    );
    assert.equal((await store.current(mine))?.version, 1);
  });

  test("versions are immutable and other customers cannot see them", async () => {
    const mine = await customer();
    const theirs = await customer();
    await store.change(mine, limits, 0);
    assert.equal(await store.current(theirs), undefined);
    await assert.rejects(
      withCustomerScope(
        database.app,
        mine.customerId,
        (tx) => tx`update manual_risk_limits set max_daily_risk = 1`,
      ),
      /permission denied/,
    );
    // A customer cannot write limits for an account that is not theirs.
    const intruder = {
      customerId: theirs.customerId,
      exchangeAccountId: mine.exchangeAccountId,
    };
    assert.equal((await store.change(intruder, limits, 0)).status, "conflict");
    const fresh = await customer();
    await assert.rejects(
      store.change(
        { ...intruder, exchangeAccountId: fresh.exchangeAccountId },
        limits,
        0,
      ),
      /foreign key/,
    );
    assert.equal((await store.current(mine))?.version, 1);
    assert.equal(await store.current(fresh), undefined);
  });

  test("daily risk counts today's entries at their stops and CLI buys in full, except refused or unfilled cancelled ones", async () => {
    const mine = await customer();
    const intents = new PostgresOrderIntents(database.app);
    const today = new Date("2026-10-08T00:00:00.000Z");
    const entry = (
      id: string,
      quantity: string,
      stop: string,
    ): ManualOrder => ({
      kind: "protected_entry",
      entry: {
        instrument: "BTC-USDT",
        quantity,
        price: "60000",
        timeInForce: "GTC",
        takeProfitPrice: "63000",
        stopLossPrice: stop,
        listClientOrderId: id,
      },
    });
    const at = (iso: string) => new Date(iso);
    // 0.001 × (60000 − 58000) = 2 USDT.
    await intents.record(
      mine,
      entry("ct_r_open", "0.001", "58000"),
      "dashboard",
      at("2026-10-08T01:00:00Z"),
    );
    // 0.002 × 1000 = 2 USDT, settled as unknown: still counts.
    await intents.record(
      mine,
      entry("ct_r_unknown", "0.002", "59000"),
      "dashboard",
      at("2026-10-08T02:00:00Z"),
    );
    await intents.settle(mine, "ct_r_unknown", { status: "unknown" });
    // Refused by Binance: nothing was placed.
    await intents.record(
      mine,
      entry("ct_r_refused", "0.01", "50000"),
      "dashboard",
      at("2026-10-08T03:00:00Z"),
    );
    await intents.settle(mine, "ct_r_refused", { status: "rejected" });
    // Yesterday's entry is outside today.
    await intents.record(
      mine,
      entry("ct_r_old", "0.01", "50000"),
      "dashboard",
      at("2026-10-07T23:59:59Z"),
    );
    // Cancelled before anything filled: no risk left.
    await intents.record(
      mine,
      entry("ct_r_cancel", "0.01", "50000"),
      "dashboard",
      at("2026-10-08T04:00:00Z"),
    );
    const leg = (clientOrderId: string, status: string, executedQty: string) =>
      ({
        instrument: "BTC-USDT",
        orderId: "70",
        orderListId: "7",
        clientOrderId,
        price: "60000",
        origQty: "0.01",
        executedQty,
        cumulativeQuoteQty: "0",
        status,
        type: "LIMIT",
        side: "BUY",
      }) satisfies ExchangeOrder;
    await intents.recordOrders(mine, [leg("ct_r_cancel_en", "CANCELED", "0")]);
    // Cancelled after a partial fill: counts in full.
    await intents.record(
      mine,
      entry("ct_r_partial", "0.001", "59500"),
      "dashboard",
      at("2026-10-08T05:00:00Z"),
    );
    await intents.recordOrders(mine, [
      leg("ct_r_partial_en", "CANCELED", "0.0005"),
    ]);
    // A CLI buy has no stop, so all of it counts: 0.01 × 60000 = 600.
    await intents.record(
      mine,
      {
        kind: "limit_order",
        order: {
          instrument: "BTC-USDT",
          side: "BUY",
          quantity: "0.01",
          price: "60000",
          clientOrderId: "ct_r_cli",
        },
      },
      "cli",
      at("2026-10-08T06:00:00Z"),
    );
    // A CLI sell adds none.
    await intents.record(
      mine,
      {
        kind: "limit_order",
        order: {
          instrument: "BTC-USDT",
          side: "SELL",
          quantity: "0.01",
          price: "60000",
          clientOrderId: "ct_r_cli_sell",
        },
      },
      "cli",
      at("2026-10-08T07:00:00Z"),
    );
    // 2 + 2 + 0.5 + 600
    assert.equal(await store.dailyRiskUsed(mine, today), "604.5");
    // Cancelled before it filled, the CLI buy no longer counts.
    await intents.recordOrders(mine, [
      { ...leg("ct_r_cli", "CANCELED", "0"), orderListId: null },
    ]);
    assert.equal(await store.dailyRiskUsed(mine, today), "4.5");
    const theirs = await customer();
    assert.equal(await store.dailyRiskUsed(theirs, today), "0");
  });
});
