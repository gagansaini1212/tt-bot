import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import type {
  AiDecisionRequest,
  ExchangeOrder,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import { deskFixture } from "./fixtures/fake-exchange";
import { PostgresOrderIntents, RECONCILE_TOPIC } from "./order-intents";
import {
  PostgresTradeProposals,
  proposalClientOrderId,
  proposalEntry,
} from "./trade-proposals";

const hour = 3_600_000;

function proposal(
  overrides: Partial<
    Extract<AiDecisionRequest, { kind: "trade_proposal" }>["proposal"]
  > = {},
): AiDecisionRequest {
  return {
    kind: "trade_proposal",
    proposal: {
      instrument: "BTC-USDT",
      marketKind: "spot",
      direction: "long",
      quantity: "0.001",
      entryPrice: "59900.5",
      stopLossPrice: "58000",
      takeProfitPrice: "63000",
      leverage: 1,
      entryExpiresAt: new Date(Date.now() + hour).toISOString(),
      ...overrides,
    },
    model: "openai/gpt-6-luna",
    promptVersion: "assistant-2026-10-08",
    sourceSnapshotId: randomUUID(),
    rationale: "Support at 59,900 held twice today.",
    idempotencyKey: `session:${randomUUID()}`,
  };
}

const leg = (clientOrderId: string, fields: Partial<ExchangeOrder> = {}) =>
  ({
    instrument: "BTC-USDT",
    orderId: "51",
    clientOrderId,
    price: "59900.5",
    origQty: "0.001",
    executedQty: "0",
    cumulativeQuoteQty: "0",
    status: "NEW",
    type: "LIMIT",
    side: "BUY",
    orderListId: "7",
    ...fields,
  }) satisfies ExchangeOrder;

describe("AI decisions in PostgreSQL", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  let proposals: PostgresTradeProposals;
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

  async function draft(request = proposal()) {
    const decision = await proposals.record(mine, request, new Date());
    return decision.proposal!.id;
  }

  const order = async (id: string) => {
    const saved = await proposals.find(mine, id);
    return { kind: "protected_entry" as const, entry: proposalEntry(saved!)! };
  };

  before(async () => {
    database = await createTestDatabase();
    proposals = new PostgresTradeProposals(database.app);
    intents = new PostgresOrderIntents(database.app);
    mine = await customer();
    theirs = await customer();
  });
  after(() => database?.drop());

  test("a decision and its draft are recorded once per tool call, with what produced them", async () => {
    const request = proposal();
    const first = await proposals.record(mine, request, new Date());
    const again = await proposals.record(mine, request, new Date());
    assert.deepEqual(again, first);
    assert.equal(first.kind, "trade_proposal");
    assert.equal(first.model, "openai/gpt-6-luna");
    assert.equal(first.promptVersion, "assistant-2026-10-08");
    assert.equal(first.sourceSnapshotId, request.sourceSnapshotId);
    assert.equal(first.rationale, request.rationale);
    assert.deepEqual(
      {
        ...first.proposal,
        id: undefined,
        entryExpiresAt: undefined,
      },
      {
        id: undefined,
        instrument: "BTC-USDT",
        marketKind: "spot",
        direction: "long",
        quantity: "0.001",
        entryPrice: "59900.5",
        stopLossPrice: "58000",
        takeProfitPrice: "63000",
        leverage: 1,
        entryExpiresAt: undefined,
        strategyId: null,
        strategyVersion: null,
        status: "draft",
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        order: null,
      },
    );
    const [{ count }] = await database.admin<{ count: string }[]>`
      select count(*) from ai_decisions where idempotency_key = ${request.idempotencyKey}
    `;
    assert.equal(count, "1");
    const [audit] = await database.admin<
      { actor_type: string; actor_id: string; event_type: string }[]
    >`
      select actor_type, actor_id, event_type from audit_events
      where subject_id = ${first.id}
    `;
    assert.deepEqual(
      { ...audit },
      {
        actor_type: "assistant",
        actor_id: "openai/gpt-6-luna",
        event_type: "ai_decision.recorded",
      },
    );

    const noTrade = await proposals.record(
      mine,
      {
        kind: "no_trade",
        instrument: "ETH-USDT",
        model: "openai/gpt-6-luna",
        promptVersion: "assistant-2026-10-08",
        sourceSnapshotId: randomUUID(),
        rationale: "No setup: the price is mid-range.",
        idempotencyKey: `session:${randomUUID()}`,
      },
      new Date(),
    );
    assert.equal(noTrade.kind, "no_trade");
    assert.equal(noTrade.instrument, "ETH-USDT");
    assert.equal(noTrade.proposal, null);
    const listed = await proposals.decisions(mine, new Date(), 50);
    assert.equal(listed[0].id, noTrade.id);
    assert.ok(listed.some((decision) => decision.id === first.id));

    // A replay can arrive while the first call is still being saved.
    const replay = proposal();
    const replays = await Promise.all(
      Array.from({ length: 8 }, () =>
        proposals.record(mine, replay, new Date()),
      ),
    );
    assert.equal(new Set(replays.map((decision) => decision.id)).size, 1);
  });

  test("a customer sees and decides only their own proposals", async () => {
    const id = await draft();
    assert.deepEqual(await proposals.decisions(theirs, new Date(), 50), []);
    assert.equal(await proposals.view(theirs, id, new Date()), undefined);
    assert.equal(await proposals.find(theirs, id), undefined);
    assert.equal(
      await proposals.reject(theirs, id, { by: "customer" }, new Date()),
      false,
    );
    assert.equal(
      await proposals.approve(theirs, id, await order(id), new Date()),
      false,
    );
    assert.equal((await proposals.view(mine, id, new Date()))?.status, "draft");
  });

  test("approval claims the draft and saves its order intent together, at most once", async () => {
    const id = await draft();
    const results = await Promise.all(
      [1, 2, 3].map(async () =>
        proposals
          .approve(mine, id, await order(id), new Date())
          .catch(() => false),
      ),
    );
    assert.deepEqual(results.toSorted(), [false, false, true]);
    const intentRows = await database.admin<
      {
        status: string;
        idempotency_key: string;
        exchange_account_id: string;
        manual_order: unknown;
        job: string;
      }[]
    >`
      select i.status, i.idempotency_key, i.exchange_account_id, i.manual_order,
        j.topic as job
      from order_intents i
      join outbox_jobs j on j.deduplication_key = ${RECONCILE_TOPIC} || ':' || i.id
      where i.proposal_id = ${id}
    `;
    assert.equal(intentRows.length, 1);
    assert.equal(intentRows[0].status, "submitting");
    assert.equal(intentRows[0].idempotency_key, proposalClientOrderId(id));
    assert.equal(intentRows[0].exchange_account_id, mine.exchangeAccountId);
    assert.deepEqual(intentRows[0].manual_order, await order(id));
    const view = await proposals.view(mine, id, new Date());
    assert.equal(view?.status, "approved");
    assert.equal(view?.decidedBy, "customer");
    assert.equal(view?.order?.intentStatus, "submitting");
    // The database refuses a second order for the same proposal.
    await assert.rejects(
      withCustomerScope(
        database.app,
        mine.customerId,
        (tx) => tx`
          insert into order_intents
            (customer_id, exchange_account_id, proposal_id, idempotency_key, status)
          values (${mine.customerId}, ${mine.exchangeAccountId}, ${id},
            'ct_second', 'submitting')
        `,
      ),
      /order_intents_proposal_id_key/,
    );
  });

  test("an expired or decided draft cannot be approved", async () => {
    const soon = await draft(
      proposal({
        entryExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    assert.equal(await proposals.expire(mine, soon, new Date()), false);
    const later = new Date(Date.now() + 61_000);
    assert.equal((await proposals.view(mine, soon, later))?.status, "expired");
    assert.equal(
      await proposals.approve(mine, soon, await order(soon), later),
      false,
    );
    assert.equal(await proposals.expire(mine, soon, later), true);
    const expired = await proposals.view(mine, soon, later);
    assert.equal(expired?.decidedBy, "expiry");

    const rejected = await draft();
    assert.equal(
      await proposals.reject(
        mine,
        rejected,
        { by: "customer", reason: "Too close to resistance." },
        new Date(),
      ),
      true,
    );
    assert.equal(
      await proposals.reject(mine, rejected, { by: "customer" }, new Date()),
      false,
    );
    assert.equal(
      await proposals.approve(
        mine,
        rejected,
        await order(rejected),
        new Date(),
      ),
      false,
    );
    const view = await proposals.view(mine, rejected, new Date());
    assert.equal(view?.status, "rejected");
    assert.equal(view?.decisionReason, "Too close to resistance.");
  });

  test("the proposal's status follows its order on Binance", async () => {
    const id = await draft();
    assert.ok(await proposals.approve(mine, id, await order(id), new Date()));
    const listId = proposalClientOrderId(id);
    await intents.settle(mine, listId, {
      status: "acknowledged",
      orderListId: "7",
      orders: [leg(`${listId}_en`)],
    });
    assert.equal(
      (await proposals.view(mine, id, new Date()))?.status,
      "submitted",
    );
    await intents.recordOrders(mine, [
      leg(`${listId}_en`, {
        status: "FILLED",
        executedQty: "0.001",
        cumulativeQuoteQty: "59.9005",
      }),
      leg(`${listId}_tp`, {
        orderId: "52",
        side: "SELL",
        price: "63000",
        origQty: "0.00099",
      }),
    ]);
    const view = await proposals.view(mine, id, new Date());
    assert.equal(view?.status, "filled");
    assert.deepEqual(view?.order?.entry, {
      orderId: "51",
      status: "FILLED",
      filledQuantity: "0.001",
      averageFillPrice: "59900.5",
    });
    assert.equal(view?.order?.takeProfit?.status, "NEW");
    assert.equal(view?.order?.stopLoss, null);
    assert.ok(view?.order?.checkedAt);

    const refused = await draft();
    assert.ok(
      await proposals.approve(mine, refused, await order(refused), new Date()),
    );
    await intents.settle(mine, proposalClientOrderId(refused), {
      status: "rejected",
    });
    assert.equal(
      (await proposals.view(mine, refused, new Date()))?.status,
      "rejected",
    );
  });

  test("a strategy's proposal is listed, and the customer may reject it but not approve it here", async () => {
    const strategyId = randomUUID();
    const id = randomUUID();
    await withCustomerScope(database.app, mine.customerId, async (tx) => {
      await tx`
        insert into strategies
          (id, customer_id, exchange_account_id, name, status, current_version)
        values (${strategyId}, ${mine.customerId}, ${mine.exchangeAccountId},
          'AI-managed', 'simulation', 1)
      `;
      await tx`
        insert into strategy_versions (customer_id, strategy_id, version, rules)
        values (${mine.customerId}, ${strategyId}, 1, '{}')
      `;
      await tx`
        insert into trade_proposals (
          id, customer_id, exchange_account_id, strategy_id, strategy_version,
          source_snapshot_id, instrument, market_kind, direction, quantity,
          entry_price, stop_loss_price, take_profit_price, leverage,
          entry_expires_at, rationale, status
        )
        values (
          ${id}, ${mine.customerId}, ${mine.exchangeAccountId}, ${strategyId}, 1,
          ${randomUUID()}, 'BTC-USDT', 'spot', 'long', 0.001, 59000, 58000,
          61000, 1, now() + interval '1 hour', 'From the strategy.', 'draft'
        )
      `;
    });
    const listed = (await proposals.decisions(mine, new Date(), 50)).find(
      (decision) => decision.proposal?.id === id,
    );
    assert.equal(listed?.id, null);
    assert.equal(listed?.model, null);
    assert.equal(listed?.proposal?.strategyId, strategyId);
    assert.equal(listed?.proposal?.strategyVersion, 1);
    // Its strategy's limits decide an approval, not the dashboard's.
    assert.equal(
      await proposals.approve(mine, id, await order(id), new Date()),
      false,
    );
    assert.equal(
      await proposals.reject(mine, id, { by: "customer" }, new Date()),
      true,
    );
    // A proposal names both its strategy and version, or neither.
    await assert.rejects(
      withCustomerScope(
        database.app,
        mine.customerId,
        (tx) => tx`
          update trade_proposals set strategy_version = null where id = ${id}
        `,
      ),
      /trade_proposals_strategy_version_check/,
    );
  });

  test("the desk approves a saved proposal once and holds no transaction while Binance answers", async () => {
    let release!: () => void;
    const fixture = deskFixture({
      intents,
      proposals,
      scope: mine,
      gate: new Promise((done) => (release = done)),
    });
    const id = await draft();
    const approving = Promise.all([
      fixture.desk.approve(id),
      fixture.desk.approve(id),
    ]);
    while (!fixture.calls.place)
      await new Promise((done) => setTimeout(done, 5));
    const [{ role }] = await database.app<
      { role: string }[]
    >`select current_user as role`;
    const waiting = await database.admin`
      select state from pg_stat_activity
      where usename = ${role} and state like 'idle in transaction%'
    `;
    assert.equal(waiting.length, 0);
    release();
    const outcomes = await approving;
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["working", "duplicate"],
    );
    assert.equal(fixture.calls.place, 1);
    assert.equal(
      (await proposals.view(mine, id, new Date()))?.status,
      "submitted",
    );
  });
});
