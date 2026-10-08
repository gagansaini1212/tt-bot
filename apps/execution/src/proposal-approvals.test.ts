import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  BinanceTestnetError,
  type AiDecisionRequest,
} from "@crypto-trading/exchanges";
import { deskFixture, limit, type Behaviour } from "./fixtures/fake-exchange";
import { MemoryOrderIntents } from "./fixtures/memory-order-intents";
import {
  MemoryRiskLimits,
  TEST_RISK_LIMITS,
} from "./fixtures/memory-risk-limits";
import { MemoryTradeProposals } from "./fixtures/memory-trade-proposals";
import { proposalClientOrderId } from "./trade-proposals";

const scope = {
  customerId: "3e1d2c4b-5a69-4f87-9b0a-1c2d3e4f5a01",
  exchangeAccountId: "3e1d2c4b-5a69-4f87-9b0a-1c2d3e4f5a02",
};
const other = {
  customerId: "3e1d2c4b-5a69-4f87-9b0a-1c2d3e4f5a03",
  exchangeAccountId: "3e1d2c4b-5a69-4f87-9b0a-1c2d3e4f5a02",
};

/** A desk whose customer has the assistant's stores; `intents` may be shared. */
function fixture(
  behaviour?: Behaviour,
  stores = (() => {
    const intents = new MemoryOrderIntents();
    return { intents, proposals: new MemoryTradeProposals(intents) };
  })(),
) {
  return { ...stores, ...deskFixture({ behaviour, scope, ...stores }) };
}

function proposal(overrides: Record<string, unknown> = {}): AiDecisionRequest {
  return {
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
      ...overrides,
    },
    model: "openai/gpt-6-luna",
    promptVersion: "assistant-2026-10-08",
    sourceSnapshotId: randomUUID(),
    rationale: "Support at 59,900 held twice today.",
    idempotencyKey: `session:${randomUUID()}`,
  };
}

async function draft(
  f: ReturnType<typeof fixture>,
  overrides?: Record<string, unknown>,
) {
  const decision = await f.proposals.record(
    scope,
    proposal(overrides),
    new Date(),
  );
  assert.equal(decision.proposal?.status, "draft");
  return decision.proposal!.id;
}

test("an approved proposal runs every check and is placed once as a protected limit entry", async () => {
  const f = fixture();
  const id = await draft(f);
  const outcome = await f.desk.approve(id);
  assert.equal(outcome.status, "working");
  assert.equal(f.calls.test, 1);
  assert.equal(f.calls.place, 1);
  const listId = proposalClientOrderId(id);
  assert.equal(outcome.listClientOrderId, listId);
  const intent = f.intents.intents.get(listId);
  assert.equal(intent?.status, "acknowledged");
  assert.deepEqual(intent?.order, {
    kind: "protected_entry",
    entry: {
      instrument: "BTC-USDT",
      quantity: "0.001",
      price: "59900",
      timeInForce: "GTC",
      takeProfitPrice: "63000",
      stopLossPrice: "58000",
      listClientOrderId: listId,
    },
  });
  const view = await f.proposals.view(scope, id, new Date());
  assert.equal(view?.status, "submitted");
  assert.equal(view?.decidedBy, "customer");
  assert.equal(view?.order?.entry?.status, "NEW");
});

test("a proposal is approved at most once, however often or wherever approval is clicked", async () => {
  const f = fixture();
  const id = await draft(f);
  // A double click: both requests reach the worker.
  const [first, second] = await Promise.all([
    f.desk.approve(id),
    f.desk.approve(id),
  ]);
  assert.deepEqual([first.status, second.status].toSorted(), [
    "duplicate",
    "working",
  ]);
  // Another tab, served by another worker on the same database.
  const elsewhere = deskFixture({ scope, ...f, behaviour: "rest" });
  const [again, there] = await Promise.all([
    f.desk.approve(id),
    elsewhere.desk.approve(id),
  ]);
  assert.equal(again.status, "duplicate");
  assert.equal(there.status, "duplicate");
  assert.match(again.message, /already approved/);
  assert.equal(f.calls.place + elsewhere.calls.place, 1);
});

test("two workers approving the same draft at once send it once", async () => {
  const f = fixture();
  const id = await draft(f);
  const elsewhere = deskFixture({ scope, ...f, behaviour: "rest" });
  const outcomes = await Promise.all([
    f.desk.approve(id),
    elsewhere.desk.approve(id),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).toSorted(), [
    "duplicate",
    "working",
  ]);
  assert.equal(f.calls.place + elsewhere.calls.place, 1);
});

test("an expired proposal cannot be approved", async () => {
  const f = fixture();
  const id = await draft(f, {
    entryExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  f.advance(61_000);
  const outcome = await f.desk.approve(id);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /expired/);
  assert.equal(f.calls.test + f.calls.place, 0);
  const view = await f.proposals.view(scope, id, new Date(Date.now() + 61_000));
  assert.equal(view?.status, "expired");
  assert.equal(view?.decidedBy, "expiry");
});

test("a proposal the execution checks refuse is rejected, with the reason, and never sent", async () => {
  const f = fixture();
  // 0.01 BTC at 59,900 is over the 100 USDT per-order cap and the allocation.
  const id = await draft(f, { quantity: "0.01" });
  const outcome = await f.desk.approve(id);
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.checks?.some((check) => !check.passed));
  const view = await f.proposals.view(scope, id, new Date());
  assert.equal(view?.status, "rejected");
  assert.equal(view?.decidedBy, "execution_checks");
  assert.match(view?.decisionReason ?? "", /Per-order cap/);
  assert.equal((await f.desk.approve(id)).status, "rejected");
  assert.equal(f.calls.test + f.calls.place, 0);
});

test("checks use the proposal as saved: a stop loss the market already passed is refused", async () => {
  const f = fixture();
  // The best ask is 60,000, so this entry would fill at once and its stop
  // would trigger as soon as Binance placed it.
  const id = await draft(f, {
    entryPrice: "61000",
    stopLossPrice: "60500",
    takeProfitPrice: "64000",
  });
  const outcome = await f.desk.approve(id);
  assert.equal(outcome.status, "rejected");
  assert.match(
    outcome.checks?.find((check) => check.label === "Stop loss")?.detail ?? "",
    /below the best ask/,
  );
  assert.equal(f.calls.place, 0);
});

test("Binance refusing the entry rejects the proposal; an outage leaves it a draft", async () => {
  const f = fixture();
  const refused = await draft(f);
  f.exchange.testProtectedEntry = async () => {
    throw new BinanceTestnetError(
      "rejected",
      -1013,
      undefined,
      "Filter failure: PRICE_FILTER",
    );
  };
  const outcome = await f.desk.approve(refused);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /PRICE_FILTER/);
  assert.equal(
    (await f.proposals.view(scope, refused, new Date()))?.status,
    "rejected",
  );

  const offline = await draft(f);
  f.exchange.getAccount = async () => {
    throw new BinanceTestnetError("unavailable");
  };
  assert.equal((await f.desk.approve(offline)).status, "rejected");
  assert.equal(
    (await f.proposals.view(scope, offline, new Date()))?.status,
    "draft",
  );
  assert.equal(f.calls.place, 0);
});

test("an unconfirmed approval is never resent; Binance refusing it shows as rejected", async () => {
  const lost = fixture("timeout_not_placed");
  const id = await draft(lost);
  assert.equal((await lost.desk.approve(id)).status, "unknown");
  assert.equal(
    (await lost.proposals.view(scope, id, new Date()))?.status,
    "approved",
  );
  assert.equal((await lost.desk.approve(id)).status, "duplicate");
  assert.equal(lost.calls.place, 1);

  const refused = fixture("reject");
  const refusedId = await draft(refused);
  assert.equal((await refused.desk.approve(refusedId)).status, "rejected");
  const view = await refused.proposals.view(scope, refusedId, new Date());
  assert.equal(view?.status, "rejected");
  assert.equal(view?.order?.intentStatus, "rejected");
});

test("a proposal whose entry fills shows as filled", async () => {
  const f = fixture("fill");
  const id = await draft(f);
  assert.equal((await f.desk.approve(id)).status, "protected");
  const view = await f.proposals.view(scope, id, new Date());
  assert.equal(view?.status, "filled");
  assert.equal(view?.order?.takeProfit?.status, "NEW");
});

test("approvals and dashboard orders share one allocation", async () => {
  const f = fixture();
  // Five 59.9 USDT dashboard orders leave 0.5 of the 300 USDT allocation.
  for (const n of [1, 2, 3, 4, 5])
    assert.equal(
      (await f.desk.place(limit(`ct_share${n}`, { price: "59900" }))).status,
      "working",
    );
  const id = await draft(f);
  const outcome = await f.desk.approve(id);
  assert.equal(outcome.status, "rejected");
  assert.match(
    outcome.checks?.find((check) => check.name === "limits")?.detail ?? "",
    /enough uncommitted allocation/,
  );
});

test("a customer can approve only their own proposals", async () => {
  const f = fixture();
  const id = await draft(f);
  const outcome = await f.desk.as(other).approve(id);
  assert.equal(outcome.status, "invalid");
  assert.equal(f.calls.place, 0);
  assert.equal(
    (await f.proposals.view(scope, id, new Date()))?.status,
    "draft",
  );
});

test("a rejected proposal cannot be approved", async () => {
  const f = fixture();
  const id = await draft(f);
  assert.ok(
    await f.proposals.reject(
      scope,
      id,
      { by: "customer", reason: "Too close to resistance." },
      new Date(),
    ),
  );
  assert.equal((await f.desk.approve(id)).status, "rejected");
  const view = await f.proposals.view(scope, id, new Date());
  assert.equal(view?.status, "rejected");
  assert.equal(view?.decisionReason, "Too close to resistance.");
  assert.equal(f.calls.place, 0);
});

test("approval reads the latest risk limits just before it sends anything", async () => {
  const intents = new MemoryOrderIntents();
  const proposals = new MemoryTradeProposals(intents);
  const risk = new MemoryRiskLimits({ intents });
  const f = {
    intents,
    proposals,
    ...deskFixture({ scope, intents, proposals, risk }),
  };
  // Without risk limits, nothing is decided and nothing is sent.
  const unset = await draft(f);
  const outcome = await f.desk.approve(unset);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /Set your risk limits/);
  assert.equal(
    (await proposals.view(scope, unset, new Date()))?.status,
    "draft",
  );

  // 0.001 BTC at 59,900 risks 1.9 USDT at its stop loss of 58,000.
  await risk.change(scope, { ...TEST_RISK_LIMITS, maxDailyRisk: "3" }, 0);
  assert.equal((await f.desk.approve(unset)).status, "working");
  // That approval counts against today's risk, so the next one is over.
  const second = await draft(f);
  const refused = await f.desk.approve(second);
  assert.equal(refused.status, "rejected");
  assert.match(
    refused.checks?.find((check) => check.name === "daily_risk")?.detail ?? "",
    /over the 3 USDT daily risk limit/,
  );
  // A change applies to the next approval.
  await risk.change(scope, { ...TEST_RISK_LIMITS, maxOrderNotional: "50" }, 1);
  const third = await draft(f);
  const capped = await f.desk.approve(third);
  assert.match(
    capped.checks?.find((check) => check.name === "cap")?.detail ?? "",
    /over the 50 USDT cap/,
  );
  assert.equal(f.calls.place, 1);
});

test("the proposal's order list ID is a valid Binance client ID and the same every time", () => {
  const id = "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a01";
  assert.equal(proposalClientOrderId(id), proposalClientOrderId(id));
  assert.match(proposalClientOrderId(id), /^ct_ai[A-Za-z0-9_-]{22}$/);
  assert.notEqual(
    proposalClientOrderId(id),
    proposalClientOrderId("0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a02"),
  );
});
