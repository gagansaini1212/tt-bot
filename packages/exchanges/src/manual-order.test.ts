import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExchangeOrder } from "./contract.js";
import type { MarketRules } from "./market-catalogue.js";
import {
  cancelImpact,
  defaultStopLossPrice,
  manualCancelRequestSchema,
  manualExposure,
  manualOrderRequestSchema,
  manualRiskLimitsSchema,
  manualTestnetPolicy,
  planManualOrder,
  stopLossRisk,
  type ManualOrderRequest,
  type ManualOrderTicket,
} from "./manual-order.js";
import {
  closeOrderId,
  protectedEntryFilterIssues,
  protectedLeg,
  protectedLegIds,
  STRATEGY_LIST_PREFIX,
} from "./order-rules.js";

const rules: MarketRules = {
  instrument: "BTC-USDT",
  venueSymbol: "BTCUSDT",
  status: "trading",
  protectedEntryAllowed: true,
  minPrice: "0.01000000",
  maxPrice: "1000000.00000000",
  tickSize: "0.01000000",
  minQty: "0.00001000",
  maxQty: "9000.00000000",
  stepSize: "0.00001000",
  minNotional: "5.00000000",
  maxNotional: "9000000.00000000",
};
const account = {
  customerId: "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a01",
  exchangeAccountId: "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a02",
  accountAccess: "trade" as const,
};
const config = {
  allowedInstruments: ["BTC-USDT" as const],
  allocation: "300",
  maxOrderNotional: "100",
  marketSlippage: "0.005",
};
function ticket(
  overrides: Partial<ManualOrderTicket> = {},
  exposure = { committedCapital: "0", reservedBudget: "0" },
): ManualOrderTicket {
  return {
    capturedAt: "2027-01-15T08:00:00.000Z",
    policy: manualTestnetPolicy(config, exposure, account),
    riskLimits: {
      version: 3,
      maxOrderNotional: config.maxOrderNotional,
      maxDailyRisk: "10",
      defaultStopLossPercent: "2",
    },
    dailyRiskUsed: "0",
    marketSlippage: config.marketSlippage,
    freeUsdt: "1000",
    markets: [{ rules, bestAsk: "60000.00" }],
    ...overrides,
  };
}
const limit: ManualOrderRequest = {
  type: "limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  price: "60000",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: "ct_list_001",
};
const now = new Date("2027-01-15T08:00:05.000Z");
const ids = {
  proposalId: "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a60",
  sourceSnapshotId: "0b8f9a62-3f5e-4c1d-8a7b-1c2d3e4f5a61",
};
const failed = (request: ManualOrderRequest, overrides?: ManualOrderTicket) =>
  planManualOrder(request, overrides ?? ticket(), now, ids)
    .checks.filter((check) => !check.passed)
    .map((check) => check.name);

test("a limit entry inside every limit passes all checks as a resting GTC order", () => {
  const plan = planManualOrder(limit, ticket(), now, ids);
  assert.equal(plan.passed, true);
  assert.deepEqual(
    plan.checks.map((check) => check.name),
    ["limits", "cap", "daily_risk", "filters", "balance"],
  );
  assert.equal(plan.notional, "60");
  assert.equal(plan.entry?.timeInForce, "GTC");
  assert.match(
    plan.checks[0].detail,
    /300 of 300 USDT in the manual testnet allocation is uncommitted/,
  );
});

test("account limits come from authorizeTradeProposal and its explicit policy", () => {
  const policy = manualTestnetPolicy(
    config,
    { committedCapital: "0", reservedBudget: "0" },
    account,
  );
  assert.equal(policy.customerId, account.customerId);
  assert.equal(policy.exchangeAccountId, account.exchangeAccountId);
  assert.equal(policy.accountAccess, "trade");
  assert.equal(policy.accountingCurrency, "USDT");
  assert.equal(policy.tradingMode, "simulation");
  assert.equal(policy.liveTradingEnabled, false);
  assert.equal(policy.maxLeverage, 1);
  assert.equal(policy.maxPositionNotional, "100");
  assert.deepEqual(
    failed(
      limit,
      ticket({}, { committedCapital: "200", reservedBudget: "50" }),
    ),
    ["limits"],
  );
  const reason = planManualOrder(
    { ...limit, stopLossPrice: "61000" },
    ticket(),
    now,
    ids,
  ).checks.find((check) => check.name === "limits")?.detail;
  assert.match(reason ?? "", /protective sides/);
  assert.deepEqual(failed({ ...limit, instrument: "ETH-USDT" }), [
    "limits",
    "filters",
  ]);
});

test("a read-only exchange account fails the account limits for every order", () => {
  const readOnly = ticket({
    policy: manualTestnetPolicy(
      config,
      { committedCapital: "0", reservedBudget: "0" },
      { ...account, accountAccess: "read_only" },
    ),
  });
  const plan = planManualOrder(limit, readOnly, now, ids);
  assert.equal(plan.passed, false);
  const limits = plan.checks.find((check) => check.name === "limits");
  assert.equal(limits?.passed, false);
  assert.match(limits?.detail ?? "", /read only/);
});

test("the per-order cap, filters and free balance are checked separately", () => {
  // 0.002 BTC at 60000 is 120 USDT, over both the cap and the position limit.
  assert.deepEqual(failed({ ...limit, quantity: "0.002" }), ["limits", "cap"]);
  assert.deepEqual(failed({ ...limit, price: "60000.005" }), ["filters"]);
  assert.deepEqual(failed(limit, ticket({ freeUsdt: "59.99" })), ["balance"]);
});

test("the daily risk limit counts this order's loss at its stop with today's earlier orders", () => {
  // 0.001 BTC from 60000 down to 58000 loses 2 USDT at the stop.
  const plan = planManualOrder(
    limit,
    ticket({ dailyRiskUsed: "7.5" }),
    now,
    ids,
  );
  const check = plan.checks.find((entry) => entry.name === "daily_risk");
  assert.equal(check?.passed, true);
  assert.match(
    check?.detail ?? "",
    /loses about 2 USDT.*risk 9.5 of the 10 USDT/,
  );
  assert.deepEqual(failed(limit, ticket({ dailyRiskUsed: "8.01" })), [
    "daily_risk",
  ]);
  // Exactly at the limit is within it.
  assert.deepEqual(failed(limit, ticket({ dailyRiskUsed: "8" })), []);
  const over = planManualOrder(
    limit,
    ticket({ dailyRiskUsed: "8.01" }),
    now,
    ids,
  ).checks.find((entry) => entry.name === "daily_risk");
  assert.match(
    over?.detail ?? "",
    /already risk 8.01 USDT.*10 USDT daily risk limit set in Settings/,
  );
  assert.equal(
    stopLossRisk({
      price: "60000",
      stopLossPrice: "61000",
      quantity: "1",
    }).toFixed(),
    "0",
  );
});

test("the default stop loss rounds up to the tick so it never risks more than its percentage", () => {
  assert.equal(defaultStopLossPrice("60000", "2", "0.01"), "58800");
  // 60000.07 × 0.985 = 59100.06895, rounded up to 59100.07.
  assert.equal(defaultStopLossPrice("60000.07", "1.5", "0.01"), "59100.07");
  // 3333.33 × 0.97 = 3233.3301, rounded up to 3233.34.
  assert.equal(defaultStopLossPrice("3333.33", "3", "0.01"), "3233.34");
  // Rounding up to the entry leaves no stop.
  assert.equal(defaultStopLossPrice("1", "0.1", "1"), undefined);
});

test("risk limit changes accept bounded positive decimals only", () => {
  const valid = {
    maxOrderNotional: "250.5",
    maxDailyRisk: "40",
    defaultStopLossPercent: "2.25",
  };
  assert.ok(manualRiskLimitsSchema.safeParse(valid).success);
  for (const change of [
    { ...valid, maxOrderNotional: "0" },
    { ...valid, maxOrderNotional: "-5" },
    { ...valid, maxOrderNotional: "1e3" },
    { ...valid, maxDailyRisk: "0.000000001" },
    { ...valid, defaultStopLossPercent: "100" },
    { ...valid, defaultStopLossPercent: "2.255" },
    { ...valid, extra: true },
  ])
    assert.equal(
      manualRiskLimitsSchema.safeParse(change).success,
      false,
      JSON.stringify(change),
    );
});

test("Binance filters cover every leg and the exits' size after fees", () => {
  const valid = {
    quantity: "0.001",
    price: "60000",
    takeProfitPrice: "63000",
    stopLossPrice: "58000",
  };
  assert.deepEqual(protectedEntryFilterIssues(valid, rules), []);
  assert.match(
    protectedEntryFilterIssues(
      { ...valid, takeProfitPrice: "63000.001" },
      rules,
    ).join(" "),
    /Take-profit price must be a multiple of the 0.01 tick size/,
  );
  assert.match(
    protectedEntryFilterIssues({ ...valid, quantity: "0.0010001" }, rules).join(
      " ",
    ),
    /step size/,
  );
  assert.match(
    protectedEntryFilterIssues({ ...valid, quantity: "0.00008" }, rules).join(
      " ",
    ),
    /below Binance's minimum of 5 USDT/,
  );
  // 0.00009 BTC is 5.40 USDT, but 1% fees leave 0.00008 BTC, worth 4.64 USDT
  // at the stop loss.
  assert.match(
    protectedEntryFilterIssues({ ...valid, quantity: "0.00009" }, rules).join(
      " ",
    ),
    /After fees, the exits could fall below/,
  );
  assert.match(
    protectedEntryFilterIssues(valid, {
      ...rules,
      protectedEntryAllowed: false,
    }).join(" "),
    /does not accept entries with attached exits/,
  );
});

test("a market entry is a fill-or-kill limit bounded by the configured slippage", () => {
  const market: ManualOrderRequest = {
    type: "market",
    instrument: "BTC-USDT",
    quantity: "0.001",
    takeProfitPrice: "63000",
    stopLossPrice: "58000",
    listClientOrderId: "ct_list_002",
  };
  const plan = planManualOrder(
    market,
    ticket({ markets: [{ rules, bestAsk: "60000.01" }] }),
    now,
    ids,
  );
  assert.equal(plan.passed, true);
  // 60000.01 * 1.005 = 60300.01005, floored to the 0.01 tick.
  assert.equal(plan.entry?.price, "60300.01");
  assert.equal(plan.entry?.timeInForce, "FOK");
  assert.match(plan.checks[0].detail, /0.5% above the best ask/);
  assert.deepEqual(failed(market, ticket({ marketSlippage: null })), ["price"]);
  assert.deepEqual(
    failed(market, ticket({ markets: [{ rules, bestAsk: null }] })),
    ["price"],
  );
  // The target is checked against the bound, the stop against the ask.
  assert.deepEqual(failed({ ...market, takeProfitPrice: "60200" }), ["limits"]);
  assert.deepEqual(failed({ ...market, stopLossPrice: "60100" }), ["price"]);
  // A limit above the ask fills at the ask too.
  assert.deepEqual(
    failed({ ...limit, price: "60500", stopLossPrice: "60000" }),
    ["price"],
  );
  assert.deepEqual(
    failed({ ...limit, price: "60500", stopLossPrice: "59999.99" }),
    [],
  );
});

test("requests accept only buys with both exits and a ct_ list ID", () => {
  assert.ok(manualOrderRequestSchema.safeParse(limit).success);
  for (const invalid of [
    { ...limit, side: "SELL" },
    { ...limit, price: undefined },
    { ...limit, type: "market" },
    { ...limit, type: "stop_limit" },
    { ...limit, stopLossPrice: undefined },
    { ...limit, takeProfitPrice: "0" },
    { ...limit, quantity: "1e3" },
    { ...limit, quantity: "1".repeat(33) },
    { ...limit, listClientOrderId: "ct_" + "a".repeat(31) },
    { ...limit, listClientOrderId: "web_001" },
  ])
    assert.equal(
      manualOrderRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  // Order IDs are the venue's, as strings, whatever form the venue uses.
  for (const [orderId, valid] of [
    ["12", true],
    ["OU22CG-KLAF2-FWUDD7", true],
    [12, false],
    ["", false],
    ["12 OR 1=1", false],
    ["../12", false],
  ] as const)
    assert.equal(
      manualCancelRequestSchema.safeParse({
        instrument: "BTC-USDT",
        orderId,
        acceptUnprotected: false,
      }).success,
      valid,
      String(orderId),
    );
});

const order = (fields: Partial<ExchangeOrder>): ExchangeOrder => ({
  instrument: "BTC-USDT",
  orderId: "1",
  clientOrderId: "web_order",
  price: "60000",
  origQty: "0.001",
  executedQty: "0",
  cumulativeQuoteQty: "0",
  status: "NEW",
  type: "LIMIT",
  side: "BUY",
  orderListId: null,
  ...fields,
});
const legs = protectedLegIds("ct_list_001");
const entryLeg = order({
  orderId: "21",
  clientOrderId: legs.entry,
  orderListId: "7",
});
const takeProfit = order({
  orderId: "22",
  clientOrderId: legs.takeProfit,
  orderListId: "7",
  side: "SELL",
  type: "LIMIT_MAKER",
  price: "63000",
  status: "PENDING_NEW",
});
const stopLoss = order({
  orderId: "23",
  clientOrderId: legs.stopLoss,
  orderListId: "7",
  side: "SELL",
  type: "STOP_LOSS",
  price: "0",
  stopPrice: "58000",
  status: "PENDING_NEW",
});

test("exposure reserves open entries and commits positions held by open exits", () => {
  const journal = (id: string) => (id === "ct_list_001" ? "60000" : undefined);
  assert.deepEqual(
    manualExposure(
      [
        order({ executedQty: "0.0004" }),
        { ...entryLeg, executedQty: "0.0005" },
        takeProfit,
        stopLoss,
      ],
      journal,
    ),
    // Unfilled: 0.0006 + 0.0005 BTC. Filled: 0.0004 + 0.0005 BTC.
    { reservedBudget: "66", committedCapital: "54" },
  );
  const active = [
    { ...takeProfit, status: "NEW" },
    { ...stopLoss, status: "NEW" },
  ];
  assert.deepEqual(manualExposure(active, journal), {
    reservedBudget: "0",
    committedCapital: "60",
  });
  // Without a journal entry the take-profit price bounds the entry.
  assert.deepEqual(
    manualExposure(active, () => undefined),
    {
      reservedBudget: "0",
      committedCapital: "63",
    },
  );
});

test("a strategy's entries count against its own allocation, not the dashboard's", () => {
  const strategy = protectedLegIds(`${STRATEGY_LIST_PREFIX}abc`);
  assert.deepEqual(
    manualExposure(
      [
        { ...entryLeg, clientOrderId: strategy.entry, orderListId: "9" },
        {
          ...stopLoss,
          clientOrderId: strategy.stopLoss,
          orderListId: "9",
          status: "NEW",
        },
      ],
      () => "60000",
    ),
    { reservedBudget: "0", committedCapital: "0" },
  );
  // And the dashboard cannot use a strategy's client order IDs.
  assert.equal(
    manualOrderRequestSchema.safeParse({
      type: "limit",
      instrument: "BTC-USDT",
      quantity: "0.001",
      price: "60000",
      takeProfitPrice: "63000",
      stopLossPrice: "58000",
      listClientOrderId: `${STRATEGY_LIST_PREFIX}abc`,
    }).success,
    false,
  );
});

test("cancelling any list leg cancels the list and reports what loses its exits", () => {
  const pending = [entryLeg, takeProfit, stopLoss];
  assert.deepEqual(cancelImpact(takeProfit, pending), {
    cancels: pending,
    unprotectedQuantity: "0",
  });
  const partlyFilled = [
    { ...entryLeg, executedQty: "0.0004", status: "PARTIALLY_FILLED" },
    takeProfit,
    stopLoss,
  ];
  assert.equal(
    cancelImpact(partlyFilled[0], partlyFilled).unprotectedQuantity,
    "0.0004",
  );
  const active = [
    { ...takeProfit, status: "NEW", origQty: "0.00099" },
    { ...stopLoss, status: "NEW", origQty: "0.00099" },
  ];
  assert.equal(cancelImpact(active[1], active).unprotectedQuantity, "0.00099");
  const standalone = order({ orderId: "5" });
  assert.deepEqual(cancelImpact(standalone, [standalone, ...active]), {
    cancels: [standalone],
    unprotectedQuantity: "0",
  });
});

test("protected leg IDs round-trip and ignore other client IDs", () => {
  assert.deepEqual(protectedLeg(legs.stopLoss), {
    listClientOrderId: "ct_list_001",
    leg: "stopLoss",
  });
  assert.equal(protectedLeg("ct_dev_001"), undefined);
  assert.equal(protectedLeg("x_list_001_tp"), undefined);
  // The worker's sells closing an entry are not legs of its list.
  assert.equal(closeOrderId("ct_list_001", 2), "ct_list_001_c2");
  assert.equal(protectedLeg(closeOrderId("ct_list_001", 1)), undefined);
  assert.throws(() => closeOrderId("ct_list_001", 0));
  assert.throws(() => closeOrderId("not-ours", 1));
});

test("a stop-limit entry is planned as a resting limit entry held until its stop price", () => {
  const stopLimit: ManualOrderRequest = {
    type: "stop_limit",
    instrument: "BTC-USDT",
    quantity: "0.001",
    stopPrice: "61000",
    price: "61100",
    takeProfitPrice: "64000",
    stopLossPrice: "59000",
    listClientOrderId: "ct_list_stop",
  };
  const plan = planManualOrder(stopLimit, ticket(), now, ids);
  assert.equal(plan.passed, true);
  assert.deepEqual(
    plan.checks.map((check) => check.name),
    ["price", "limits", "cap", "daily_risk", "filters", "balance"],
  );
  assert.match(plan.checks[0].detail, /at or above 61000/);
  assert.equal(plan.entry?.timeInForce, "GTC");
  assert.equal(plan.entry?.price, "61100");
  assert.equal(plan.notional, "61.1");
  // A stop at or below the ask would trigger at once.
  assert.deepEqual(failed({ ...stopLimit, stopPrice: "60000" }), ["price"]);
  // A stop loss at or above the stop price would sell as soon as it bought.
  assert.deepEqual(
    failed({ ...stopLimit, stopLossPrice: "61000", price: "61500" }),
    ["price"],
  );
  // Its stop loss may sit above today's ask: it buys later, higher.
  assert.equal(
    planManualOrder(
      { ...stopLimit, stopLossPrice: "60500" },
      ticket(),
      now,
      ids,
    ).passed,
    true,
  );
  assert.deepEqual(
    failed(stopLimit, ticket({ markets: [{ rules, bestAsk: null }] })),
    ["price"],
  );
  assert.equal(
    manualOrderRequestSchema.safeParse({ ...stopLimit, stopPrice: undefined })
      .success,
    false,
  );
});
