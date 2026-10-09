import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { BinanceSpotTestnet } from "@crypto-trading/exchanges";
import type { AccountResolver } from "./accounts";
import { binanceExchangeInfo } from "./fixtures/binance-exchange-info";
import { fixedExchanges } from "./fixtures/fixed-exchanges";
import { MemoryOrderIntents } from "./fixtures/memory-order-intents";
import {
  MemoryRiskLimits,
  TEST_RISK_LIMITS,
} from "./fixtures/memory-risk-limits";
import { MemoryTradeProposals } from "./fixtures/memory-trade-proposals";
import { createRequestListener, handler, route, type Route } from "./http";
import { createRoutes } from "./routes";

const token = "http-test-token-at-least-32-characters";
const assistantToken = "http-test-assistant-token-at-least-32";

/**
 * Order intents and proposals that share one memory, as the database does,
 * and the customer's risk limits.
 */
function memory() {
  const intents = new MemoryOrderIntents();
  return {
    intents,
    proposals: new MemoryTradeProposals(intents),
    risk: new MemoryRiskLimits({ limits: TEST_RISK_LIMITS }),
  };
}
// The customer who owns the worker's exchange account.
const owner = {
  customerId: "5a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c01",
  exchangeAccountId: "5a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c02",
};
const ownerOnly: AccountResolver = async (customerId) =>
  customerId === owner.customerId ? owner : undefined;
const ticker = (symbol: string) => ({
  symbol,
  priceChange: "-1.50000000",
  priceChangePercent: "-2.500",
  lastPrice: "58.50000000",
  openPrice: "60.00000000",
  highPrice: "61.00000000",
  lowPrice: "57.00000000",
  volume: "1000.00000000",
  quoteVolume: "59000.00000000",
  openTime: 1_799_913_600_000,
  closeTime: 1_800_000_000_000,
});
const kline = (index: number) => [
  1_800_000_000_000 + index * 60_000,
  "60000.00000000",
  "60100.00000000",
  "59900.00000000",
  `${60000 + index}.00000000`,
  "1.00000000",
  1_800_000_059_999 + index * 60_000,
  "60000.00000000",
  10,
  "0.5",
  "30000",
  "0",
];

/** A Binance testnet adapter whose network is a fixture. */
function binance(respond?: (url: URL) => Response) {
  const calls: URL[] = [];
  const exchange = new BinanceSpotTestnet({
    apiKey: "test-key",
    apiSecret: "test-secret",
    fetch: (async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (respond) return respond(url);
      switch (url.pathname) {
        case "/api/v3/time":
          return Response.json({ serverTime: Date.now() });
        case "/api/v3/exchangeInfo":
          return Response.json(binanceExchangeInfo());
        case "/api/v3/account":
          return Response.json({ canTrade: true, balances: [] });
        case "/api/v3/openOrders":
        case "/api/v3/openOrderList":
        case "/api/v3/myTrades":
          return Response.json([]);
        case "/api/v3/ticker/24hr":
          return Response.json(["BTCUSDT", "ETHUSDT", "XRPUSDT"].map(ticker));
        case "/api/v3/klines":
          return Response.json([0, 1, 2, 3, 4].map(kline));
        case "/api/v3/depth":
          return Response.json({
            lastUpdateId: 7,
            bids: [
              ["60000.00", "1.0"],
              ["59999.00", "2.0"],
              ["59998.00", "3.0"],
            ],
            asks: [
              ["60001.00", "1.0"],
              ["60002.00", "2.0"],
              ["60003.00", "3.0"],
            ],
          });
      }
      throw new Error("Unexpected fixture endpoint");
    }) as typeof fetch,
  });
  const count = (path: string) =>
    calls.filter((url) => url.pathname === path).length;
  return { exchange, calls, count };
}

async function serve(
  t: TestContext,
  {
    exchange,
    routes,
    accounts = ownerOnly,
  }: {
    exchange?: BinanceSpotTestnet;
    routes?: Route[];
    accounts?: AccountResolver;
  } = {},
) {
  let now = 1_800_000_000_000;
  const server = createServer(
    createRequestListener({
      token,
      assistantToken,
      exchanges: fixedExchanges(exchange),
      accounts,
      routes: routes ?? createRoutes({ ...memory(), now: () => now }),
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Customer-Id": owner.customerId,
        ...init.headers,
      },
    });
  return {
    call,
    json: async (path: string) => {
      const response = await call(path);
      assert.equal(response.status, 200, path);
      return response.json();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const paths = [
  "/snapshot",
  "/market/tickers",
  "/market/klines?instrument=BTC-USDT&interval=1m",
  "/market/depth?instrument=ETH-USDT",
];

test("every route requires the token, refuses browsers and is never cached", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  for (const path of [...paths, "/unknown"]) {
    for (const headers of [
      { Authorization: "" } as Record<string, string>,
      { Authorization: `Bearer ${token.slice(1)}x` },
      { Authorization: `Bearer ${token}x` },
      { Origin: "http://localhost:3000" },
    ]) {
      const response = await call(path, { headers });
      assert.equal(response.status, 401, `${path} ${JSON.stringify(headers)}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { status: "unauthorized" });
    }
  }
  assert.equal(fake.calls.length, 0);
  for (const path of paths) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).status, "connected");
  }
});

test("unknown paths return 404 and other methods 405", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  for (const path of [
    "/",
    "/unknown",
    "/snapshot/",
    "//snapshot",
    "/market",
    "/market/tickers/",
    "/SNAPSHOT",
  ]) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "not_found" });
  }
  for (const [method, path] of [
    ["POST", "/snapshot"],
    ["DELETE", "/snapshot"],
    ["HEAD", "/market/tickers"],
    ["POST", "/market/depth?instrument=BTC-USDT"],
  ]) {
    const response = await call(path, { method });
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(fake.calls.length, 0);
});

test("query parameters are validated strictly", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  for (const path of [
    "/snapshot?refresh=1",
    "/market/tickers?symbols=",
    "/market/tickers?symbols=BTCUSDT,",
    "/market/tickers?symbols=btcusdt",
    "/market/tickers?symbols=BTC-USDT",
    "/market/tickers?symbols=BTCUSDT&symbols=ETHUSDT",
    `/market/tickers?symbols=${Array.from({ length: 501 }, (_, i) => `T${i}USDT`)}`,
    "/market/tickers?symbol=BTCUSDT",
    "/market/klines?instrument=BTC-USDT",
    "/market/klines?interval=1m",
    "/market/klines?instrument=btc-usdt&interval=1m",
    "/market/klines?instrument=BTCUSDT&interval=1m",
    "/market/klines?instrument=BTC-USDT&interval=1s",
    "/market/klines?instrument=BTC-USDT&interval=7m",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=0",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=1001",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=01",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=1e2",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=2.5",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=",
    "/market/klines?instrument=BTC-USDT&interval=1m&limit=-1",
    "/market/klines?instrument=BTC-USDT&interval=1m&startTime=0",
    "/market/depth",
    "/market/depth?instrument=BTC-USDT&limit=101",
    "/market/depth?instrument=BTC-USDT&instrument=ETH-USDT",
  ]) {
    const response = await call(path);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).status, "invalid_request", path);
  }
  assert.equal(fake.calls.length, 0);
  for (const path of [
    "/market/tickers?symbols=BTCUSDT",
    `/market/tickers?symbols=${encodeURIComponent("币安人生USDT,1000SATSUSDT")}`,
    "/market/klines?instrument=ETH-USDT&interval=1M&limit=1000",
    "/market/depth?instrument=BTC-USDT&limit=1",
  ])
    assert.equal((await call(path)).status, 200, path);
});

test("market routes filter and trim cached Binance data", async (t) => {
  const fake = binance();
  const { json } = await serve(t, { exchange: fake.exchange });
  const all = await json("/market/tickers");
  assert.deepEqual(
    all.tickers.map(({ symbol }: { symbol: string }) => symbol),
    ["BTCUSDT", "ETHUSDT", "XRPUSDT"],
  );
  assert.equal(all.tickers[0].priceChangePercent, "-2.500");
  const listed = await json("/market/tickers?symbols=XRPUSDT,NOPEUSDT,BTCUSDT");
  assert.deepEqual(
    listed.tickers.map(({ symbol }: { symbol: string }) => symbol),
    ["BTCUSDT", "XRPUSDT"],
  );

  const { klines } = await json(
    "/market/klines?instrument=BTC-USDT&interval=1h&limit=2",
  );
  assert.deepEqual(
    klines.map(({ close }: { close: string }) => close),
    ["60003.00000000", "60004.00000000"],
  );
  assert.equal(
    (await json("/market/klines?instrument=BTC-USDT&interval=1h")).klines
      .length,
    5,
  );
  const { depth } = await json("/market/depth?instrument=ETH-USDT&limit=2");
  assert.deepEqual(depth, {
    lastUpdateId: 7,
    bids: [
      { price: "60000.00", quantity: "1.0" },
      { price: "59999.00", quantity: "2.0" },
    ],
    asks: [
      { price: "60001.00", quantity: "1.0" },
      { price: "60002.00", quantity: "2.0" },
    ],
  });

  // Every symbol list, and every limit, was served from one Binance request.
  assert.equal(fake.count("/api/v3/ticker/24hr"), 1);
  assert.equal(fake.count("/api/v3/klines"), 1);
  assert.equal(fake.count("/api/v3/depth"), 1);
  // The catalogue was read once, to check both markets are listed.
  assert.equal(fake.count("/api/v3/exchangeInfo"), 1);
  const [tickers, klinesRequest, depthRequest] = fake.calls.filter(
    (url) => url.pathname !== "/api/v3/exchangeInfo",
  );
  assert.equal(tickers.search, "");
  assert.equal(klinesRequest.searchParams.get("limit"), "1000");
  assert.equal(klinesRequest.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(klinesRequest.searchParams.get("interval"), "1h");
  assert.equal(depthRequest.searchParams.get("limit"), "100");
  assert.equal(depthRequest.searchParams.get("symbol"), "ETHUSDT");
});

test("market routes refuse a market the venue does not list, without asking for its data", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  for (const path of [
    "/market/klines?instrument=SOL-USDT&interval=1h",
    "/market/depth?instrument=ETH-BTC",
  ]) {
    const response = await call(path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).status, "unknown_market");
  }
  assert.equal(fake.count("/api/v3/klines"), 0);
  assert.equal(fake.count("/api/v3/depth"), 0);
});

test("caches expire per route and coalesce concurrent requests", async (t) => {
  const fake = binance();
  const { json, advance } = await serve(t, { exchange: fake.exchange });
  const burst = (path: string) =>
    Promise.all(Array.from({ length: 5 }, () => json(path)));

  await burst("/market/tickers");
  advance(5_000);
  await json("/market/tickers?symbols=BTCUSDT");
  assert.equal(fake.count("/api/v3/ticker/24hr"), 1);
  advance(1);
  await json("/market/tickers");
  assert.equal(fake.count("/api/v3/ticker/24hr"), 2);

  await burst("/market/klines?instrument=BTC-USDT&interval=1m");
  await json("/market/klines?instrument=BTC-USDT&interval=1m&limit=1");
  assert.equal(fake.count("/api/v3/klines"), 1);
  // Each instrument and interval has its own entry.
  await json("/market/klines?instrument=BTC-USDT&interval=5m");
  await json("/market/klines?instrument=ETH-USDT&interval=1m");
  assert.equal(fake.count("/api/v3/klines"), 3);
  advance(5_001);
  await json("/market/klines?instrument=BTC-USDT&interval=1m");
  assert.equal(fake.count("/api/v3/klines"), 4);

  await burst("/market/depth?instrument=BTC-USDT");
  await json("/market/depth?instrument=BTC-USDT&limit=5");
  advance(1_000);
  await json("/market/depth?instrument=BTC-USDT");
  assert.equal(fake.count("/api/v3/depth"), 1);
  await json("/market/depth?instrument=ETH-USDT");
  assert.equal(fake.count("/api/v3/depth"), 2);
  advance(1);
  await json("/market/depth?instrument=BTC-USDT");
  assert.equal(fake.count("/api/v3/depth"), 3);

  await burst("/snapshot");
  advance(10_000);
  await json("/snapshot");
  assert.equal(fake.count("/api/v3/account"), 1);
  advance(1);
  await json("/snapshot");
  assert.equal(fake.count("/api/v3/account"), 2);
});

test("without an exchange, valid requests report not_configured", async (t) => {
  const { call, json } = await serve(t);
  for (const path of paths)
    assert.deepEqual(await json(path), {
      status: "not_configured",
      reason: "exchange",
      message:
        "Configure Binance Spot Testnet in the execution service to connect your virtual account.",
    });
  assert.equal((await call("/market/depth?limit=5")).status, 400);
});

test("customer routes serve only the customer who owns the exchange account", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  const customerRoutes = ["/snapshot", "/orders/ticket"];
  for (const path of customerRoutes) {
    for (const customer of [
      "",
      "not-a-uuid",
      `${owner.customerId}, ${owner.customerId}`,
    ]) {
      const response = await call(path, {
        headers: { "X-Customer-Id": customer },
      });
      assert.equal(response.status, 400, `${path} ${customer}`);
      assert.deepEqual(await response.json(), {
        status: "invalid_request",
        message: "Check the customer.",
      });
    }
    const stranger = await call(path, {
      headers: { "X-Customer-Id": "5a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2cff" },
    });
    assert.equal(stranger.status, 200);
    assert.equal((await stranger.json()).reason, "exchange_account");
  }
  assert.equal(fake.calls.length, 0);
  // Market data is public: it needs no customer.
  const market = await call("/market/tickers", {
    headers: { "X-Customer-Id": "" },
  });
  assert.equal((await market.json()).status, "connected");

  const offline = await serve(t, {
    exchange: fake.exchange,
    accounts: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  for (const path of customerRoutes)
    assert.deepEqual(await offline.json(path), {
      status: "not_configured",
      reason: "database",
      message:
        "The execution service cannot use its database. Check its output, then retry.",
    });
  assert.equal(
    fake.calls.filter((url) => url.pathname !== "/api/v3/ticker/24hr").length,
    0,
  );
});

test("exchange failures return 503 with a safe message and are not cached", async (t) => {
  let fail = true;
  const fake = binance((url) => {
    if (fail) throw new Error(`${url} test-secret`);
    return Response.json([]);
  });
  const { call } = await serve(t, { exchange: fake.exchange });
  const failed = await call("/market/tickers");
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.equal(body.status, "unavailable");
  assert.match(body.message, /Binance testnet request unavailable/);
  assert.doesNotMatch(
    JSON.stringify(body),
    /test-secret|test-key|binance\.vision/,
  );
  fail = false;
  assert.equal((await call("/market/tickers")).status, 200);

  const rejected = binance(() =>
    Response.json({ code: -1121, msg: "Invalid symbol." }, { status: 400 }),
  );
  const other = await serve(t, { exchange: rejected.exchange });
  const response = await other.call("/market/depth?instrument=BTC-USDT");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "unavailable",
    message: "Binance testnet request rejected (code -1121).",
  });
});

test("routes that declare a body receive it validated", async (t) => {
  const echo = route(
    "POST",
    "/echo",
    handler({
      query: z.strictObject({}),
      body: z.strictObject({ value: z.string() }),
      handle: async ({ body }) => ({ status: "connected", value: body.value }),
    }),
  );
  const { call } = await serve(t, {
    exchange: binance().exchange,
    routes: [echo],
  });
  const post = (body: string, type = "application/json") =>
    call("/echo", {
      method: "POST",
      body,
      headers: { "Content-Type": type },
    });
  const ok = await post(
    JSON.stringify({ value: "a" }),
    "application/json; charset=utf-8",
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "connected", value: "a" });
  for (const [body, type] of [
    [JSON.stringify({ value: "a" }), "text/plain"],
    ["{", "application/json"],
    [JSON.stringify({ value: 1 }), "application/json"],
    [JSON.stringify({ value: "a", extra: true }), "application/json"],
  ])
    assert.equal((await post(body, type)).status, 400, body);
  const large = await post(JSON.stringify({ value: "a".repeat(16 * 1024) }));
  assert.equal(large.status, 413);
  assert.equal((await call("/echo", { method: "GET" })).status, 405);
});

const order = {
  type: "limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  price: "59000",
  takeProfitPrice: "62000",
  stopLossPrice: "57000",
  listClientOrderId: "ct_http_001",
};
const post = (path: string, body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

test("order routes stay off until their limits are configured", async (t) => {
  const fake = binance();
  const { call, json } = await serve(t, {
    exchange: fake.exchange,
    routes: createRoutes({ ...memory(), env: {} }),
  });
  const ticket = await json("/orders/ticket");
  assert.equal(ticket.status, "connected");
  assert.match(ticket.disabled, /TESTNET_MANUAL_INSTRUMENTS/);
  const placed = await call("/orders", post("/orders", order));
  assert.equal(placed.status, 200);
  assert.equal((await placed.json()).outcome.status, "rejected");
  assert.equal(fake.calls.length, 0);
});

test("order routes take validated POST bodies and refuse other methods", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  for (const [path, body] of [
    ["/orders", { ...order, side: "SELL" }],
    ["/orders", { ...order, stopLossPrice: undefined }],
    ["/orders", { ...order, type: "stop_limit" }],
    ["/orders", { ...order, listClientOrderId: "web_1" }],
    // Order IDs are strings, as the snapshot reports them.
    [
      "/orders/cancel",
      { instrument: "BTC-USDT", orderId: 7, acceptUnprotected: false },
    ],
    ["/orders/cancel", { instrument: "SOL-USDT", orderId: 7 }],
  ] as const)
    assert.equal(
      (await call(path, post(path, body))).status,
      400,
      JSON.stringify(body),
    );
  for (const path of ["/orders", "/orders/cancel"]) {
    const response = await call(path);
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get("allow"), "POST");
  }
  assert.equal(
    (await call("/orders/status?listClientOrderId=../../etc")).status,
    400,
  );
  assert.equal((await call("/orders/ticket", { method: "POST" })).status, 405);
  assert.equal(fake.calls.length, 0);
});

test("a placement runs the worker's checks, clears the snapshot cache and is never sent twice", async (t) => {
  let placed = false;
  const list = {
    orderListId: 7,
    contingencyType: "OTO",
    listStatusType: "EXEC_STARTED",
    listOrderStatus: "EXECUTING",
    listClientOrderId: "ct_http_001",
    symbol: "BTCUSDT",
    orders: ["en", "sl", "tp"].map((leg, index) => ({
      symbol: "BTCUSDT",
      orderId: 20 + index,
      clientOrderId: `ct_http_001_${leg}`,
    })),
  };
  const fake = binance((url) => {
    switch (url.pathname) {
      case "/api/v3/time":
        return Response.json({ serverTime: Date.now() });
      case "/api/v3/account":
        return Response.json({
          canTrade: true,
          balances: [{ asset: "USDT", free: "1000", locked: "0" }],
        });
      case "/api/v3/exchangeInfo":
        return Response.json({
          symbols: ["BTC", "ETH"].map((base) => ({
            symbol: `${base}USDT`,
            baseAsset: base,
            quoteAsset: "USDT",
            status: "TRADING",
            orderTypes: ["LIMIT", "LIMIT_MAKER", "STOP_LOSS"],
            ocoAllowed: true,
            otoAllowed: true,
            opoAllowed: true,
            filters: [
              {
                filterType: "PRICE_FILTER",
                minPrice: "0.01",
                maxPrice: "1000000",
                tickSize: "0.01",
              },
              {
                filterType: "LOT_SIZE",
                minQty: "0.00001",
                maxQty: "9000",
                stepSize: "0.00001",
              },
              {
                filterType: "NOTIONAL",
                minNotional: "5",
                maxNotional: "9000000",
              },
            ],
          })),
        });
      case "/api/v3/depth":
        return Response.json({
          lastUpdateId: 1,
          bids: [["59999.00", "1"]],
          asks: [["60000.00", "1"]],
        });
      case "/api/v3/order/test":
        return Response.json({});
      case "/api/v3/orderList/opoco":
        placed = true;
        return Response.json({ ...list, orderReports: [] });
      case "/api/v3/orderList":
        return Response.json(list);
      case "/api/v3/order":
        return Response.json({
          symbol: "BTCUSDT",
          orderId: 20,
          orderListId: 7,
          clientOrderId: "ct_http_001_en",
          price: "59000",
          origQty: "0.001",
          executedQty: "0",
          cummulativeQuoteQty: "0",
          status: "NEW",
          type: "LIMIT",
          side: "BUY",
        });
      case "/api/v3/openOrders":
        return Response.json([]);
      case "/api/v3/openOrderList":
      case "/api/v3/myTrades":
        return Response.json([]);
    }
    throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
  });
  const { call, json } = await serve(t, {
    exchange: fake.exchange,
    routes: createRoutes({
      ...memory(),
      env: {
        TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT",
        TESTNET_MANUAL_ALLOCATION_USDT: "300",
      },
    }),
  });
  const ticket = await json("/orders/ticket");
  assert.equal(ticket.ticket.policy.customerId, owner.customerId);
  assert.equal(ticket.ticket.policy.exchangeAccountId, owner.exchangeAccountId);
  assert.equal(ticket.ticket.policy.tradingMode, "simulation");
  assert.equal(ticket.ticket.policy.liveTradingEnabled, false);
  assert.equal(ticket.ticket.markets[0].bestAsk, "60000.00");
  await json("/snapshot");
  const snapshots = fake.count("/api/v3/account");

  // Over the cap: the worker refuses whatever the browser previewed.
  const refused = await call(
    "/orders",
    post("/orders", { ...order, quantity: "0.002" }),
  );
  const refusal = (await refused.json()).outcome;
  assert.equal(refusal.status, "rejected");
  assert.ok(
    refusal.checks.some(
      (check: { name: string; passed: boolean }) =>
        check.name === "cap" && !check.passed,
    ),
  );
  assert.equal(placed, false);

  const response = await call("/orders", post("/orders", order));
  assert.equal((await response.json()).outcome.status, "working");
  assert.equal(fake.count("/api/v3/orderList/opoco"), 1);
  const accountReads = fake.count("/api/v3/account");
  await json("/snapshot");
  assert.equal(
    fake.count("/api/v3/account"),
    accountReads + 1,
    "the snapshot is read afresh after an order",
  );
  assert.ok(accountReads > snapshots);

  const repeat = await call("/orders", post("/orders", order));
  assert.equal((await repeat.json()).outcome.status, "duplicate");
  assert.equal(fake.count("/api/v3/orderList/opoco"), 1);
  const status = await json("/orders/status?listClientOrderId=ct_http_001");
  assert.equal(status.outcome.status, "working");
});

test("the execution route reports the loop's view for the requesting customer only", async (t) => {
  const fake = binance();
  const seen: string[] = [];
  const state = {
    checkedAt: "2027-01-15T08:00:00.000Z",
    alerts: [],
    triggers: [],
    notifications: [],
  };
  const { call, json } = await serve(t, {
    exchange: fake.exchange,
    routes: createRoutes({
      intents: new MemoryOrderIntents(),
      risk: new MemoryRiskLimits({ limits: TEST_RISK_LIMITS }),
      reader: {
        state: async (scope) => {
          seen.push(scope.customerId);
          return state;
        },
      },
    }),
  });
  assert.deepEqual(await json("/execution"), {
    status: "connected",
    execution: state,
  });
  assert.deepEqual(seen, [owner.customerId]);
  const stranger = await call("/execution", {
    headers: { "X-Customer-Id": "5a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c99" },
  });
  assert.equal((await stranger.json()).reason, "exchange_account");
  assert.deepEqual(seen, [owner.customerId]);
  assert.equal(fake.calls.length, 0);
});

test("a held stop-limit entry is cancelled through its own route", async (t) => {
  const fake = binance();
  const intents = new MemoryOrderIntents();
  const { call } = await serve(t, {
    exchange: fake.exchange,
    routes: createRoutes({
      intents,
      risk: new MemoryRiskLimits({ limits: TEST_RISK_LIMITS }),
      env: {
        TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT",
        TESTNET_MANUAL_ALLOCATION_USDT: "300",
      },
    }),
  });
  await intents.hold(
    owner,
    {
      kind: "protected_entry",
      entry: {
        instrument: "BTC-USDT",
        quantity: "0.001",
        price: "61100",
        timeInForce: "GTC",
        takeProfitPrice: "64000",
        stopLossPrice: "59000",
        listClientOrderId: "ct_http_stop",
      },
      trigger: { stopPrice: "61000" },
    },
    "dashboard",
  );
  const path = "/orders/triggers/cancel";
  assert.equal(
    (await call(path, post(path, { listClientOrderId: "../x" }))).status,
    400,
  );
  assert.equal((await call(path)).status, 405);
  const cancel = async () =>
    (
      await (
        await call(path, post(path, { listClientOrderId: "ct_http_stop" }))
      ).json()
    ).outcome.status;
  assert.equal(await cancel(), "cancelled");
  assert.equal(await cancel(), "not_open");
  assert.equal(intents.intents.get("ct_http_stop")?.status, "cancelled");
  assert.equal(fake.calls.length, 0);
});

const asAssistant = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${assistantToken}`,
};
const decision = (overrides: Record<string, unknown> = {}) => ({
  kind: "trade_proposal",
  proposal: {
    instrument: "BTC-USDT",
    marketKind: "spot",
    direction: "long",
    quantity: "0.001",
    entryPrice: "59000",
    stopLossPrice: "57000",
    takeProfitPrice: "62000",
    leverage: 1,
    entryExpiresAt: new Date(1_800_000_000_000 + 3_600_000).toISOString(),
    ...overrides,
  },
  model: "openai/gpt-6-luna",
  promptVersion: "assistant-2026-10-08",
  sourceSnapshotId: "5a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c09",
  rationale: "Support held.",
  idempotencyKey: "session-1:call-1",
});

test("the assistant's token records decisions and reaches nothing else", async (t) => {
  const fake = binance();
  const { call } = await serve(t, { exchange: fake.exchange });
  const recorded = await call("/decisions", {
    ...post("/decisions", decision()),
    headers: asAssistant,
  });
  assert.equal(recorded.status, 200);
  const body = await recorded.json();
  assert.equal(body.decision.proposal.status, "draft");
  for (const [path, init] of [
    ["/snapshot", {}],
    ["/decisions", {}],
    ["/orders/ticket", {}],
    ["/market/tickers", {}],
    ["/orders", post("/orders", order)],
    [
      "/proposals/approve",
      post("/proposals/approve", { proposalId: body.decision.proposal.id }),
    ],
  ] as const) {
    const response = await call(path, {
      ...init,
      headers: { ...("headers" in init ? init.headers : {}), ...asAssistant },
    });
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { status: "forbidden" });
  }
  // The web server cannot record AI decisions.
  const forged = await call("/decisions", post("/decisions", decision()));
  assert.equal(forged.status, 403);
  assert.equal(fake.calls.length, 0);
});

test("the assistant learns why a decision was not recorded", async (t) => {
  const { call } = await serve(t, { exchange: binance().exchange });
  const record = (body: unknown, customerId = owner.customerId) =>
    call("/decisions", {
      ...post("/decisions", body),
      headers: { ...asAssistant, "X-Customer-Id": customerId },
    });
  const backwards = await record(
    decision({ stopLossPrice: "60000", takeProfitPrice: "58000" }),
  );
  assert.equal(backwards.status, 400);
  assert.match((await backwards.json()).message, /long only/);
  const stale = await record(
    decision({ entryExpiresAt: new Date(1_799_999_999_000).toISOString() }),
  );
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).message, /in the future/);
  const short = await record(decision({ direction: "short" }));
  assert.equal(short.status, 400);
  const stranger = await record(
    decision(),
    "5a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c03",
  );
  assert.equal((await stranger.json()).reason, "exchange_account");
});

test("the web lists decisions, and a rejected proposal keeps its reason and cannot be approved", async (t) => {
  const fake = binance();
  const { call, json } = await serve(t, {
    exchange: fake.exchange,
    routes: createRoutes({
      ...memory(),
      now: () => 1_800_000_000_000,
      env: {
        TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT",
        TESTNET_MANUAL_ALLOCATION_USDT: "300",
        TESTNET_MAX_ORDER_NOTIONAL_USDT: "100",
      },
    }),
  });
  const { decision: recorded } = await (
    await call("/decisions", {
      ...post("/decisions", decision()),
      headers: asAssistant,
    })
  ).json();
  const id = recorded.proposal.id;
  const { decisions } = await json("/decisions");
  assert.deepEqual(
    decisions.map((entry: { id: string }) => entry.id),
    [recorded.id],
  );
  assert.equal(
    (await json(`/proposals?proposalId=${id}`)).proposal.status,
    "draft",
  );
  assert.equal(
    (
      await call(
        "/proposals/reject",
        post("/proposals/reject", {
          proposalId: id,
          reason: "x".repeat(501),
        }),
      )
    ).status,
    400,
  );
  const rejected = await (
    await call(
      "/proposals/reject",
      post("/proposals/reject", {
        proposalId: id,
        reason: "Too close to resistance.",
      }),
    )
  ).json();
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.proposal.status, "rejected");
  assert.equal(rejected.proposal.decisionReason, "Too close to resistance.");
  const again = await (
    await call(
      "/proposals/reject",
      post("/proposals/reject", { proposalId: id }),
    )
  ).json();
  assert.equal(again.rejected, false);
  const approval = await (
    await call(
      "/proposals/approve",
      post("/proposals/approve", { proposalId: id }),
    )
  ).json();
  assert.equal(approval.outcome.status, "rejected");
  assert.match(approval.outcome.message, /was rejected/);
  assert.equal(approval.proposal.status, "rejected");
  assert.equal(fake.count("/api/v3/orderList/opoco"), 0);
});
