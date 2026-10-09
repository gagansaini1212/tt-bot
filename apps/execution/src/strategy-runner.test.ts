import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import Decimal from "decimal.js";
import { utcDayStart } from "@crypto-trading/domain";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import {
  BinanceTestnetError,
  protectedLegIds,
  strategyDraftSchema,
  type ManualOrderRequest,
  type StrategiesState,
  type StrategyChange,
  type StrategyDraft,
  VENUES,
  type VenueCapabilities,
} from "@crypto-trading/exchanges";
import type { AccountLister, AccountScope } from "./accounts";
import {
  RecordedDecisionSource,
  RECORDED_FIXTURE_MODEL,
  type DecisionSource,
} from "./ai-decisions";
import { ExecutionLoop } from "./execution-loop";
import { FakeBinance } from "./fixtures/fake-binance";
import { limit } from "./fixtures/fake-exchange";
import {
  loadManualTradingConfig,
  ManualOrderDesk,
  accountQueues,
} from "./manual-orders";
import { PostgresOrderIntents } from "./order-intents";
import { PostgresRiskLimits } from "./risk-limits";
import { StrategyRunner } from "./strategy-runner";
import type { EntryCandidate } from "./strategy-store";
import { PostgresTradeProposals } from "./trade-proposals";
import { decisions } from "./routes/decisions";
import { strategies as strategyRoutes } from "./routes/strategies";

const config = (() => {
  const loaded = loadManualTradingConfig({
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
    TESTNET_MARKET_MAX_SLIPPAGE_PERCENT: "0.5",
  });
  assert.ok(loaded.ok);
  return loaded.config;
})();

const stopLimit = (id: string): ManualOrderRequest => ({
  type: "stop_limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  stopPrice: "61000",
  price: "61100",
  takeProfitPrice: "64000",
  stopLossPrice: "59000",
  listClientOrderId: id,
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A valid draft, checked as the web app and the worker check it. */
function draft(value: unknown): StrategyDraft {
  return strategyDraftSchema.parse(value);
}

function grid(now: Date, overrides: Record<string, unknown> = {}) {
  return draft({
    name: "BTC grid",
    allocation: "600",
    ai: null,
    rules: {
      kind: "grid",
      instrument: "BTC-USDT",
      marketKind: "spot",
      // Levels at 57,000 to 63,000, 1,000 apart; buys at 57,000 to 62,000.
      lowerPrice: "57000",
      upperPrice: "63000",
      levelCount: 7,
      amountPerLevel: "100",
      rangeStopPrice: "56000",
      entryExpiresAt: new Date(now.getTime() + DAY).toISOString(),
      holdingPeriodSeconds: 86_400,
      lossLimits: { daily: "50", total: "100" },
      ...overrides,
    },
  });
}

describe("strategies", { skip: databaseTestsSkipped }, () => {
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
   * A customer with a portfolio drawdown limit, a fake Binance, and a desk,
   * loop and strategy runner for them on the test database. `restart`
   * builds new ones on the same state, as a restarted worker would. `start`
   * sets the clock; PostgreSQL keeps its own.
   */
  async function world({
    lockAccounts = true,
    decisions = new RecordedDecisionSource(),
    start,
    drawdownPercent = "50",
  }: {
    lockAccounts?: boolean;
    decisions?: DecisionSource;
    start?: Date;
    drawdownPercent?: string;
  } = {}) {
    const scope = await addCustomer();
    let offset = start ? start.getTime() - Date.now() : 0;
    let frozen: Date | undefined;
    const now = () => frozen ?? new Date(Date.now() + offset);
    const fake = new FakeBinance(now);
    fake.balances.get("USDT")!.free = new Decimal(10_000);
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
    const accounts: AccountLister = async (customerId) =>
      customerId === scope.customerId ? [scope] : [];
    const logs: string[] = [];
    const build = () => {
      const exclusive = accountQueues();
      const runner = new StrategyRunner({
        database: database.app,
        proposals,
        intents,
        decisions,
        now,
        log: (message) => logs.push(message),
        exclusive,
      });
      const desk = new ManualOrderDesk({
        exchange: fake,
        config,
        intents,
        proposals,
        risk,
        now,
        exclusive: exclusive(scope),
      });
      const loop = new ExecutionLoop({
        database: database.app,
        exchange: fake,
        accounts,
        intents,
        desk,
        now,
        log: (message) => logs.push(message),
        lockAccounts,
        strategies: runner,
      });
      return { runner, desk, loop };
    };
    let built = build();
    await built.runner.store.changePortfolioLimits(scope, drawdownPercent, 0);
    return {
      scope,
      fake,
      proposals,
      logs,
      now,
      build,
      get runner() {
        return built.runner;
      },
      get desk() {
        return built.desk;
      },
      get loop() {
        return built.loop;
      },
      restart() {
        built = build();
      },
      pass: () => built.loop.runPass(),
      advance(ms: number) {
        offset += ms;
      },
      // Stops the clock at `at`, to the millisecond.
      freeze(at: Date) {
        frozen = at;
      },
      async create(value: StrategyDraft) {
        const created = await built.runner.store.create(scope, value, now());
        assert.equal(created.result, "saved", created.message);
        return created.result === "saved" ? created.strategy.id : "";
      },
      strategy: async (id: string) =>
        (await built.runner.store.get(scope, id))!,
      state: () => built.runner.state(scope, fake),
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** The strategy's entries: key, attempt, intent status and loop state. */
  async function entries(strategyId: string) {
    return database.admin<
      {
        id: string;
        entry_key: string | null;
        entry_attempt: number | null;
        status: string;
        idempotency_key: string | null;
        intent_status: string | null;
        state: string | null;
        exit_reason: string | null;
        quantity: string;
        entry_price: string;
        reservation: string | null;
      }[]
    >`
      select p.id, p.entry_key, p.entry_attempt, p.status, i.idempotency_key,
        i.status as intent_status, r.state, r.exit_reason,
        p.quantity::text, p.entry_price::text, b.status as reservation
      from trade_proposals p
      left join order_intents i on i.proposal_id = p.id
      left join entry_reconciliations r on r.order_intent_id = i.id
      left join budget_reservations b on b.proposal_id = p.id
      where p.strategy_id = ${strategyId}
      order by p.created_at, p.entry_key, p.entry_attempt
    `;
  }

  const listOf = async (strategyId: string, key: string, attempt = 1) =>
    (await entries(strategyId)).find(
      (entry) => entry.entry_key === key && entry.entry_attempt === attempt,
    )!.idempotency_key!;

  const notifications = async (scope: AccountScope) =>
    (
      await database.admin<{ kind: string; severity: string }[]>`
        select kind, severity from notifications
        where customer_id = ${scope.customerId}
        order by created_at, id
      `
    ).map(({ kind, severity }) => `${severity}:${kind}`);

  const auditEvents = async (scope: AccountScope, type: string) =>
    database.admin<{ payload: Record<string, unknown> }[]>`
      select payload from audit_events
      where customer_id = ${scope.customerId} and event_type = ${type}
      order by occurred_at
    `;

  /**
   * Places a standing instruction and fills its first entry, so the strategy
   * holds BTC. Its second entry rests far below, so its rules stay open.
   */
  async function holding(
    w: World,
    lossLimits = { daily: "3", total: "10" },
    name = "Standing",
  ) {
    const id = await w.create(
      draft({
        name,
        allocation: "100",
        ai: null,
        rules: {
          kind: "standing_price_instruction",
          instrument: "BTC-USDT",
          marketKind: "spot",
          direction: "long",
          leverage: 1,
          entries: [
            {
              quantity: "0.001",
              entryPrice: "59900",
              stopLossPrice: "55000",
              takeProfitPrice: "62000",
            },
            {
              quantity: "0.001",
              entryPrice: "40000",
              stopLossPrice: "39000",
              takeProfitPrice: "41000",
            },
          ],
          entryExpiresAt: new Date(w.now().getTime() + DAY).toISOString(),
          holdingPeriodSeconds: 86_400,
          lossLimits,
        },
      }),
    );
    await w.pass();
    const list = await listOf(id, "entry:0");
    w.fake.fillEntry(list, "0.001");
    await w.pass();
    return { id, list };
  }

  test("a grid rests buys below the market, buys a level again once it closes, and completes when the market leaves its range", async () => {
    const w = await world();
    const id = await w.create(grid(w.now()));
    await w.pass();
    // Strictly below 60,000, nearest first.
    let made = await entries(id);
    assert.deepEqual(
      made.map(
        (entry) =>
          `${entry.entry_key}@${new Decimal(entry.entry_price).toFixed()}`,
      ),
      ["level:2@59000", "level:1@58000", "level:0@57000"],
    );
    assert.ok(
      made.every((entry) => entry.idempotency_key!.startsWith("ct_sg")),
    );
    assert.ok(made.every((entry) => entry.intent_status === "acknowledged"));
    assert.ok(made.every((entry) => entry.status === "authorized"));
    assert.ok(made.every((entry) => entry.reservation === "held"));
    assert.equal(w.fake.count("placeProtectedEntry"), 3);
    // A second pass makes nothing new.
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), 3);

    // The 59,000 buy fills and takes profit at 60,000; the level is free.
    const list = await listOf(id, "level:2");
    w.fake.fillEntry(list, "0.00169");
    await w.pass();
    assert.equal(
      (await entries(id)).find((entry) => entry.idempotency_key === list)
        ?.state,
      "protected",
    );
    w.fake.fillExit(list, "takeProfit");
    await w.pass();
    await w.pass();
    made = await entries(id);
    assert.equal(
      made.find((entry) => entry.idempotency_key === list)?.state,
      "closed",
    );
    assert.equal(
      made.find((entry) => entry.idempotency_key === list)?.reservation,
      "released",
    );
    assert.ok(
      made.some(
        (entry) => entry.entry_key === "level:2" && entry.entry_attempt === 2,
      ),
    );

    // The card's figures: 59,000 → 60,000 on 0.00169, less the buy's fee.
    const view = (await w.state()).strategies.find((entry) => entry.id === id)!;
    assert.equal(view.status, "simulation");
    assert.equal(view.entries.pending, 3);
    assert.equal(view.measure.status, "measured");
    if (view.measure.status === "measured") {
      // Binance sized the take profit at 0.00168, what the buy received
      // after its 0.00000169 BTC fee, worth 0.09971 USDT.
      assert.equal(view.measure.realizedPnl, "1.68");
      assert.equal(view.measure.fees, "0.09971");
      assert.equal(view.measure.unrealizedPnl, "0");
    }

    // Above the range, the grid cancels its buys and completes.
    w.fake.setPrice("BTC-USDT", "63500");
    await w.pass();
    assert.equal((await w.strategy(id)).rulesEndedReason, "above_range");
    await w.pass();
    await w.pass();
    const done = await w.strategy(id);
    assert.equal(done.status, "retired");
    assert.ok(done.completedAt);
    assert.ok(
      (await entries(id)).every((entry) =>
        ["closed", "not_filled"].includes(entry.state ?? ""),
      ),
    );
    assert.ok(
      (await entries(id)).every((entry) => entry.reservation === "released"),
    );
    assert.ok(
      (await notifications(w.scope)).includes("info:strategy_completed"),
    );
    // A completed grid never opens again, even back in its range.
    w.fake.setPrice("BTC-USDT", "60000");
    const placed = w.fake.count("placeProtectedEntry");
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), placed);
  });

  test("an entry waits instead of opening when Binance's five stop orders on the symbol are in use", async () => {
    const w = await world();
    // A dashboard entry holds one of them.
    assert.equal(
      (await w.desk.place(w.scope, limit("ct_dash_one"))).status,
      "working",
    );
    const id = await w.create(
      grid(w.now(), {
        lowerPrice: "50000",
        upperPrice: "61000",
        levelCount: 12,
        amountPerLevel: "20",
        rangeStopPrice: "49000",
      }),
    );
    await w.pass();
    // Ten levels lie below 60,000; four fit beside the dashboard entry.
    let made = await entries(id);
    assert.equal(made.length, 4);
    assert.deepEqual(
      made.map((entry) => entry.entry_key),
      ["level:9", "level:8", "level:7", "level:6"],
    );
    await w.pass();
    assert.equal((await entries(id)).length, 4);
    assert.match(
      (await w.strategy(id)).runnerNote,
      /Binance allows 5 open stop orders on BTC\/USDT/,
    );
    const view = await w.state();
    assert.equal(
      view.markets.find((market) => market.instrument === "BTC-USDT")
        ?.stopOrdersInUse,
      5,
    );
    // Once the dashboard entry ends, the grid takes its place.
    const cancel = await w.desk.cancel(w.scope, {
      instrument: "BTC-USDT",
      orderId: w.fake.orders.get(protectedLegIds("ct_dash_one").entry)!.orderId,
      acceptUnprotected: false,
    });
    assert.equal(cancel.status, "cancelled");
    await w.pass();
    made = await entries(id);
    assert.equal(made.length, 5);
  });

  test("a DCA buys at the ask on its schedule, raises a dip buy, skips buys due while paused, and completes", async () => {
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 60_000);
    const w = await world({ start });
    const id = await w.create(
      draft({
        name: "BTC DCA",
        allocation: "225",
        ai: null,
        rules: {
          kind: "dca",
          instrument: "BTC-USDT",
          marketKind: "spot",
          amountPerBuy: "50",
          interval: "1h",
          startsAt: new Date(start.getTime() - 60_000).toISOString(),
          maxBuys: 3,
          stopLossPercent: "5",
          takeProfitPercent: "5",
          dip: { dropPercent: "3", multiplier: "1.5" },
          holdingPeriodSeconds: 86_400,
          lossLimits: { daily: "20", total: "40" },
        },
      }),
    );
    await w.pass();
    await w.pass();
    let made = await entries(id);
    assert.equal(made.length, 1);
    assert.equal(made[0].entry_key, "buy:0");
    // 50 USDT at the 60,000 ask.
    assert.equal(new Decimal(made[0].quantity).toFixed(), "0.00083");
    assert.match((await w.strategy(id)).runnerNote, /next is due/);

    // An hour later the ask is 3.3% lower: a dip buy of 75 USDT. The
    // first buy expired unfilled, so it is cancelled.
    w.advance(HOUR);
    w.fake.setPrice("BTC-USDT", "58000");
    await w.pass();
    await w.pass();
    made = await entries(id);
    assert.equal(made.length, 2);
    assert.equal(made[1].entry_key, "buy:1");
    assert.equal(new Decimal(made[1].quantity).toFixed(), "0.00129");
    assert.equal(made[0].exit_reason, "entry_expired");
    assert.equal(made[0].state, "not_filled");
    w.fake.fillEntry(made[1].idempotency_key!, "0.00129");
    await w.pass();

    // Paused through the third buy's hour: it is skipped, never made up.
    assert.equal((await w.runner.store.pause(w.scope, id)).result, "saved");
    w.advance(HOUR);
    await w.pass();
    assert.equal((await entries(id)).length, 2);
    w.advance(HOUR);
    assert.equal((await w.runner.store.resume(w.scope, id)).result, "saved");
    await w.pass();
    assert.equal((await entries(id)).length, 2);
    assert.equal((await w.strategy(id)).rulesEndedReason, "schedule_complete");
    // The filled buy kept its exits through the pause.
    made = await entries(id);
    assert.equal(made[1].state, "protected");
    w.fake.fillExit(made[1].idempotency_key!, "takeProfit");
    await w.pass();
    await w.pass();
    assert.equal((await w.strategy(id)).status, "retired");
  });

  test("a standing instruction places its entries, places a cancelled one again on resume, never one that filled, and ends at its expiry", async () => {
    const w = await world();
    const expiry = new Date(w.now().getTime() + 2 * HOUR);
    const id = await w.create(
      draft({
        name: "Two buys",
        allocation: "200",
        ai: null,
        rules: {
          kind: "standing_price_instruction",
          instrument: "BTC-USDT",
          marketKind: "spot",
          direction: "long",
          leverage: 1,
          entries: [
            {
              quantity: "0.001",
              entryPrice: "59000",
              stopLossPrice: "57000",
              takeProfitPrice: "61000",
            },
            {
              quantity: "0.001",
              entryPrice: "58000",
              stopLossPrice: "56000",
              takeProfitPrice: "60000",
            },
          ],
          entryExpiresAt: expiry.toISOString(),
          holdingPeriodSeconds: 86_400,
          lossLimits: { daily: "10", total: "20" },
        },
      }),
    );
    await w.pass();
    assert.deepEqual(
      (await entries(id)).map((entry) => entry.entry_key),
      ["entry:0", "entry:1"],
    );
    w.fake.fillEntry(await listOf(id, "entry:0"), "0.001");
    await w.runner.store.pause(w.scope, id);
    await w.pass();
    await w.pass();
    let made = await entries(id);
    // The pause cancelled the unfilled entry; the filled one keeps its exits.
    assert.equal(
      made.find((entry) => entry.entry_key === "entry:0")?.state,
      "protected",
    );
    assert.equal(
      made.find((entry) => entry.entry_key === "entry:1")?.state,
      "not_filled",
    );
    assert.equal((await w.runner.store.resume(w.scope, id)).result, "saved");
    await w.pass();
    made = await entries(id);
    assert.deepEqual(
      made.map((entry) => `${entry.entry_key}#${entry.entry_attempt}`),
      ["entry:0#1", "entry:1#1", "entry:1#2"],
    );
    // At the expiry, the unfilled entry is cancelled and the rules end.
    w.advance(2 * HOUR);
    await w.pass();
    await w.pass();
    assert.equal((await w.strategy(id)).rulesEndedReason, "expired");
    assert.equal(
      (await entries(id)).find(
        (entry) => entry.entry_key === "entry:1" && entry.entry_attempt === 2,
      )?.state,
      "not_filled",
    );
    assert.equal((await w.strategy(id)).status, "simulation");
  });

  test("an AI-managed strategy records labelled fixture decisions, waits for approval by default, and places them within its limits", async () => {
    const w = await world();
    const rules = {
      kind: "ai_managed",
      allowedInstruments: ["BTC-USDT"],
      marketKind: "spot",
      allowShort: false,
      maxLeverage: 1,
      maxPositionNotional: "200",
      maxProtectedEntries: 3,
      holdingPeriodSeconds: 3_600,
      takeProfitAdjustable: false,
      lossLimits: { daily: "20", total: "50" },
    };
    const id = await w.create(
      draft({
        name: "AI decisions",
        allocation: "200",
        ai: { proposalApproval: "required", analysisIntervalMinutes: 60 },
        rules,
      }),
    );
    await w.pass();
    await w.pass();
    const [decision] = await database.admin<
      {
        model: string;
        rationale: string;
        proposal_id: string;
        prompt_version: string;
      }[]
    >`
      select model, rationale, proposal_id, prompt_version from ai_decisions
      where strategy_id = ${id}
    `;
    assert.equal(decision.model, RECORDED_FIXTURE_MODEL);
    assert.match(decision.rationale, /^Recorded fixture, not an AI analysis:/);
    let made = await entries(id);
    assert.equal(made.length, 1);
    assert.equal(made[0].status, "draft");
    assert.equal(made[0].intent_status, null);
    assert.equal(w.fake.count("placeProtectedEntry"), 0);
    assert.ok(
      (await notifications(w.scope)).includes(
        "info:proposal_awaiting_approval",
      ),
    );
    const view = (await w.state()).strategies.find((entry) => entry.id === id)!;
    assert.equal(view.entries.awaitingApproval, 1);
    assert.equal(view.latestDecision?.fixture, true);

    // The customer approves it: checked against the strategy, then placed.
    const outcome = await w.runner.approve(
      w.scope,
      w.fake,
      decision.proposal_id,
    );
    assert.equal(outcome.status, "working", outcome.message);
    made = await entries(id);
    assert.equal(made[0].status, "approved");
    assert.equal(made[0].entry_key, "ai");
    assert.ok(made[0].idempotency_key?.startsWith("ct_sg"));
    assert.equal(made[0].reservation, "held");
    // Approving again sends nothing.
    assert.equal(
      (await w.runner.approve(w.scope, w.fake, decision.proposal_id)).status,
      "duplicate",
    );
    assert.equal(w.fake.count("placeProtectedEntry"), 1);

    // An hour later the fixture's next decision is not to trade.
    w.advance(HOUR);
    await w.pass();
    const kinds = await database.admin<{ kind: string }[]>`
      select kind from ai_decisions where strategy_id = ${id}
      order by created_at
    `;
    assert.deepEqual(
      kinds.map((row) => row.kind),
      ["trade_proposal", "no_trade"],
    );

    // In automatic mode, a proposal is placed at once.
    const automatic = await w.create(
      draft({
        name: "AI automatic",
        allocation: "200",
        ai: { proposalApproval: "automatic", analysisIntervalMinutes: 60 },
        rules: { ...rules, allowedInstruments: ["ETH-USDT"] },
      }),
    );
    await w.pass();
    const [placed] = await entries(automatic);
    assert.equal(placed.status, "authorized");
    assert.equal(placed.intent_status, "acknowledged");
  });

  test("an approval blocked by another strategy's position leaves the proposal waiting", async () => {
    const w = await world();
    await holding(w, { daily: "50", total: "90" });
    const id = await w.create(
      draft({
        name: "AI on BTC",
        allocation: "200",
        ai: { proposalApproval: "required", analysisIntervalMinutes: 60 },
        rules: {
          kind: "ai_managed",
          allowedInstruments: ["BTC-USDT"],
          marketKind: "spot",
          allowShort: false,
          maxLeverage: 1,
          maxPositionNotional: "200",
          maxProtectedEntries: 3,
          holdingPeriodSeconds: 3_600,
          takeProfitAdjustable: false,
          lossLimits: { daily: "20", total: "50" },
        },
      }),
    );
    await w.pass();
    const [proposal] = await entries(id);
    const outcome = await w.runner.approve(w.scope, w.fake, proposal.id);
    assert.equal(outcome.status, "rejected");
    assert.match(outcome.message, /still waits for your approval/);
    assert.match(outcome.message, /Standing holds the BTC\/USDT position/);
    assert.equal((await entries(id))[0].status, "draft");
  });

  test("a restarted worker never sends an entry twice, and makes it again only once Binance proves it never received it", async () => {
    const w = await world();
    const id = await w.create(
      grid(w.now(), { lowerPrice: "57000", levelCount: 7 }),
    );
    // Binance takes each entry but its answer is lost, and so is the
    // lookup that follows: the outcome is unknown.
    w.fake.entryBehaviour = "unknown_placed";
    for (let failed = 0; failed < 3; failed++)
      w.fake.failNext("getOrderList", new BinanceTestnetError("unavailable"));
    await w.pass();
    w.fake.entryBehaviour = "place";
    let made = await entries(id);
    assert.ok(made.every((entry) => entry.intent_status === "unknown"));
    const sent = w.fake.count("placeProtectedEntry");
    w.restart();
    await w.pass();
    assert.equal(w.fake.count("placeProtectedEntry"), sent);
    // Reconciliation finds them once their grace period is over.
    w.advance(61_000);
    await w.pass();
    made = await entries(id);
    assert.ok(made.every((entry) => entry.intent_status === "acknowledged"));
    assert.equal(w.fake.count("placeProtectedEntry"), sent);

    // A crash before Binance received one: reconciliation rejects it, its
    // budget is released, and the level is bought again.
    const second = await world();
    const gridId = await second.create(grid(second.now()));
    second.fake.failNext("placeProtectedEntry", new Error("crashed"));
    await second.pass();
    let lost = (await entries(gridId)).find(
      (entry) => entry.intent_status === "unknown",
    )!;
    assert.ok(lost);
    second.restart();
    second.advance(61_000);
    await second.pass();
    await second.pass();
    made = await entries(gridId);
    lost = made.find((entry) => entry.id === lost.id)!;
    assert.equal(lost.intent_status, "rejected");
    assert.equal(lost.reservation, "released");
    assert.ok(
      made.some(
        (entry) =>
          entry.entry_key === lost.entry_key &&
          entry.entry_attempt === 2 &&
          entry.intent_status === "acknowledged",
      ),
    );
  });

  test("two workers running at once make each entry once", async () => {
    const w = await world({ lockAccounts: false });
    const id = await w.create(grid(w.now()));
    const other = w.build();
    await Promise.all([w.pass(), other.loop.runPass(), w.pass()]);
    await Promise.all([w.pass(), other.loop.runPass()]);
    const made = await entries(id);
    assert.deepEqual(made.map((entry) => entry.entry_key).sort(), [
      "level:0",
      "level:1",
      "level:2",
    ]);
    assert.equal(w.fake.count("placeProtectedEntry"), 3);
  });

  test("concurrent reservations never commit more than the allocation", async () => {
    const w = await world();
    const id = await w.create(
      draft({
        name: "AI",
        allocation: "500",
        ai: { proposalApproval: "automatic", analysisIntervalMinutes: 1440 },
        rules: {
          kind: "ai_managed",
          allowedInstruments: ["BTC-USDT", "ETH-USDT"],
          marketKind: "spot",
          allowShort: false,
          maxLeverage: 1,
          maxPositionNotional: "500",
          maxProtectedEntries: 5,
          holdingPeriodSeconds: 3_600,
          takeProfitAdjustable: false,
          lossLimits: { daily: "50", total: "100" },
        },
      }),
    );
    const candidate = (
      instrument: "BTC-USDT" | "ETH-USDT",
      price: string,
      quantity: string,
    ) => ({
      strategyId: id,
      key: "ai",
      once: false,
      proposalId: randomUUID(),
      rationale: "Test",
      sourceSnapshotId: randomUUID(),
      freeStopOrders: 5,
      intent: {
        key: "ai",
        instrument,
        marketKind: "spot" as const,
        direction: "long" as const,
        leverage: 1,
        quantity,
        entryPrice: price,
        stopLossPrice: new Decimal(price).times("0.9").toFixed(),
        takeProfitPrice: new Decimal(price).times("1.1").toFixed(),
        entryExpiresAt: new Date(w.now().getTime() + HOUR).toISOString(),
        holdingPeriodSeconds: 3_600,
      },
    });
    // 300 USDT each, against 500.
    const results = await Promise.all([
      w.runner.store.reserve(
        w.scope,
        candidate("BTC-USDT", "60000", "0.005"),
        w.now(),
      ),
      w.runner.store.reserve(
        w.scope,
        candidate("ETH-USDT", "3000", "0.1"),
        w.now(),
      ),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [
      "refused",
      "saved",
    ]);
    const refused = results.find((result) => result.status === "refused");
    assert.match(
      refused?.status === "refused" ? refused.reason : "",
      /enough uncommitted allocation/,
    );
    const [{ total }] = await database.admin<{ total: string }[]>`
      select coalesce(sum(b.amount), 0)::text as total
      from budget_reservations b
      join allocations a on a.id = b.allocation_id
      where a.strategy_id = ${id} and b.status <> 'released'
    `;
    assert.equal(new Decimal(total).toFixed(), "300");
  });

  test("pause cancels pending entries and keeps filled ones protected; close all sells them", async () => {
    const w = await world();
    const id = await w.create(grid(w.now()));
    await w.pass();
    const filled = await listOf(id, "level:2");
    w.fake.fillEntry(filled, "0.00169");
    await w.pass();
    assert.equal((await w.runner.store.pause(w.scope, id)).result, "saved");
    await w.pass();
    await w.pass();
    let made = await entries(id);
    assert.equal(
      made.find((entry) => entry.idempotency_key === filled)?.state,
      "protected",
    );
    assert.deepEqual(
      made
        .filter((entry) => entry.idempotency_key !== filled)
        .map((entry) => entry.state),
      ["not_filled", "not_filled"],
    );
    // Paused: nothing new, though the levels are free.
    assert.equal(made.length, 3);
    assert.equal((await w.strategy(id)).pauseReason, "customer");

    assert.equal((await w.runner.store.closeAll(w.scope, id)).result, "saved");
    await w.pass();
    await w.pass();
    made = await entries(id);
    assert.equal(
      made.find((entry) => entry.idempotency_key === filled)?.state,
      "closed",
    );
    assert.equal(
      made.find((entry) => entry.idempotency_key === filled)?.exit_reason,
      "close_all",
    );
    assert.equal(w.fake.count("placeMarketSell"), 1);
    const strategy = await w.strategy(id);
    assert.equal(strategy.status, "paused");
    assert.equal(strategy.exitRequest, "close_all");
    assert.equal((await auditEvents(w.scope, "strategy.close_all")).length, 1);
  });

  test("an entry sent while a pause is saved is cancelled on the next pass", async () => {
    const w = await world();
    const id = await w.create(grid(w.now()));
    await w.pass();
    // Pause, then an entry acknowledged after the pause asked for exits.
    await w.runner.store.pause(w.scope, id);
    const late = randomUUID();
    await withCustomerScope(database.app, w.scope.customerId, async (tx) => {
      await tx`update strategies set status = 'simulation' where id = ${id}`;
    });
    const reserved = await w.runner.store.reserve(
      w.scope,
      {
        strategyId: id,
        key: "level:5",
        once: false,
        proposalId: late,
        rationale: "Late",
        sourceSnapshotId: randomUUID(),
        freeStopOrders: 2,
        intent: {
          key: "level:5",
          instrument: "BTC-USDT",
          marketKind: "spot",
          direction: "long",
          leverage: 1,
          quantity: "0.0001",
          entryPrice: "55000",
          stopLossPrice: "54000",
          takeProfitPrice: "56000",
          entryExpiresAt: new Date(w.now().getTime() + HOUR).toISOString(),
          holdingPeriodSeconds: 86_400,
        },
      },
      w.now(),
    );
    assert.equal(reserved.status, "saved");
    if (reserved.status === "saved")
      await w.fake.placeProtectedEntry(reserved.entry);
    await withCustomerScope(database.app, w.scope.customerId, async (tx) => {
      await tx`update strategies set status = 'paused' where id = ${id}`;
      await tx`update order_intents set status = 'acknowledged' where proposal_id = ${late}`;
    });
    await w.pass();
    const entry = (await entries(id)).find((row) => row.id === late)!;
    assert.equal(entry.exit_reason, "pause");
  });

  test("a loss limit reached before midnight UTC stops and pauses the strategy, and the next day it may resume", async () => {
    const real = new Date();
    let midnight = utcDayStart(new Date(real.getTime() + DAY));
    if (midnight.getTime() - real.getTime() < HOUR)
      midnight = new Date(midnight.getTime() + DAY);
    const w = await world({
      start: new Date(midnight.getTime() - 30 * 60_000),
    });
    const { id, list } = await holding(w);
    // 0.000999 BTC from 59,900 to 56,900 is -2.997, plus the 0.0599 fee:
    // past the 3 USDT daily limit.
    w.fake.setPrice("BTC-USDT", "56900");
    await w.pass();
    const stopped = await w.strategy(id);
    assert.equal(stopped.status, "paused");
    assert.equal(stopped.pauseReason, "loss_limit");
    assert.equal(stopped.exitRequest, "loss_limit");
    assert.deepEqual(
      (await notifications(w.scope)).filter((kind) =>
        kind.startsWith("critical"),
      ),
      ["critical:loss_limit_reached"],
    );
    await w.pass();
    await w.pass();
    const [entry] = await entries(id);
    assert.equal(entry.idempotency_key, list);
    assert.equal(entry.state, "closed");
    assert.equal(entry.exit_reason, "loss_limit");
    // Raised once, however many passes see it.
    assert.equal(
      (await auditEvents(w.scope, "strategy.loss_limit_reached")).length,
      1,
    );
    assert.match(
      (await w.runner.resumeProblem(w.scope, w.fake, id)) ?? "",
      /daily loss limit is still reached today/,
    );

    // The last millisecond before midnight still counts the loss; from
    // midnight, yesterday's loss does not count against today.
    w.freeze(new Date(midnight.getTime() - 1));
    assert.match(
      (await w.runner.resumeProblem(w.scope, w.fake, id)) ?? "",
      /daily loss limit is still reached today/,
    );
    w.freeze(midnight);
    assert.equal(await w.runner.resumeProblem(w.scope, w.fake, id), undefined);
    assert.equal((await w.runner.store.resume(w.scope, id)).result, "saved");
  });

  test("an open entry's loss since midnight UTC counts from its value then", async () => {
    const real = new Date();
    let midnight = utcDayStart(new Date(real.getTime() + DAY));
    if (midnight.getTime() - real.getTime() < HOUR)
      midnight = new Date(midnight.getTime() + DAY);
    const w = await world({
      start: new Date(midnight.getTime() - 30 * 60_000),
    });
    const { id } = await holding(w, { daily: "3", total: "10" });
    // Before midnight it lost 2.0979: under the daily limit.
    w.fake.setPrice("BTC-USDT", "57860");
    await w.pass();
    assert.equal((await w.strategy(id)).status, "simulation");
    // At midnight it was worth 57,860; by 00:10 it has fallen 1,000 more.
    w.advance(40 * 60_000);
    w.fake.setHourOpen("BTC-USDT", midnight, "57860");
    w.fake.setPrice("BTC-USDT", "56860");
    await w.pass();
    const view = (await w.state()).strategies.find((entry) => entry.id === id)!;
    assert.equal(view.measure.status, "measured");
    if (view.measure.status === "measured") {
      assert.equal(view.measure.daily.pnl, "-0.999");
      assert.equal(view.measure.total.reached, false);
    }
    assert.equal((await w.strategy(id)).status, "simulation");
  });

  test("the portfolio's daily drawdown limit pauses every strategy", async () => {
    const w = await world({ drawdownPercent: "1" });
    await holding(w, { daily: "50", total: "90" }, "Holding");
    const idle = await w.create(grid(w.now(), { lowerPrice: "57000" }));
    // 2.997 + 0.0599 lost of the 700 USDT allocated: 0.44%.
    w.fake.setPrice("BTC-USDT", "56900");
    await w.pass();
    assert.equal((await w.strategy(idle)).status, "simulation");
    // 6.9930 + 0.0599 of 700: 1.0075%.
    w.fake.setPrice("BTC-USDT", "52900");
    await w.pass();
    const strategies = await w.runner.store.list(w.scope);
    assert.deepEqual(
      strategies.map(
        (strategy) => `${strategy.status}:${strategy.pauseReason}`,
      ),
      ["paused:drawdown", "paused:drawdown"],
    );
    assert.ok(
      (await notifications(w.scope)).includes("critical:drawdown_reached"),
    );
    assert.match(
      (await w.runner.resumeProblem(w.scope, w.fake, idle)) ?? "",
      /daily drawdown limit/,
    );
    const state = await w.state();
    assert.equal(state.today?.reached, true);
  });

  test("the kill switch pauses every strategy, closes every managed entry, cancels held stop-limit entries, and is audited", async () => {
    const w = await world();
    const { id } = await holding(w, { daily: "50", total: "90" });
    // On ETH/USDT: the standing instruction owns the BTC/USDT position.
    const gridId = await w.create(
      grid(w.now(), {
        instrument: "ETH-USDT",
        lowerPrice: "2850",
        upperPrice: "3150",
        rangeStopPrice: "2800",
      }),
    );
    await w.pass();
    assert.equal(
      (await w.desk.place(w.scope, limit("ct_kill_dash"))).status,
      "working",
    );
    assert.equal(
      (await w.desk.place(w.scope, stopLimit("ct_kill_held"))).status,
      "held",
    );
    const result = await w.runner.store.killSwitch(w.scope);
    assert.equal(result.pausedStrategies, 2);
    assert.equal(result.cancelledTriggers, 1);
    assert.equal(result.closingEntries, 6);
    await w.pass();
    await w.pass();
    for (const strategyId of [id, gridId]) {
      const strategy = await w.strategy(strategyId);
      assert.equal(strategy.status, "paused");
      assert.equal(strategy.pauseReason, "kill_switch");
      assert.ok(
        (await entries(strategyId)).every((entry) =>
          ["closed", "not_filled"].includes(entry.state ?? ""),
        ),
      );
    }
    const [dashboard] = await database.admin<
      { state: string; exit_reason: string }[]
    >`
      select r.state, r.exit_reason from entry_reconciliations r
      join order_intents i on i.id = r.order_intent_id
      where i.idempotency_key = 'ct_kill_dash'
    `;
    assert.deepEqual(dashboard, {
      state: "not_filled",
      exit_reason: "kill_switch",
    });
    const [held] = await database.admin<{ status: string }[]>`
      select status from order_intents where idempotency_key = 'ct_kill_held'
    `;
    assert.equal(held.status, "cancelled");
    assert.ok((await notifications(w.scope)).includes("critical:kill_switch"));
    assert.equal(
      (await auditEvents(w.scope, "kill_switch.activated")).length,
      1,
    );
  });

  test("a new version keeps open entries on their version, and the kind cannot change", async () => {
    const w = await world();
    const id = await w.create(grid(w.now()));
    await w.pass();
    const changed = await w.runner.store.newVersion(
      w.scope,
      id,
      1,
      grid(w.now(), { lossLimits: { daily: "40", total: "100" } }),
    );
    assert.equal(changed.result, "saved");
    const made = await database.admin<{ strategy_version: number }[]>`
      select strategy_version from trade_proposals where strategy_id = ${id}
    `;
    assert.ok(made.every((entry) => entry.strategy_version === 1));
    assert.equal((await w.strategy(id)).version, 2);
    assert.equal(
      (await w.runner.store.newVersion(w.scope, id, 1, grid(w.now()))).result,
      "conflict",
    );
    const dca = draft({
      name: "No",
      allocation: "100",
      ai: null,
      rules: {
        kind: "dca",
        instrument: "BTC-USDT",
        marketKind: "spot",
        amountPerBuy: "10",
        interval: "1d",
        startsAt: w.now().toISOString(),
        maxBuys: 10,
        stopLossPercent: "5",
        takeProfitPercent: "5",
        holdingPeriodSeconds: 86_400,
        lossLimits: { daily: "10", total: "20" },
      },
    });
    assert.equal(
      (await w.runner.store.newVersion(w.scope, id, 2, dca)).result,
      "refused",
    );
    const versions = await auditEvents(w.scope, "strategy.version_created");
    assert.equal(versions.length, 1);
  });

  test("a loss limit reached while Close all is selling stops and alerts once", async () => {
    const w = await world();
    const { id } = await holding(w, { daily: "3", total: "10" });
    assert.equal((await w.runner.store.closeAll(w.scope, id)).result, "saved");
    w.fake.setPrice("BTC-USDT", "56900");
    for (let pass = 0; pass < 4; pass++) await w.pass();
    assert.equal(
      (await auditEvents(w.scope, "strategy.loss_limit_reached")).length,
      1,
    );
    assert.deepEqual(
      (await notifications(w.scope)).filter((kind) =>
        kind.endsWith("loss_limit_reached"),
      ),
      ["critical:loss_limit_reached"],
    );
    const strategy = await w.strategy(id);
    assert.equal(strategy.status, "paused");
    assert.ok(strategy.lossLimitReachedAt);
    assert.ok(
      (await entries(id)).every((entry) =>
        ["closed", "not_filled"].includes(entry.state ?? ""),
      ),
    );
  });

  test("a grid that left its range runs again under a new version for a new range", async () => {
    const w = await world();
    const id = await w.create(grid(w.now()));
    await w.pass();
    w.fake.setPrice("BTC-USDT", "63500");
    for (let pass = 0; pass < 3; pass++) await w.pass();
    assert.equal((await w.strategy(id)).status, "retired");
    const saved = await w.runner.store.newVersion(
      w.scope,
      id,
      1,
      grid(w.now(), {
        lowerPrice: "62000",
        upperPrice: "68000",
        rangeStopPrice: "61000",
      }),
    );
    assert.equal(saved.result, "saved");
    const running = await w.strategy(id);
    assert.equal(running.status, "simulation");
    assert.equal(running.exitRequest, null);
    assert.equal(running.rulesEndedAt, null);
    await w.pass();
    await w.pass();
    // Buys rest at 63,000 and 62,000, below the market, and stay.
    const placed = (await entries(id)).filter(
      (entry) =>
        entry.intent_status === "acknowledged" && entry.state === "working",
    );
    assert.deepEqual(
      placed.map((entry) => new Decimal(entry.entry_price).toFixed()),
      ["63000", "62000"],
    );
    assert.ok(placed.every((entry) => entry.exit_reason === null));
  });

  test("the worker's routes check drafts, create, list and control strategies, and approve a strategy's proposal under its limits", async () => {
    const w = await world();
    const routes = strategyRoutes(w.runner);
    const call = <Body>(
      definition: { handle(context: never): Promise<object> },
      body?: Body,
    ) =>
      definition.handle({
        exchange: w.fake,
        account: w.scope,
        query: {},
        body,
      } as never) as Promise<Record<string, unknown>>;
    // The allocation is too small for the grid's six buys.
    const invalid = (await call(routes.create, {
      ...grid(w.now()),
      allocation: "500",
    })) as { change: StrategyChange };
    assert.equal(invalid.change.result, "invalid");
    assert.match(invalid.change.message, /can commit 600 at once/);
    const created = (await call(routes.create, grid(w.now()))) as {
      change: StrategyChange;
    };
    assert.equal(created.change.result, "saved");
    const id = created.change.strategy!.id;
    assert.equal(created.change.strategy?.allocation, "600");
    const listed = (await call(routes.list)) as { state: StrategiesState };
    assert.deepEqual(
      listed.state.strategies.map((strategy) => strategy.id),
      [id],
    );
    assert.equal(listed.state.aiSource.kind, "fixture");
    assert.equal(listed.state.limits.current?.maxDailyDrawdownPercent, "50");
    const paused = (await call(routes.pause, { strategyId: id })) as {
      change: StrategyChange;
    };
    assert.equal(paused.change.strategy?.status, "paused");
    const resumed = (await call(routes.resume, { strategyId: id })) as {
      change: StrategyChange;
    };
    assert.equal(resumed.change.strategy?.status, "simulation");

    // A strategy's draft goes to the strategy, not the dashboard's desk.
    const ai = await w.create(
      draft({
        name: "AI",
        allocation: "200",
        ai: { proposalApproval: "required", analysisIntervalMinutes: 60 },
        rules: {
          kind: "ai_managed",
          allowedInstruments: ["ETH-USDT"],
          marketKind: "spot",
          allowShort: false,
          maxLeverage: 1,
          maxPositionNotional: "200",
          maxProtectedEntries: 3,
          holdingPeriodSeconds: 3_600,
          takeProfitAdjustable: false,
          lossLimits: { daily: "20", total: "50" },
        },
      }),
    );
    await w.pass();
    const [draftEntry] = await entries(ai);
    const approvals = decisions({
      proposals: w.proposals,
      now: () => w.now().getTime(),
      deskFor: () => w.desk,
      disabledMessage: () => "",
      strategies: w.runner,
      instruments: async () => ["BTC-USDT", "ETH-USDT"],
    });
    const approved = (await call(approvals.approve, {
      proposalId: draftEntry.id,
    })) as { outcome: { status: string } };
    assert.equal(approved.outcome.status, "working");
    assert.equal((await entries(ai))[0].status, "approved");
  });

  test("a strategy trades only markets the venue lists and the account allows, quoted in its accounting currency", async () => {
    const w = await world();
    const routes = strategyRoutes(w.runner);
    const create = async (value: StrategyDraft) =>
      (
        (await routes.create.handle({
          exchange: w.fake,
          account: w.scope,
          query: {},
          body: value,
        } as never)) as { change: StrategyChange }
      ).change;
    const solGrid = (instrument: string) =>
      grid(w.now(), {
        instrument,
        lowerPrice: "140",
        upperPrice: "170",
        rangeStopPrice: "130",
      });
    const allow = (instruments: string[]) =>
      database.admin`
        update exchange_accounts set allowed_instruments = ${instruments}
        where id = ${w.scope.exchangeAccountId}
      `;
    // The venue does not list it.
    const unlisted = await create(solGrid("SOL-USDT"));
    assert.equal(unlisted.result, "refused");
    assert.equal(
      unlisted.message,
      "Binance Spot Testnet does not list SOL-USDT.",
    );
    // Listed, but outside the account's default allowed instruments.
    w.fake.setPrice("SOL-USDT", "160");
    const outside = await create(solGrid("SOL-USDT"));
    assert.equal(outside.result, "refused");
    assert.match(
      outside.message,
      /SOL\/USDT is not among this exchange account's allowed instruments: BTC\/USDT, ETH\/USDT/,
    );
    // Allowed, but quoted in BTC, not the account's USDT (ADR 0009).
    w.fake.setPrice("ETH-BTC", "0.05");
    await allow(["BTC-USDT", "ETH-USDT", "SOL-USDT", "ETH-BTC"]);
    const quoted = await create(
      grid(w.now(), {
        instrument: "ETH-BTC",
        lowerPrice: "0.04",
        upperPrice: "0.07",
        rangeStopPrice: "0.03",
      }),
    );
    assert.equal(quoted.result, "refused");
    assert.match(quoted.message, /quoted in BTC, not in .* USDT/);
    // Once the customer widens the list, the strategy starts and trades.
    const saved = await create(solGrid("SOL-USDT"));
    assert.equal(saved.result, "saved", saved.message);
    const state = await w.state();
    assert.deepEqual(
      state.markets.map((market) => market.instrument),
      ["BTC-USDT", "ETH-USDT", "SOL-USDT"],
    );
    await w.pass();
    assert.ok((await entries(saved.strategy!.id)).length > 0);
    // Narrowed again: the strategy opens nothing more in that market.
    await allow(["BTC-USDT"]);
    const placed = await entries(saved.strategy!.id);
    // Frees a level, which the grid would otherwise buy again.
    w.fake.cancelElsewhere(placed[0].idempotency_key!);
    await w.pass();
    await w.pass();
    assert.equal((await entries(saved.strategy!.id)).length, placed.length);
    assert.match(
      (await w.strategy(saved.strategy!.id)).runnerNote,
      /not among this exchange account's allowed instruments/,
    );
  });

  test("a read-only venue starts no strategy and a running one opens no entries", async () => {
    const w = await world();
    const id = await w.create(grid(w.now()));
    const venue = VENUES["binance-spot-testnet"] as {
      capabilities: VenueCapabilities;
    };
    const original = venue.capabilities;
    venue.capabilities = { ...original, access: "read_only", funds: "real" };
    try {
      const created = (
        (await strategyRoutes(w.runner).create.handle({
          exchange: w.fake,
          account: w.scope,
          query: {},
          body: grid(w.now()),
        } as never)) as { change: StrategyChange }
      ).change;
      assert.equal(created.result, "refused");
      assert.match(created.message, /read only/);
      await w.pass();
      assert.equal((await entries(id)).length, 0);
      assert.equal(w.fake.count("placeProtectedEntry"), 0);
    } finally {
      venue.capabilities = original;
    }
    await w.pass();
    assert.ok((await entries(id)).length > 0);
  });

  test("a strategy cannot start without the portfolio's drawdown limit", async () => {
    const scope = await addCustomer();
    const runner = new StrategyRunner({
      database: database.app,
      proposals: new PostgresTradeProposals(database.app),
      intents: new PostgresOrderIntents(database.app),
      decisions: new RecordedDecisionSource(),
    });
    const created = await runner.store.create(
      scope,
      grid(new Date()),
      new Date(),
    );
    assert.equal(created.result, "refused");
  });

  // ADR 0009: exchange accounts are isolated.

  /** Another exchange account of `customerId`, which the worker may not trade on. */
  async function addAccount(
    customerId: string,
    {
      exchange = "binance-spot-testnet",
      accountingCurrency = "USDT",
      allowed = ["BTC-USDT", "ETH-USDT"],
    } = {},
  ): Promise<AccountScope> {
    const scope = { customerId, exchangeAccountId: randomUUID() };
    await withCustomerScope(
      database.app,
      customerId,
      (tx) => tx`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status,
            allowed_instruments)
        values (${scope.exchangeAccountId}, ${customerId}, ${exchange},
          ${`Account ${scope.exchangeAccountId.slice(0, 8)}`}, 'simulation',
          ${accountingCurrency}, 'connected', ${allowed})
      `,
    );
    return scope;
  }

  /** A standing instruction with one entry, 0.001 at 59,900 (59.9 notional). */
  const oneEntry = (now: Date, name: string, instrument = "BTC-USDT") =>
    draft({
      name,
      allocation: "100",
      ai: null,
      rules: {
        kind: "standing_price_instruction",
        instrument,
        marketKind: "spot",
        direction: "long",
        leverage: 1,
        entries: [
          {
            quantity: "0.001",
            entryPrice: "59900",
            stopLossPrice: "55000",
            takeProfitPrice: "62000",
          },
        ],
        entryExpiresAt: new Date(now.getTime() + DAY).toISOString(),
        holdingPeriodSeconds: 86_400,
        lossLimits: { daily: "3", total: "10" },
      },
    });

  /** That entry, as the runner asks the store to reserve it. */
  const entryOf = (strategyId: string, now: Date): EntryCandidate => ({
    strategyId,
    key: "entry:0",
    once: false,
    intent: {
      key: "entry:0",
      instrument: "BTC-USDT",
      marketKind: "spot",
      direction: "long",
      leverage: 1,
      quantity: "0.001",
      entryPrice: "59900",
      stopLossPrice: "55000",
      takeProfitPrice: "62000",
      entryExpiresAt: new Date(now.getTime() + DAY).toISOString(),
      holdingPeriodSeconds: 86_400,
    },
    rationale: "Standing entry 1",
    sourceSnapshotId: randomUUID(),
    proposalId: randomUUID(),
    freeStopOrders: 5,
  });

  test("the same instrument on two exchange accounts is two positions, each owned by its own strategy and never netted", async () => {
    const w = await world();
    // On the worker's account, Standing holds BTC.
    const { id: standing } = await holding(w);
    const second = await addAccount(w.scope.customerId);
    await w.runner.store.changePortfolioLimits(second, "50", 0);

    // Another strategy on the same account waits for Standing's position.
    const sameAccount = await w.create(oneEntry(w.now(), "Same account"));
    const waits = await w.runner.store.reserve(
      w.scope,
      entryOf(sameAccount, w.now()),
      w.now(),
    );
    assert.equal(waits.status, "refused");
    assert.equal(waits.status === "refused" && waits.waits, true);

    // On the second account, BTC is a separate position. Its strategy may
    // hold 59.9 USDT of BTC; Standing's 59.9 on the first account does not
    // count against it, as it would if positions were netted or summed.
    const created = await w.runner.store.create(
      second,
      oneEntry(w.now(), "Elsewhere"),
      w.now(),
    );
    assert.equal(created.result, "saved", created.message);
    const elsewhere = created.result === "saved" ? created.strategy.id : "";
    const reserved = await w.runner.store.reserve(
      second,
      entryOf(elsewhere, w.now()),
      w.now(),
    );
    assert.equal(
      reserved.status,
      "saved",
      reserved.status === "refused" ? reserved.reason : "",
    );
    // Its proposal, reservation and allocation are the second account's.
    const [row] = await database.admin<
      { proposal_account: string; allocation_account: string; amount: string }[]
    >`
      select p.exchange_account_id as proposal_account,
        a.exchange_account_id as allocation_account, b.amount::text
      from trade_proposals p
      join budget_reservations b on b.proposal_id = p.id
      join allocations a on a.id = b.allocation_id
      where p.strategy_id = ${elsewhere}
    `;
    assert.equal(row.proposal_account, second.exchangeAccountId);
    assert.equal(row.allocation_account, second.exchangeAccountId);
    assert.equal(new Decimal(row.amount).toFixed(), "59.9");

    // The kill switch on the second account leaves the first alone.
    const killed = await w.runner.store.killSwitch(second);
    assert.equal(killed.pausedStrategies, 1);
    const first = await w.strategy(standing);
    assert.equal(first.status, "simulation");
    assert.equal(first.exitRequest, null);
    assert.equal((await w.strategy(sameAccount)).status, "simulation");
  });

  test("a read-only exchange account is never the target of a strategy or its entries", async () => {
    const w = await world();
    const htx = await addAccount(w.scope.customerId, { exchange: "htx" });
    await w.runner.store.changePortfolioLimits(htx, "50", 0);
    const refused = await w.runner.store.create(
      htx,
      oneEntry(w.now(), "On HTX"),
      w.now(),
    );
    assert.equal(refused.result, "refused");
    assert.match(refused.message, /read only/);

    // A strategy whose account becomes read only opens nothing, and cannot
    // take a new version.
    const later = await addAccount(w.scope.customerId);
    await w.runner.store.changePortfolioLimits(later, "50", 0);
    const created = await w.runner.store.create(
      later,
      oneEntry(w.now(), "Was tradable"),
      w.now(),
    );
    assert.equal(created.result, "saved");
    const id = created.result === "saved" ? created.strategy.id : "";
    await database.admin`
      update exchange_accounts set exchange = 'htx'
      where id = ${later.exchangeAccountId}
    `;
    const entry = await w.runner.store.reserve(
      later,
      entryOf(id, w.now()),
      w.now(),
    );
    assert.equal(entry.status, "refused");
    assert.match(entry.status === "refused" ? entry.reason : "", /read only/);
    const version = await w.runner.store.newVersion(
      later,
      id,
      1,
      oneEntry(w.now(), "Renamed"),
    );
    assert.equal(version.result, "refused");
    assert.match(version.message, /read only/);
    assert.equal((await entries(id)).length, 0);
  });

  test("a strategy keeps its exchange account for life", async () => {
    const w = await world();
    const id = await w.create(oneEntry(w.now(), "Home"));
    const second = await addAccount(w.scope.customerId);
    await w.runner.store.changePortfolioLimits(second, "50", 0);
    // Neither a new version nor an entry can reach it through another account.
    const moved = await w.runner.store.newVersion(
      second,
      id,
      1,
      oneEntry(w.now(), "Moved"),
    );
    assert.equal(moved.result, "refused");
    assert.equal(moved.message, "There is no such strategy.");
    const entry = await w.runner.store.reserve(
      second,
      entryOf(id, w.now()),
      w.now(),
    );
    assert.equal(entry.status, "refused");
    const [row] = await database.admin<
      { exchange_account_id: string; current_version: number }[]
    >`
      select exchange_account_id, current_version from strategies
      where id = ${id}
    `;
    assert.deepEqual(row, {
      exchange_account_id: w.scope.exchangeAccountId,
      current_version: 1,
    });
  });

  test("a strategy's allocation is in its exchange account's accounting currency", async () => {
    const w = await world();
    const euro = await addAccount(w.scope.customerId, {
      accountingCurrency: "EUR",
      allowed: ["BTC-EUR", "BTC-USDT"],
    });
    await w.runner.store.changePortfolioLimits(euro, "50", 0);
    // A USDT market would need a conversion, so it is refused.
    const usdt = await w.runner.store.create(
      euro,
      oneEntry(w.now(), "USDT on EUR"),
      w.now(),
    );
    assert.equal(usdt.result, "refused");
    assert.match(usdt.message, /quoted in USDT/);
    const created = await w.runner.store.create(
      euro,
      oneEntry(w.now(), "EUR", "BTC-EUR"),
      w.now(),
    );
    assert.equal(created.result, "saved", created.message);
    const id = await w.create(oneEntry(w.now(), "USDT"));
    const currencies = await database.admin<
      { strategy_id: string; currency: string }[]
    >`
      select strategy_id, currency from allocations
      where strategy_id in ${database.admin([
        created.result === "saved" ? created.strategy.id : "",
        id,
      ])}
    `;
    assert.deepEqual(
      Object.fromEntries(
        currencies.map((row) => [row.strategy_id, row.currency]),
      ),
      {
        [created.result === "saved" ? created.strategy.id : ""]: "EUR",
        [id]: "USDT",
      },
    );
  });
});
