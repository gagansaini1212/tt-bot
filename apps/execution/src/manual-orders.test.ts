import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BinanceTestnetError,
  protectedLegIds,
  type ManualOrderRequest,
  type ProtectedEntry,
  type SymbolRules,
  type TestnetInstrument,
  type TestnetOrder,
  type TestnetOrderList,
  type TestnetOrderListReport,
} from "@crypto-trading/exchanges";
import {
  loadManualTradingConfig,
  ManualOrderDesk,
  type ManualOrderExchange,
} from "./manual-orders";
import { OrderJournal } from "./order-journal";

const rules = (instrument: TestnetInstrument): SymbolRules => ({
  instrument,
  trading: true,
  protectedEntryAllowed: true,
  minPrice: "0.01",
  maxPrice: "1000000",
  tickSize: "0.01",
  minQty: "0.00001",
  maxQty: "9000",
  stepSize: "0.00001",
  minNotional: "5",
  maxNotional: "9000000",
});
const symbol = (instrument: TestnetInstrument) => instrument.replace("-", "");

type Behaviour =
  | "rest"
  | "fill"
  | "fill_without_exits"
  | "fok_expire"
  | "reject"
  | "timeout_placed"
  | "timeout_not_placed";

/** An in-memory exchange that models OPOCO lists the way Binance documents them. */
function fakeExchange(behaviour: Behaviour = "rest") {
  const calls = { test: 0, place: 0, cancelList: 0, cancelOrder: 0 };
  const orders = new Map<string, TestnetOrder>();
  const lists: TestnetOrderList[] = [];
  let nextId = 100;
  const open = () =>
    [...orders.values()].filter((order) =>
      ["NEW", "PARTIALLY_FILLED"].includes(order.status),
    );
  const exchange: ManualOrderExchange = {
    getAccount: async () => ({
      canTrade: true,
      balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    }),
    getOpenOrders: async (instrument) =>
      open().filter((order) => order.symbol === symbol(instrument)),
    getOpenOrderLists: async () =>
      lists.filter((list) => list.listOrderStatus === "EXECUTING"),
    getOrder: async (_instrument, clientOrderId) => {
      const order = orders.get(clientOrderId);
      if (!order) throw new BinanceTestnetError("rejected", -2013);
      return order;
    },
    getOrderList: async (listClientOrderId) => {
      const list = lists.find(
        (entry) => entry.listClientOrderId === listClientOrderId,
      );
      if (!list) throw new BinanceTestnetError("rejected", -2011);
      return list;
    },
    getSymbolRules: async () => [rules("BTC-USDT"), rules("ETH-USDT")],
    getDepth: async () => ({
      lastUpdateId: 1,
      bids: [{ price: "59999.00", quantity: "1" }],
      asks: [{ price: "60000.00", quantity: "1" }],
    }),
    testProtectedEntry: async () => {
      calls.test++;
    },
    placeProtectedEntry: async (entry: ProtectedEntry) => {
      calls.place++;
      if (behaviour === "reject")
        throw new BinanceTestnetError(
          "rejected",
          -2010,
          undefined,
          "Account has insufficient balance for requested action.",
        );
      if (behaviour === "timeout_not_placed")
        throw new BinanceTestnetError("unknown_outcome");
      const orderListId = nextId++;
      const ids = protectedLegIds(entry.listClientOrderId);
      const filled = ["fill", "fill_without_exits"].includes(behaviour);
      const leg = (
        clientOrderId: string,
        fields: Partial<TestnetOrder>,
      ): TestnetOrder => ({
        symbol: symbol(entry.instrument),
        orderId: nextId++,
        clientOrderId,
        price: "0",
        origQty: "0",
        executedQty: "0",
        cummulativeQuoteQty: "0",
        status: "PENDING_NEW",
        type: "LIMIT_MAKER",
        side: "SELL",
        orderListId,
        ...fields,
      });
      const legs = [
        leg(ids.entry, {
          side: "BUY",
          type: "LIMIT",
          price: entry.price,
          origQty: entry.quantity,
          executedQty: filled ? entry.quantity : "0",
          status:
            behaviour === "fok_expire" ? "EXPIRED" : filled ? "FILLED" : "NEW",
        }),
        leg(ids.takeProfit, { price: entry.takeProfitPrice }),
        leg(ids.stopLoss, {
          type: "STOP_LOSS",
          stopPrice: entry.stopLossPrice,
        }),
      ];
      for (const order of legs) orders.set(order.clientOrderId, order);
      const list = {
        orderListId,
        contingencyType: "OTO",
        listStatusType: "EXEC_STARTED",
        listOrderStatus: behaviour === "fok_expire" ? "ALL_DONE" : "EXECUTING",
        listClientOrderId: entry.listClientOrderId,
        symbol: symbol(entry.instrument),
        orders: legs.map(({ symbol, orderId, clientOrderId }) => ({
          symbol,
          orderId,
          clientOrderId,
        })),
      };
      lists.push(list);
      // Binance places or drops the exits just after reporting the fill.
      if (filled)
        for (const exit of legs.slice(1))
          orders.set(exit.clientOrderId, {
            ...exit,
            origQty: "0.00099",
            status: behaviour === "fill" ? "NEW" : "EXPIRED",
          });
      if (behaviour === "fok_expire")
        for (const exit of legs.slice(1))
          orders.set(exit.clientOrderId, { ...exit, status: "EXPIRED" });
      if (behaviour === "timeout_placed")
        throw new BinanceTestnetError("unknown_outcome");
      return { ...list, orderReports: legs } as TestnetOrderListReport;
    },
    cancelOrderList: async (_instrument, orderListId) => {
      calls.cancelList++;
      const list = lists.find((entry) => entry.orderListId === orderListId)!;
      list.listOrderStatus = "ALL_DONE";
      for (const { clientOrderId } of list.orders)
        orders.set(clientOrderId, {
          ...orders.get(clientOrderId)!,
          status: "CANCELED",
        });
      return { ...list, orderReports: [] } as TestnetOrderListReport;
    },
    cancelOrderById: async (_instrument, orderId) => {
      calls.cancelOrder++;
      const order = [...orders.values()].find(
        (entry) => entry.orderId === orderId,
      )!;
      orders.set(order.clientOrderId, { ...order, status: "CANCELED" });
      return order;
    },
  };
  return { exchange, calls, orders };
}

async function desk(
  behaviour?: Behaviour,
  env: Record<string, string> = {},
  directory?: string,
) {
  const journalDirectory =
    directory ?? (await mkdtemp(join(tmpdir(), "manual-orders-")));
  const loaded = loadManualTradingConfig({
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
    TESTNET_MAX_ORDER_NOTIONAL_USDT: "100",
    TESTNET_MARKET_MAX_SLIPPAGE_PERCENT: "0.5",
    ...env,
  });
  assert.ok(loaded.ok);
  const fake = fakeExchange(behaviour);
  let changes = 0;
  return {
    ...fake,
    journalDirectory,
    changes: () => changes,
    desk: new ManualOrderDesk({
      exchange: fake.exchange,
      config: loaded.config,
      journal: new OrderJournal(journalDirectory),
      onChange: () => changes++,
    }),
    journal: async (id: string) =>
      JSON.parse(await readFile(join(journalDirectory, `${id}.json`), "utf8")),
    cleanup: () => rm(journalDirectory, { recursive: true, force: true }),
  };
}

const limit = (id: string, overrides = {}): ManualOrderRequest => ({
  type: "limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  price: "60000",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: id,
  ...overrides,
});
const market = (id: string): ManualOrderRequest => ({
  type: "market",
  instrument: "BTC-USDT",
  quantity: "0.001",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: id,
});

test("a limit entry passes the worker's checks, is journalled first and rests with pending exits", async () => {
  const f = await desk();
  try {
    const outcome = await f.desk.place(limit("ct_rest"));
    assert.equal(outcome.status, "working");
    assert.match(outcome.message, /when it fills completely/);
    assert.deepEqual(f.calls, {
      test: 1,
      place: 1,
      cancelList: 0,
      cancelOrder: 0,
    });
    const record = await f.journal("ct_rest");
    assert.equal(record.status, "acknowledged");
    assert.equal(record.entry.timeInForce, "GTC");
    assert.ok(f.changes() > 0);
  } finally {
    await f.cleanup();
  }
});

test("an order ID is never submitted twice, even after a restart", async () => {
  const f = await desk();
  try {
    assert.equal((await f.desk.place(limit("ct_once"))).status, "working");
    assert.equal((await f.desk.place(limit("ct_once"))).status, "duplicate");
    const restarted = await desk("rest", {}, f.journalDirectory);
    assert.equal(
      (await restarted.desk.place(limit("ct_once"))).status,
      "duplicate",
    );
    assert.equal(f.calls.place + restarted.calls.place, 1);
  } finally {
    await f.cleanup();
  }
});

test("the worker re-runs every check and sends nothing that fails", async () => {
  const f = await desk();
  try {
    for (const overrides of [
      { quantity: "0.002" },
      { stopLossPrice: "61000" },
      { price: "60000.001" },
    ]) {
      const outcome = await f.desk.place(limit("ct_checked", overrides));
      assert.equal(outcome.status, "rejected");
      assert.ok(outcome.checks?.some((check) => !check.passed));
    }
    const outsideScope = await desk("rest", {
      TESTNET_MANUAL_INSTRUMENTS: "ETH-USDT",
    });
    const outcome = await outsideScope.desk.place(limit("ct_scope"));
    assert.match(
      outcome.checks?.find((check) => check.name === "limits")?.detail ?? "",
      /outside the strategy's allowed instruments/,
    );
    await outsideScope.cleanup();
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
  } finally {
    await f.cleanup();
  }
});

test("a Binance rejection burns the ID and reports Binance's reason", async () => {
  const f = await desk("reject");
  try {
    const outcome = await f.desk.place(limit("ct_rejected"));
    assert.equal(outcome.status, "rejected");
    assert.match(outcome.message, /insufficient balance/);
    assert.equal((await f.journal("ct_rejected")).status, "rejected");
    assert.equal(
      (await f.desk.place(limit("ct_rejected"))).status,
      "duplicate",
    );
  } finally {
    await f.cleanup();
  }
});

test("an unknown outcome is looked up by client ID and never resubmitted", async () => {
  const placed = await desk("timeout_placed");
  const lost = await desk("timeout_not_placed");
  try {
    assert.equal(
      (await placed.desk.place(limit("ct_timeout"))).status,
      "working",
    );
    assert.equal((await placed.journal("ct_timeout")).status, "acknowledged");
    const unknown = await lost.desk.place(limit("ct_lost"));
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.listClientOrderId, "ct_lost");
    assert.equal((await lost.journal("ct_lost")).status, "submission_pending");
    assert.equal((await lost.desk.place(limit("ct_lost"))).status, "duplicate");
    assert.equal((await lost.desk.status("ct_lost")).status, "not_found");
    assert.equal((await lost.desk.status("../escape")).status, "invalid");
    assert.equal(placed.calls.place + lost.calls.place, 2);
  } finally {
    await placed.cleanup();
    await lost.cleanup();
  }
});

test("a market entry is a bounded fill-or-kill limit whose exits are confirmed on Binance", async () => {
  const f = await desk("fill");
  try {
    const outcome = await f.desk.place(market("ct_market"));
    assert.equal(outcome.status, "protected");
    assert.match(
      outcome.message,
      /take profit at 63000 and stop loss at 58000/,
    );
    const { entry } = await f.journal("ct_market");
    assert.equal(entry.timeInForce, "FOK");
    assert.equal(entry.price, "60300");
    const off = await desk("fill", {
      TESTNET_MARKET_MAX_SLIPPAGE_PERCENT: "",
    });
    const disabled = await off.desk.place(market("ct_off"));
    assert.equal(disabled.status, "rejected");
    assert.match(disabled.checks?.[0].detail ?? "", /Market orders are off/);
    await off.cleanup();
  } finally {
    await f.cleanup();
  }
});

test("a filled entry whose exits Binance did not place is reported as unprotected", async () => {
  const failed = await desk("fill_without_exits");
  const expired = await desk("fok_expire");
  try {
    const outcome = await failed.desk.place(market("ct_bare"));
    assert.equal(outcome.status, "protection_failed");
    assert.equal(outcome.unprotectedQuantity, "0.001");
    assert.match(outcome.message, /no exits/);
    const nothing = await expired.desk.place(market("ct_fok"));
    assert.equal(nothing.status, "not_filled");
    assert.match(nothing.message, /Nothing was bought/);
  } finally {
    await failed.cleanup();
    await expired.cleanup();
  }
});

test("concurrent orders cannot both claim the same allocation", async () => {
  const f = await desk("rest", { TESTNET_MANUAL_ALLOCATION_USDT: "100" });
  try {
    const outcomes = await Promise.all([
      f.desk.place(limit("ct_first")),
      f.desk.place(limit("ct_second")),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["working", "rejected"],
    );
    assert.match(
      outcomes[1].checks?.find((check) => check.name === "limits")?.detail ??
        "",
      /enough uncommitted allocation/,
    );
    const ticket = await f.desk.ticket();
    assert.equal(ticket.policy.reservedBudget, "60");
  } finally {
    await f.cleanup();
  }
});

test("cancelling any leg cancels the list, and leaving a filled quantity bare needs explicit acceptance", async () => {
  const f = await desk();
  try {
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
      (await f.desk.cancel({ ...request, orderId: "1" })).status,
      "invalid",
    );
  } finally {
    await f.cleanup();
  }
});

test("dashboard orders stay off until every limit is configured explicitly", () => {
  const env = {
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
    TESTNET_MAX_ORDER_NOTIONAL_USDT: "100",
  };
  const loaded = loadManualTradingConfig(env);
  assert.ok(loaded.ok);
  assert.equal(loaded.config.marketSlippage, null);
  for (const [key, value] of [
    ["TESTNET_MANUAL_INSTRUMENTS", ""],
    ["TESTNET_MANUAL_INSTRUMENTS", "BTC-USDT,SOL-USDT"],
    ["TESTNET_MANUAL_ALLOCATION_USDT", ""],
    ["TESTNET_MANUAL_ALLOCATION_USDT", "0"],
    ["TESTNET_MAX_ORDER_NOTIONAL_USDT", "-5"],
    ["TESTNET_MARKET_MAX_SLIPPAGE_PERCENT", "6"],
    ["TESTNET_MARKET_MAX_SLIPPAGE_PERCENT", "0"],
  ])
    assert.equal(
      loadManualTradingConfig({ ...env, [key]: value }).ok,
      false,
      `${key}=${value}`,
    );
});
