import assert from "node:assert/strict";
import { test } from "node:test";
import { protectedLegIds } from "@crypto-trading/exchanges";
import {
  deskFixture,
  limit,
  market,
  type Behaviour,
} from "./fixtures/fake-exchange";
import { MemoryOrderIntents } from "./fixtures/memory-order-intents";
import {
  MemoryRiskLimits,
  TEST_RISK_LIMITS,
} from "./fixtures/memory-risk-limits";
import { loadManualTradingConfig, RiskLimitsNotSet } from "./manual-orders";

const scope = {
  customerId: "7c0e4a52-1b6d-4f3e-8a9b-0c1d2e3f4a01",
  exchangeAccountId: "7c0e4a52-1b6d-4f3e-8a9b-0c1d2e3f4a02",
};

function desk(
  behaviour?: Behaviour,
  env: Record<string, string> = {},
  intents = new MemoryOrderIntents(),
  gate?: Promise<void>,
) {
  const fixture = deskFixture({ behaviour, env, intents, scope, gate });
  return {
    ...fixture,
    intents,
    intent: (id: string) => intents.intents.get(id),
  };
}

test("a limit entry passes the worker's checks, is saved first and rests with pending exits", async () => {
  const f = desk();
  const outcome = await f.desk.place(limit("ct_rest"));
  assert.equal(outcome.status, "working");
  assert.match(outcome.message, /when it fills completely/);
  assert.deepEqual(f.calls, {
    test: 1,
    place: 1,
    cancelList: 0,
    cancelOrder: 0,
  });
  const intent = f.intent("ct_rest");
  assert.equal(intent?.status, "acknowledged");
  assert.equal(
    intent?.order.kind === "protected_entry" && intent.order.entry.timeInForce,
    "GTC",
  );
  // The legs Binance reported with a quantity: the entry, not yet its exits.
  assert.deepEqual([...f.intents.orders.keys()], ["ct_rest_en"]);
  assert.ok(f.changes() > 0);
});

test("an order ID is never submitted twice, even after a restart", async () => {
  const f = desk();
  assert.equal((await f.desk.place(limit("ct_once"))).status, "working");
  assert.equal((await f.desk.place(limit("ct_once"))).status, "duplicate");
  const restarted = desk("rest", {}, f.intents);
  assert.equal(
    (await restarted.desk.place(limit("ct_once"))).status,
    "duplicate",
  );
  assert.equal(f.calls.place + restarted.calls.place, 1);
});

test("the worker re-runs every check and sends nothing that fails", async () => {
  const f = desk();
  for (const overrides of [
    { quantity: "0.002" },
    { stopLossPrice: "61000" },
    { price: "60000.001" },
  ]) {
    const outcome = await f.desk.place(limit("ct_checked", overrides));
    assert.equal(outcome.status, "rejected");
    assert.ok(outcome.checks?.some((check) => !check.passed));
  }
  const outsideScope = desk("rest", {
    TESTNET_MANUAL_INSTRUMENTS: "ETH-USDT",
  });
  const outcome = await outsideScope.desk.place(limit("ct_scope"));
  assert.match(
    outcome.checks?.find((check) => check.name === "limits")?.detail ?? "",
    /outside the strategy's allowed instruments/,
  );
  assert.equal(
    (await f.desk.place({ ...limit("ct_x"), side: "SELL" })).status,
    "invalid",
  );
  assert.deepEqual(f.calls, {
    test: 0,
    place: 0,
    cancelList: 0,
    cancelOrder: 0,
  });
});

test("a Binance rejection burns the ID and reports Binance's reason", async () => {
  const f = desk("reject");
  const outcome = await f.desk.place(limit("ct_rejected"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /insufficient balance/);
  assert.equal(f.intent("ct_rejected")?.status, "rejected");
  assert.equal((await f.desk.place(limit("ct_rejected"))).status, "duplicate");
});

test("an unknown outcome is looked up by client ID and never resubmitted", async () => {
  const placed = desk("timeout_placed");
  const lost = desk("timeout_not_placed");
  assert.equal(
    (await placed.desk.place(limit("ct_timeout"))).status,
    "working",
  );
  assert.equal(placed.intent("ct_timeout")?.status, "acknowledged");
  const unknown = await lost.desk.place(limit("ct_lost"));
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.listClientOrderId, "ct_lost");
  assert.equal(lost.intent("ct_lost")?.status, "unknown");
  assert.equal((await lost.desk.place(limit("ct_lost"))).status, "duplicate");
  // Binance may still be executing it, so it is not called missing yet.
  assert.equal((await lost.desk.status("ct_lost")).status, "unknown");
  lost.advance(61_000);
  assert.equal((await lost.desk.status("ct_lost")).status, "not_found");
  // Only reconciliation may decide that an unknown outcome failed.
  assert.equal(lost.intent("ct_lost")?.status, "unknown");
  assert.equal((await lost.desk.status("../escape")).status, "invalid");
  assert.equal(placed.calls.place + lost.calls.place, 2);
});

test("a status check waits for a placement still in flight", async () => {
  let release!: () => void;
  const f = desk(
    "rest",
    {},
    undefined,
    new Promise((done) => (release = done)),
  );
  const placing = f.desk.place(limit("ct_flight"));
  await new Promise(setImmediate);
  const status = f.desk.status("ct_flight");
  release();
  assert.equal((await status).status, "working");
  assert.equal((await placing).status, "working");
});

test("only Binance's does-not-exist answer proves an order was not placed", async () => {
  const f = desk("lookup_refused");
  // A signature or clock rejection says nothing about the order.
  assert.equal((await f.desk.place(limit("ct_refused"))).status, "unknown");
  const status = await f.desk.status("ct_refused");
  assert.equal(status.status, "unknown");
  assert.doesNotMatch(status.message, /not placed/);
});

test("a rate-limited submission is reported as not placed and burns its ID", async () => {
  const f = desk("rate_limited");
  const outcome = await f.desk.place(limit("ct_limited"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /Try again in 30 seconds/);
  assert.equal(f.intent("ct_limited")?.status, "rejected");
  assert.equal((await f.desk.place(limit("ct_limited"))).status, "duplicate");
});

test("a market entry is a bounded fill-or-kill limit whose exits are confirmed on Binance", async () => {
  const f = desk("fill");
  const outcome = await f.desk.place(market("ct_market"));
  assert.equal(outcome.status, "protected");
  assert.match(outcome.message, /take profit at 63000 and stop loss at 58000/);
  const order = f.intent("ct_market")?.order;
  assert.ok(order?.kind === "protected_entry");
  assert.equal(order.entry.timeInForce, "FOK");
  assert.equal(order.entry.price, "60300");
  const off = desk("fill", {
    TESTNET_MARKET_MAX_SLIPPAGE_PERCENT: "",
  });
  const disabled = await off.desk.place(market("ct_off"));
  assert.equal(disabled.status, "rejected");
  assert.match(disabled.checks?.[0].detail ?? "", /Market orders are off/);
});

test("a filled entry whose exits Binance did not place is reported as unprotected", async () => {
  const failed = desk("fill_without_exits");
  const expired = desk("fok_expire");
  const outcome = await failed.desk.place(market("ct_bare"));
  assert.equal(outcome.status, "protection_failed");
  assert.equal(outcome.unprotectedQuantity, "0.001");
  assert.match(outcome.message, /no exits/);
  const nothing = await expired.desk.place(market("ct_fok"));
  assert.equal(nothing.status, "not_filled");
  assert.match(nothing.message, /Nothing was bought/);
});

test("concurrent orders cannot both claim the same allocation", async () => {
  const f = desk("rest", { TESTNET_MANUAL_ALLOCATION_USDT: "100" });
  const outcomes = await Promise.all([
    f.desk.place(limit("ct_first")),
    f.desk.place(limit("ct_second")),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["working", "rejected"],
  );
  assert.match(
    outcomes[1].checks?.find((check) => check.name === "limits")?.detail ?? "",
    /enough uncommitted allocation/,
  );
  const ticket = await f.desk.ticket();
  assert.equal(ticket.policy.reservedBudget, "60");
});

test("cancelling any leg cancels the list, and leaving a filled quantity bare needs explicit acceptance", async () => {
  const f = desk();
  await f.desk.place(limit("ct_cancel"));
  const ids = protectedLegIds("ct_cancel");
  const takeProfit = f.orders.get(ids.takeProfit)!;
  const outcome = await f.desk.cancel({
    instrument: "BTC-USDT",
    orderId: takeProfit.orderId,
    acceptUnprotected: false,
  });
  assert.equal(outcome.status, "cancelled");
  assert.match(outcome.message, /every order in the list/);
  assert.equal(f.calls.cancelList, 1);
  assert.equal(f.orders.get(ids.entry)?.status, "CANCELED");

  await f.desk.place(limit("ct_partial"));
  const entry = protectedLegIds("ct_partial").entry;
  f.orders.set(entry, {
    ...f.orders.get(entry)!,
    executedQty: "0.0004",
    status: "PARTIALLY_FILLED",
  });
  const request = {
    instrument: "BTC-USDT",
    orderId: f.orders.get(entry)!.orderId,
    acceptUnprotected: false,
  };
  const confirm = await f.desk.cancel(request);
  assert.equal(confirm.status, "confirmation_required");
  assert.equal(confirm.unprotectedQuantity, "0.0004");
  assert.equal(f.calls.cancelList, 1);
  const accepted = await f.desk.cancel({
    ...request,
    acceptUnprotected: true,
  });
  assert.equal(accepted.status, "cancelled");
  assert.match(accepted.message, /0.0004 is held without exits/);
  assert.equal((await f.desk.cancel(request)).status, "not_open");
  assert.equal(
    (await f.desk.cancel({ ...request, orderId: 1 })).status,
    "invalid",
  );
});

test("without the customer's risk limits, nothing is sent", async () => {
  const f = deskFixture({
    intents: new MemoryOrderIntents(),
    scope,
    risk: new MemoryRiskLimits(),
  });
  await assert.rejects(f.desk.ticket(), RiskLimitsNotSet);
  const outcome = await f.desk.place(limit("ct_no_limits"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /Settings → Risk limits/);
  assert.equal(f.calls.test + f.calls.place, 0);
});

test("the latest risk limits are read before every order, within the platform maximums", async () => {
  const risk = new MemoryRiskLimits({ limits: TEST_RISK_LIMITS });
  const f = deskFixture({ intents: new MemoryOrderIntents(), scope, risk });
  const ticket = await f.desk.ticket();
  assert.deepEqual(ticket.riskLimits, { version: 1, ...TEST_RISK_LIMITS });
  assert.equal(ticket.policy.maxPositionNotional, "100");
  assert.equal((await f.desk.place(limit("ct_v1"))).status, "working");

  // Lowered between orders: the next order meets the new cap.
  await risk.change(scope, { ...TEST_RISK_LIMITS, maxOrderNotional: "50" }, 1);
  const refused = await f.desk.place(limit("ct_v2"));
  assert.equal(refused.status, "rejected");
  assert.deepEqual(
    refused.checks?.filter((check) => !check.passed).map((check) => check.name),
    ["limits", "cap"],
  );
  assert.equal(f.calls.place, 1);

  // A version saved above today's platform maximum is lowered to it.
  await risk.change(
    scope,
    { ...TEST_RISK_LIMITS, maxOrderNotional: "5000" },
    2,
  );
  assert.equal((await f.desk.ticket()).riskLimits.maxOrderNotional, "1000");
});

test("the daily risk limit counts today's entries at their stops", async () => {
  const intents = new MemoryOrderIntents();
  const risk = new MemoryRiskLimits({
    // Each test order loses 0.001 × (60000 − 58000) = 2 USDT at its stop.
    limits: { ...TEST_RISK_LIMITS, maxDailyRisk: "5" },
    intents,
  });
  const f = deskFixture({ intents, scope, risk });
  assert.equal((await f.desk.place(limit("ct_day_1"))).status, "working");
  assert.equal((await f.desk.ticket()).dailyRiskUsed, "2");
  assert.equal((await f.desk.place(limit("ct_day_2"))).status, "working");
  const third = await f.desk.place(limit("ct_day_3"));
  assert.equal(third.status, "rejected");
  assert.deepEqual(
    third.checks?.filter((check) => !check.passed).map((check) => check.name),
    ["daily_risk"],
  );
  // A tighter stop fits what is left.
  assert.equal(
    (await f.desk.place(limit("ct_day_4", { stopLossPrice: "59500" }))).status,
    "working",
  );
  assert.equal(f.calls.place, 3);
});

test("dashboard orders stay off until every limit is configured explicitly", () => {
  const env = {
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
  };
  const loaded = loadManualTradingConfig(env);
  assert.ok(loaded.ok);
  assert.equal(loaded.config.marketSlippage, null);
  for (const [key, value] of [
    ["TESTNET_MANUAL_INSTRUMENTS", ""],
    ["TESTNET_MANUAL_INSTRUMENTS", "BTC-USDT,btcusdt"],
    ["TESTNET_MANUAL_INSTRUMENTS", "BTC-USDT,BTCUSDT"],
    ["TESTNET_MANUAL_ALLOCATION_USDT", ""],
    ["TESTNET_MANUAL_ALLOCATION_USDT", "0"],
    ["TESTNET_MARKET_MAX_SLIPPAGE_PERCENT", "6"],
    ["TESTNET_MARKET_MAX_SLIPPAGE_PERCENT", "0"],
  ])
    assert.equal(
      loadManualTradingConfig({ ...env, [key]: value }).ok,
      false,
      `${key}=${value}`,
    );
});

test("the intent is saved before the order is sent", async () => {
  let release!: () => void;
  const f = desk(
    "rest",
    {},
    undefined,
    new Promise((done) => (release = done)),
  );
  const placing = f.desk.place(limit("ct_saved"));
  while (!f.calls.place) await new Promise(setImmediate);
  // Binance has the request; the intent is already on record.
  assert.equal(f.intent("ct_saved")?.status, "submitting");
  release();
  assert.equal((await placing).status, "working");
  assert.equal(f.intent("ct_saved")?.status, "acknowledged");
});

test("an order that cannot be saved is not sent", async () => {
  const intents = new MemoryOrderIntents();
  intents.record = async () => {
    throw new Error("database unavailable");
  };
  const f = desk("rest", {}, intents);
  const outcome = await f.desk.place(limit("ct_unsaved"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /could not be saved, so nothing was sent/);
  assert.equal(f.calls.place, 0);
});

test("each customer sees only their own orders", async () => {
  const f = desk();
  const other = f.desk.as({
    customerId: "7c0e4a52-1b6d-4f3e-8a9b-0c1d2e3f4b01",
    exchangeAccountId: scope.exchangeAccountId,
  });
  assert.equal((await f.desk.place(limit("ct_mine"))).status, "working");
  const status = await other.status("ct_mine");
  assert.equal(status.status, "not_found");
  assert.match(status.message, /no record/);
  // An ID is never reused, whoever used it first.
  assert.equal((await other.place(limit("ct_mine"))).status, "duplicate");
  const ticket = await other.ticket();
  assert.equal(
    ticket.policy.customerId,
    "7c0e4a52-1b6d-4f3e-8a9b-0c1d2e3f4b01",
  );
  assert.equal((await f.desk.ticket()).policy.customerId, scope.customerId);
  assert.equal(f.calls.place, 1);
});

test("a cancel records what Binance cancelled", async () => {
  const f = desk();
  await f.desk.place(limit("ct_gone"));
  const entry = f.orders.get(protectedLegIds("ct_gone").entry)!;
  await f.desk.cancel({
    instrument: "BTC-USDT",
    orderId: entry.orderId,
    acceptUnprotected: false,
  });
  assert.deepEqual(
    f.intents.cancelled.map(({ clientOrderId, status }) => [
      clientOrderId,
      status,
    ]),
    ["en", "tp", "sl"].map((leg) => [`ct_gone_${leg}`, "CANCELED"]),
  );
  assert.equal(f.intents.orders.get("ct_gone_en")?.status, "CANCELED");
});

test("an order whose limits cannot be read is not sent", async () => {
  const intents = new MemoryOrderIntents();
  intents.entryPrices = async () => {
    throw new Error("database unavailable");
  };
  const f = desk("rest", {}, intents);
  const outcome = await f.desk.place(limit("ct_unchecked"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message, /nothing was sent/);
  assert.equal(f.calls.place, 0);
});

test("an unexpected error after sending leaves the outcome unknown", async () => {
  const f = desk();
  f.exchange.placeProtectedEntry = async () => {
    throw new TypeError("unparseable response");
  };
  await assert.rejects(f.desk.place(limit("ct_odd")), /unparseable/);
  assert.equal(f.intent("ct_odd")?.status, "unknown");
  assert.equal((await f.desk.place(limit("ct_odd"))).status, "duplicate");
});

const stopLimit = (id: string, overrides = {}) => ({
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

test("a stop-limit entry is checked and held by the worker, with nothing sent to Binance", async () => {
  const f = desk();
  const outcome = await f.desk.place(stopLimit("ct_stop"));
  assert.equal(outcome.status, "held");
  assert.match(outcome.message, /at or above 61000/);
  assert.deepEqual(f.calls, {
    test: 1,
    place: 0,
    cancelList: 0,
    cancelOrder: 0,
  });
  assert.equal(f.intent("ct_stop")?.status, "pending");
  assert.equal((await f.desk.status("ct_stop")).status, "held");
  assert.equal((await f.desk.place(stopLimit("ct_stop"))).status, "duplicate");
  // It reserves its value, so later orders cannot claim the same allocation.
  const ticket = await f.desk.ticket();
  assert.equal(ticket.policy.reservedBudget, "61.1");

  // A stop at or below the ask would trigger at once, so it is refused.
  const refused = await f.desk.place(
    stopLimit("ct_stop_low", { stopPrice: "59900" }),
  );
  assert.equal(refused.status, "rejected");
  assert.equal(f.intent("ct_stop_low"), undefined);
});

test("a triggered stop-limit entry is claimed once, checked again and sent as a limit entry", async () => {
  const intents = new MemoryOrderIntents();
  const f = desk("rest", {}, intents);
  await f.desk.place(stopLimit("ct_stop_send"));
  const sent = await f.desk.submitTrigger(scope, "ct_stop_send");
  assert.equal(sent?.status, "working");
  assert.equal(f.calls.place, 1);
  assert.equal(f.intent("ct_stop_send")?.status, "acknowledged");
  // Another worker, or a second pass, finds it no longer pending.
  assert.equal(await f.desk.submitTrigger(scope, "ct_stop_send"), undefined);
  assert.equal(f.calls.place, 1);

  // Checks that fail when it triggers reject it; nothing is sent. Here the
  // per-order cap was lowered while it was held.
  await f.desk.place(stopLimit("ct_stop_over"));
  const other = deskFixture({
    intents,
    scope,
    risk: new MemoryRiskLimits({
      limits: { ...TEST_RISK_LIMITS, maxOrderNotional: "50" },
    }),
  });
  const refused = await other.desk.submitTrigger(scope, "ct_stop_over");
  assert.equal(refused?.status, "rejected");
  assert.equal(other.calls.place, 0);
  assert.equal(intents.intents.get("ct_stop_over")?.status, "rejected");
});

test("a market outside the account's allowed instruments is refused, whatever the worker trades", async () => {
  const intents = new MemoryOrderIntents();
  const f = deskFixture({
    intents,
    scope,
    env: { TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT,SOL-USDT" },
    // The customer allows BTC-USDT only, narrower than the worker.
    risk: new MemoryRiskLimits({
      limits: TEST_RISK_LIMITS,
      instruments: ["BTC-USDT"],
    }),
  });
  const ticket = await f.desk.ticket();
  assert.deepEqual(ticket.policy.allowedInstruments, ["BTC-USDT"]);
  assert.deepEqual(
    ticket.markets.map((entry) => entry.rules.instrument),
    ["BTC-USDT"],
  );
  for (const instrument of ["ETH-USDT", "SOL-USDT"]) {
    const outcome = await f.desk.place(
      limit(`ct_out_${instrument.slice(0, 3)}`, {
        instrument,
        quantity: "0.01",
        price: "3000",
        takeProfitPrice: "3100",
        stopLossPrice: "2900",
      }),
    );
    assert.equal(outcome.status, "rejected", instrument);
    const limits = outcome.checks?.find((check) => check.name === "limits");
    assert.equal(limits?.passed, false);
    assert.match(limits!.detail, /outside the strategy's allowed instruments/);
  }
  assert.equal(f.calls.place, 0);
  assert.equal((await f.desk.place(limit("ct_in_btc"))).status, "working");

  // An account that allows none of the worker's markets takes no orders.
  const closed = deskFixture({
    intents: new MemoryOrderIntents(),
    scope,
    risk: new MemoryRiskLimits({
      limits: TEST_RISK_LIMITS,
      instruments: ["SOL-USDT"],
    }),
  });
  const refused = await closed.desk.place(limit("ct_none"));
  assert.equal(refused.status, "rejected");
  assert.match(refused.message, /allows none of the markets/);
  assert.equal(closed.calls.place, 0);
});
