import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import {
  BinanceSpotTestnet,
  BinanceTestnetError,
  type KlineInterval,
  type TestnetLimitOrder,
} from "./binance-spot-testnet.js";
import type { ProtectedEntry } from "./order-rules.js";

const order: TestnetLimitOrder = {
  instrument: "BTC-USDT",
  side: "BUY",
  quantity: "0.001",
  price: "60000.01",
  clientOrderId: "ct_test_001",
};
const orderResponse = {
  symbol: "BTCUSDT",
  orderId: 12,
  clientOrderId: order.clientOrderId,
  price: order.price,
  origQty: order.quantity,
  executedQty: "0.0005",
  cummulativeQuoteQty: "30.000005",
  status: "PARTIALLY_FILLED",
  type: "LIMIT",
  side: "BUY",
};
function setup(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const requests: { url: URL; init: RequestInit }[] = [];
  let now = 1_800_000_000_000;
  const exchange = new BinanceSpotTestnet({
    apiKey: "private-key",
    apiSecret: "private-secret",
    now: () => now,
    fetch: (async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://testnet.binance.vision");
      assert.equal(init.redirect, "error");
      requests.push({ url, init });
      if (url.pathname === "/api/v3/time")
        return Response.json({ serverTime: now + 2000 });
      return handler(url, init);
    }) as typeof fetch,
  });
  return {
    exchange,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("signs exact serialized parameters, corrects server clock, preserves decimal amounts", async () => {
  const { exchange, requests } = setup(() =>
    Response.json({
      canTrade: true,
      balances: [
        {
          asset: "USDT",
          free: "9007199254740993.12345678",
          locked: "0.00000001",
        },
      ],
    }),
  );
  const account = await exchange.getAccount();
  const { url, init } = requests[1];
  const query = new URLSearchParams(url.search);
  const signature = query.get("signature");
  query.delete("signature");
  assert.equal(
    signature,
    createHmac("sha256", "private-secret")
      .update(query.toString())
      .digest("hex"),
  );
  assert.equal(query.get("timestamp"), "1800000002000");
  assert.equal(query.get("recvWindow"), "5000");
  assert.equal(new Headers(init.headers).get("X-MBX-APIKEY"), "private-key");
  assert.equal(account.balances[0].free, "9007199254740993.12345678");
});

test("Ed25519 and RSA requests use percent-encoded base64 signatures verifiable by the registered public key", async () => {
  const pairs = [
    generateKeyPairSync("ed25519"),
    generateKeyPairSync("rsa", { modulusLength: 2048 }),
  ];
  for (const { privateKey, publicKey } of pairs) {
    const exchange = new BinanceSpotTestnet({
      apiKey: "asymmetric-test-key",
      privateKey: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      fetch: (async (input, init = {}) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://testnet.binance.vision");
        if (url.pathname === "/api/v3/time")
          return Response.json({ serverTime: Date.now() });
        const params = init.body
          ? new URLSearchParams(String(init.body))
          : url.searchParams;
        const signature = params.get("signature");
        assert.ok(signature);
        assert.match(signature, /^[A-Za-z0-9+/]+=*$/);
        params.delete("signature");
        assert.equal(
          verify(
            publicKey.asymmetricKeyType === "ed25519" ? null : "sha256",
            Buffer.from(params.toString()),
            publicKey,
            Buffer.from(signature, "base64"),
          ),
          true,
        );
        return url.pathname === "/api/v3/account"
          ? Response.json({ canTrade: true, balances: [] })
          : Response.json(orderResponse);
      }) as typeof fetch,
    });
    assert.equal((await exchange.getAccount()).canTrade, true);
    assert.equal((await exchange.placeLimitOrder(order)).orderId, 12);
  }
});

test("invalid or conflicting private-key configuration fails without exposing key contents", () => {
  assert.throws(
    () =>
      new BinanceSpotTestnet({
        apiKey: "test",
        privateKey: "private-invalid-content",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /private key must be/);
      assert.doesNotMatch(error.message, /private-invalid-content/);
      return true;
    },
  );
  assert.throws(
    () =>
      new BinanceSpotTestnet({
        apiKey: "test",
        apiSecret: "secret",
        privateKey: "pem",
      }),
    /not both/,
  );
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  assert.throws(
    () =>
      new BinanceSpotTestnet({
        apiKey: "test",
        privateKey: privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      }),
    /Ed25519 or RSA/,
  );
});

test("a public data client reads market data and refuses account requests unsent", async () => {
  const requested: string[] = [];
  const exchange = new BinanceSpotTestnet({
    publicData: true,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requested.push(url.pathname);
      assert.equal(new Headers(init?.headers).has("X-MBX-APIKEY"), false);
      return Response.json({ lastUpdateId: 1, bids: [], asks: [] });
    }) as typeof fetch,
  });
  assert.equal((await exchange.getDepth("BTC-USDT", 5)).lastUpdateId, 1);
  await assert.rejects(exchange.getAccount(), /public market data only/);
  assert.deepEqual(requested, ["/api/v3/depth"]);
});

test("limit order, lookup and cancellation map to Binance's contract", async () => {
  const { exchange, requests } = setup(() => Response.json(orderResponse));
  assert.equal((await exchange.placeLimitOrder(order)).executedQty, "0.0005");
  await exchange.getOrder("BTC-USDT", order.clientOrderId);
  await exchange.cancelOrder("BTC-USDT", order.clientOrderId);
  const submitted = requests[1];
  const params = new URLSearchParams(String(submitted.init.body));
  assert.equal(submitted.init.method, "POST");
  assert.equal(submitted.url.search, "");
  assert.equal(params.get("symbol"), "BTCUSDT");
  assert.equal(params.get("type"), "LIMIT");
  assert.equal(params.get("timeInForce"), "GTC");
  assert.equal(params.get("newClientOrderId"), order.clientOrderId);
  assert.equal(params.get("quantity"), order.quantity);
  assert.equal(params.get("price"), order.price);
  assert.equal(
    requests[2].url.searchParams.get("origClientOrderId"),
    order.clientOrderId,
  );
  assert.equal(requests[3].init.method, "DELETE");
  assert.equal(
    new URLSearchParams(String(requests[3].init.body)).get("origClientOrderId"),
    order.clientOrderId,
  );
});

test("validation uses the non-submitting endpoint and rejects invalid inputs before network access", async () => {
  const { exchange, requests } = setup(() => Response.json({}));
  await assert.rejects(exchange.testLimitOrder({ ...order, quantity: "0" }));
  assert.equal(requests.length, 0);
  await exchange.testLimitOrder(order);
  assert.equal(requests[1].url.pathname, "/api/v3/order/test");
  assert.equal(requests[1].init.method, "POST");
  assert.throws(() =>
    exchange.placeLimitOrder({
      ...order,
      instrument: "SOL-USDT" as TestnetLimitOrder["instrument"],
    }),
  );
});

test("transport failures and server errors leave mutation outcomes unknown without retries or secret leakage", async () => {
  for (const handler of [
    () => {
      throw new Error("URL includes private-secret and private-key");
    },
    () =>
      Response.json({ code: -1007, msg: "private-secret" }, { status: 504 }),
    () =>
      Response.json({ code: -1006, msg: "private-secret" }, { status: 400 }),
    () => Response.json({ malformed: true }),
  ]) {
    const { exchange, requests } = setup(handler);
    await assert.rejects(exchange.placeLimitOrder(order), (error: unknown) => {
      assert.ok(error instanceof BinanceTestnetError);
      assert.equal(error.kind, "unknown_outcome");
      assert.doesNotMatch(error.message, /private-secret|private-key/);
      return true;
    });
    assert.equal(
      requests.filter((request) => request.init.method === "POST").length,
      1,
    );
  }
});

test("rate limits block subsequent traffic until Retry-After expires", async () => {
  let calls = 0;
  const { exchange, requests, advance } = setup(() =>
    ++calls === 1
      ? Response.json(
          { code: -1003, msg: "Too many requests" },
          { status: 429, headers: { "Retry-After": "20" } },
        )
      : Response.json({ canTrade: false, balances: [] }),
  );
  await assert.rejects(
    exchange.getAccount(),
    (error: unknown) =>
      error instanceof BinanceTestnetError &&
      error.kind === "rate_limited" &&
      error.retryAfterSeconds === 20,
  );
  const count = requests.length;
  await assert.rejects(exchange.getAccount());
  assert.equal(requests.length, count);
  advance(20_001);
  assert.equal((await exchange.getAccount()).canTrade, false);
});

test("proxy rate limits with non-JSON bodies still stop subsequent requests", async () => {
  const { exchange, requests } = setup(
    () =>
      new Response("Rate limited", {
        status: 429,
        headers: { "Retry-After": "10" },
      }),
  );
  await assert.rejects(
    exchange.getAccount(),
    (error: unknown) =>
      error instanceof BinanceTestnetError && error.kind === "rate_limited",
  );
  const count = requests.length;
  await assert.rejects(exchange.getAccount());
  assert.equal(requests.length, count);
});

test("rejections and unsafe numeric IDs fail explicitly", async () => {
  const rejected = setup(() =>
    Response.json({ code: -2013, msg: "Unknown order" }, { status: 400 }),
  );
  await assert.rejects(
    rejected.exchange.getOrder("BTC-USDT", "ct_unknown"),
    (error: unknown) =>
      error instanceof BinanceTestnetError &&
      error.kind === "rejected" &&
      error.code === -2013,
  );
  const unsafe = setup(() =>
    Response.json({ ...orderResponse, orderId: Number.MAX_SAFE_INTEGER + 1 }),
  );
  await assert.rejects(
    unsafe.exchange.placeLimitOrder(order),
    (error: unknown) =>
      error instanceof BinanceTestnetError && error.kind === "unknown_outcome",
  );
});

test("snapshot combines both supported instruments, shares clock sync and retains fills and fees", async () => {
  const { exchange, requests } = setup((url) => {
    if (url.pathname === "/api/v3/account")
      return Response.json({ canTrade: true, balances: [] });
    if (
      url.pathname === "/api/v3/openOrders" ||
      url.pathname === "/api/v3/openOrderList"
    )
      return Response.json([]);
    return Response.json([
      {
        symbol: url.searchParams.get("symbol"),
        id: 1,
        orderId: 12,
        price: "60000.01",
        qty: "0.0005",
        quoteQty: "30.000005",
        commission: "0.0000005",
        commissionAsset: "BTC",
        time: url.searchParams.get("symbol") === "BTCUSDT" ? 2000 : 1000,
        isBuyer: true,
      },
    ]);
  });
  const snapshot = await exchange.getSnapshot();
  assert.equal(snapshot.provider, "binance-spot-testnet");
  assert.equal(snapshot.fills.length, 2);
  assert.equal(snapshot.fills[0].symbol, "BTCUSDT");
  assert.equal(snapshot.fills[0].commission, "0.0000005");
  assert.equal(
    requests.filter(({ url }) => url.pathname === "/api/v3/time").length,
    1,
  );
});

const ticker = {
  symbol: "BTCUSDT",
  priceChange: "-1250.50000000",
  priceChangePercent: "-1.996",
  weightedAvgPrice: "61500.00000000",
  prevClosePrice: "62650.51000000",
  lastPrice: "61400.01000000",
  lastQty: "0.00100000",
  bidPrice: "61400.00000000",
  bidQty: "1.00000000",
  askPrice: "61400.01000000",
  askQty: "2.00000000",
  openPrice: "62650.51000000",
  highPrice: "63000.00000000",
  lowPrice: "61000.00000000",
  volume: "9007199254740993.12345678",
  quoteVolume: "123456789.12345678",
  openTime: 1_799_913_600_000,
  closeTime: 1_800_000_000_000,
  firstId: -1,
  lastId: -1,
  count: 0,
};

test("market data is unsigned, keeps decimal strings and maps Binance's arrays", async () => {
  const { exchange, requests } = setup((url) => {
    if (url.pathname === "/api/v3/ticker/24hr") return Response.json([ticker]);
    if (url.pathname === "/api/v3/klines")
      return Response.json([
        [
          1_800_000_000_000,
          "61000.00000000",
          "61500.00000000",
          "60900.00000000",
          "61400.01000000",
          "12.34500000",
          1_800_003_599_999,
          "757000.12345678",
          308,
          "6.00000000",
          "368000.00000000",
          "0",
        ],
      ]);
    return Response.json({
      lastUpdateId: 1027024,
      bids: [["61400.00000000", "0.50000000"]],
      asks: [
        ["61400.01000000", "1.00000000"],
        ["61400.02000000", "2.00000000"],
      ],
    });
  });
  const [all] = await exchange.getTickers();
  assert.equal(all.priceChangePercent, "-1.996");
  assert.equal(all.volume, "9007199254740993.12345678");
  assert.equal("bidPrice" in all, false);
  await exchange.getTickers(["BTCUSDT", "ETHUSDT"]);
  const [kline] = await exchange.getKlines("BTC-USDT", "1h", 2);
  assert.deepEqual(kline, {
    openTime: 1_800_000_000_000,
    open: "61000.00000000",
    high: "61500.00000000",
    low: "60900.00000000",
    close: "61400.01000000",
    volume: "12.34500000",
    closeTime: 1_800_003_599_999,
    quoteVolume: "757000.12345678",
    trades: 308,
  });
  const depth = await exchange.getDepth("ETH-USDT", 5);
  assert.deepEqual(depth.bids, [
    { price: "61400.00000000", quantity: "0.50000000" },
  ]);
  assert.equal(depth.asks[1].price, "61400.02000000");

  assert.deepEqual(
    requests.map(({ url }) => `${url.pathname}${url.search}`),
    [
      "/api/v3/ticker/24hr",
      `/api/v3/ticker/24hr?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT"]')}`,
      "/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2",
      "/api/v3/depth?symbol=ETHUSDT&limit=5",
    ],
  );
  for (const { init } of requests) {
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("X-MBX-APIKEY"), null);
  }
});

test("market data rejects invalid inputs before network access", async () => {
  const { exchange, requests } = setup(() => Response.json([]));
  for (const symbols of [
    [],
    ["btcusdt"],
    ["BTCUSDT,ETHUSDT"],
    ["BTC-USDT"],
    Array.from({ length: 101 }, (_, index) => `T${index}USDT`),
  ])
    assert.throws(() => exchange.getTickers(symbols), String(symbols));
  for (const limit of [0, 1001, 1.5])
    assert.throws(() => exchange.getKlines("BTC-USDT", "1m", limit));
  assert.throws(() =>
    exchange.getKlines("BTC-USDT", "1s" as KlineInterval, 10),
  );
  assert.throws(() => exchange.getDepth("BTC-USDT", 101));
  assert.throws(() =>
    exchange.getDepth("SOL-USDT" as TestnetLimitOrder["instrument"]),
  );
  assert.equal(requests.length, 0);
  // Binance lists some symbols in other scripts.
  await exchange.getTickers(["币安人生USDT", "1000SATSUSDT"]);
  assert.equal(requests.length, 1);
});

test("malformed market data is reported as unavailable", async () => {
  for (const body of [
    [{ ...ticker, lastPrice: "6.1e4" }],
    [{ ...ticker, priceChangePercent: undefined }],
    [[1_800_000_000_000, "1", "1", "1", "1"]],
    { lastUpdateId: 1, bids: [[61400, "1"]], asks: [] },
  ]) {
    const { exchange } = setup(() => Response.json(body));
    const request = Array.isArray(body)
      ? Array.isArray(body[0])
        ? exchange.getKlines("BTC-USDT", "1m")
        : exchange.getTickers()
      : exchange.getDepth("BTC-USDT");
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof BinanceTestnetError && error.kind === "unavailable",
    );
  }
});

const entry: ProtectedEntry = {
  instrument: "BTC-USDT",
  quantity: "0.001",
  price: "60000",
  timeInForce: "GTC",
  takeProfitPrice: "63000",
  stopLossPrice: "58000",
  listClientOrderId: "ct_list_001",
};
const listResponse = {
  orderListId: 7,
  contingencyType: "OTO",
  listStatusType: "EXEC_STARTED",
  listOrderStatus: "EXECUTING",
  listClientOrderId: entry.listClientOrderId,
  transactionTime: 1_800_000_000_000,
  symbol: "BTCUSDT",
  orders: [
    { symbol: "BTCUSDT", orderId: 21, clientOrderId: "ct_list_001_en" },
    { symbol: "BTCUSDT", orderId: 22, clientOrderId: "ct_list_001_sl" },
    { symbol: "BTCUSDT", orderId: 23, clientOrderId: "ct_list_001_tp" },
  ],
};
const leg = (
  orderId: number,
  clientOrderId: string,
  fields: Record<string, string>,
) => ({
  symbol: "BTCUSDT",
  orderId,
  orderListId: 7,
  clientOrderId,
  origQty: "0.001",
  executedQty: "0",
  cummulativeQuoteQty: "0",
  status: "PENDING_NEW",
  side: "SELL",
  ...fields,
});
function withoutQuantity(report: Record<string, unknown>) {
  const { origQty: _, ...rest } = report;
  return rest;
}
const listReports = [
  leg(21, "ct_list_001_en", {
    type: "LIMIT",
    side: "BUY",
    price: "60000",
    status: "NEW",
  }),
  // As documented, OPO exits have no origQty until their entry fills.
  withoutQuantity(
    leg(22, "ct_list_001_sl", {
      type: "STOP_LOSS",
      price: "0",
      stopPrice: "58000",
    }),
  ),
  withoutQuantity(
    leg(23, "ct_list_001_tp", { type: "LIMIT_MAKER", price: "63000" }),
  ),
];

test("a protected entry is one OPOCO list whose exits Binance sizes after the fill", async () => {
  const { exchange, requests } = setup(() =>
    Response.json({ ...listResponse, orderReports: listReports }),
  );
  await assert.rejects(
    exchange.placeProtectedEntry({ ...entry, stopLossPrice: "60000" }),
  );
  await assert.rejects(
    exchange.placeProtectedEntry({ ...entry, takeProfitPrice: "59000" }),
  );
  assert.equal(requests.length, 0);
  const placed = await exchange.placeProtectedEntry(entry);
  assert.equal(placed.orderReports[1].stopPrice, "58000");
  assert.equal(placed.orderReports[1].origQty, "0");
  const { url, init } = requests[1];
  assert.equal(url.pathname, "/api/v3/orderList/opoco");
  assert.equal(init.method, "POST");
  const params = new URLSearchParams(String(init.body));
  assert.deepEqual(
    Object.fromEntries(
      [...params].filter(
        ([key]) => !["timestamp", "recvWindow", "signature"].includes(key),
      ),
    ),
    {
      symbol: "BTCUSDT",
      listClientOrderId: "ct_list_001",
      newOrderRespType: "RESULT",
      workingType: "LIMIT",
      workingSide: "BUY",
      workingClientOrderId: "ct_list_001_en",
      workingPrice: "60000",
      workingQuantity: "0.001",
      workingTimeInForce: "GTC",
      pendingSide: "SELL",
      pendingAboveType: "LIMIT_MAKER",
      pendingAboveClientOrderId: "ct_list_001_tp",
      pendingAbovePrice: "63000",
      pendingBelowType: "STOP_LOSS",
      pendingBelowClientOrderId: "ct_list_001_sl",
      pendingBelowStopPrice: "58000",
    },
  );
});

test("the entry leg is validated by Binance without being placed", async () => {
  const { exchange, requests } = setup(() => Response.json({}));
  await exchange.testProtectedEntry({ ...entry, timeInForce: "FOK" });
  const params = new URLSearchParams(String(requests[1].init.body));
  assert.equal(requests[1].url.pathname, "/api/v3/order/test");
  assert.equal(params.get("type"), "LIMIT");
  assert.equal(params.get("side"), "BUY");
  assert.equal(params.get("timeInForce"), "FOK");
  assert.equal(params.get("newClientOrderId"), "ct_list_001_en");
});

test("order lists are looked up by client ID and cancelled by list ID", async () => {
  const { exchange, requests } = setup((url, init) =>
    url.pathname === "/api/v3/orderList" && init.method === "DELETE"
      ? Response.json({
          ...listResponse,
          listOrderStatus: "ALL_DONE",
          orderReports: listReports.map((report) => ({
            ...report,
            status: "CANCELED",
          })),
        })
      : url.pathname === "/api/v3/order"
        ? Response.json({ ...orderResponse, status: "CANCELED" })
        : Response.json(listResponse),
  );
  assert.equal(
    (await exchange.getOrderList("ct_list_001")).orders[0].clientOrderId,
    "ct_list_001_en",
  );
  assert.equal(
    requests[1].url.searchParams.get("origClientOrderId"),
    "ct_list_001",
  );
  const cancelled = await exchange.cancelOrderList("BTC-USDT", 7);
  assert.ok(
    cancelled.orderReports.every((report) => report.status === "CANCELED"),
  );
  const listCancel = new URLSearchParams(String(requests[2].init.body));
  assert.equal(requests[2].init.method, "DELETE");
  assert.equal(listCancel.get("orderListId"), "7");
  assert.equal(listCancel.get("symbol"), "BTCUSDT");
  await exchange.cancelOrderById("ETH-USDT", 12);
  const orderCancel = new URLSearchParams(String(requests[3].init.body));
  assert.equal(requests[3].url.pathname, "/api/v3/order");
  assert.equal(orderCancel.get("orderId"), "12");
  assert.equal(orderCancel.get("symbol"), "ETHUSDT");
  await assert.rejects(exchange.getOrderList("not-ours"));
  await assert.rejects(exchange.cancelOrderList("BTC-USDT", -1));
});

test("snapshot groups order lists and looks up legs Binance holds back", async () => {
  const { exchange, requests } = setup((url) => {
    if (url.pathname === "/api/v3/account")
      return Response.json({ canTrade: true, balances: [] });
    if (url.pathname === "/api/v3/openOrders")
      return Response.json(
        url.searchParams.get("symbol") === "BTCUSDT" ? [listReports[0]] : [],
      );
    if (url.pathname === "/api/v3/openOrderList")
      return Response.json([
        listResponse,
        { ...listResponse, orderListId: 9, symbol: "BNBUSDT" },
      ]);
    if (url.pathname === "/api/v3/order")
      return Response.json(
        listReports.find(
          (report) =>
            String(report.orderId) === url.searchParams.get("orderId"),
        ),
      );
    return Response.json([]);
  });
  const snapshot = await exchange.getSnapshot();
  assert.equal(snapshot.orders[0].orderListId, 7);
  assert.deepEqual(
    snapshot.orderLists.map((list) => list.orderListId),
    [7],
  );
  assert.deepEqual(
    snapshot.pendingOrders.map((order) => order.clientOrderId),
    ["ct_list_001_sl", "ct_list_001_tp"],
  );
  assert.deepEqual(
    requests
      .filter(({ url }) => url.pathname === "/api/v3/order")
      .map(({ url }) => url.searchParams.get("orderId")),
    ["22", "23"],
  );
});

const exchangeInfo = (overrides: Record<string, unknown> = {}) => ({
  symbols: ["BTCUSDT", "ETHUSDT"].map((symbol) => ({
    symbol,
    status: "TRADING",
    orderTypes: [
      "LIMIT",
      "LIMIT_MAKER",
      "MARKET",
      "STOP_LOSS",
      "STOP_LOSS_LIMIT",
    ],
    ocoAllowed: true,
    otoAllowed: true,
    opoAllowed: true,
    filters: [
      {
        filterType: "PRICE_FILTER",
        minPrice: "0.01000000",
        maxPrice: "1000000.00000000",
        tickSize: "0.01000000",
      },
      {
        filterType: "LOT_SIZE",
        minQty: "0.00001000",
        maxQty: "9000.00000000",
        stepSize: "0.00001000",
      },
      {
        filterType: "NOTIONAL",
        minNotional: "5.00000000",
        applyMinToMarket: true,
        maxNotional: "9000000.00000000",
        applyMaxToMarket: false,
        avgPriceMins: 5,
      },
    ],
    ...overrides,
  })),
});

test("symbol rules come from exchangeInfo without signing", async () => {
  const { exchange, requests } = setup(() => Response.json(exchangeInfo()));
  const [btc, eth] = await exchange.getSymbolRules();
  assert.equal(btc.instrument, "BTC-USDT");
  assert.equal(eth.instrument, "ETH-USDT");
  assert.equal(btc.protectedEntryAllowed, true);
  assert.equal(btc.tickSize, "0.01000000");
  assert.equal(btc.minNotional, "5.00000000");
  const { url, init } = requests[0];
  assert.equal(url.pathname, "/api/v3/exchangeInfo");
  assert.equal(url.searchParams.get("symbols"), '["BTCUSDT","ETHUSDT"]');
  assert.equal(url.searchParams.get("signature"), null);
  assert.deepEqual(init.headers, {});
  const withoutOpo = setup(() =>
    Response.json(exchangeInfo({ opoAllowed: false })),
  );
  const [restricted] = await withoutOpo.exchange.getSymbolRules();
  assert.equal(restricted.protectedEntryAllowed, false);
  // Without MAX_NUM_ALGO_ORDERS, the stop-order limit is unknown.
  assert.equal(btc.maxStopOrders, undefined);
  const withAlgo = setup(() =>
    Response.json(
      exchangeInfo({
        filters: [
          ...exchangeInfo().symbols[0].filters,
          { filterType: "MAX_NUM_ALGO_ORDERS", maxNumAlgoOrders: 5 },
        ],
      }),
    ),
  );
  const [limited] = await withAlgo.exchange.getSymbolRules();
  assert.equal(limited.maxStopOrders, 5);
});

test("rejections carry Binance's reason only when it is a documented message", async () => {
  for (const [msg, reason] of [
    ["Filter failure: NOTIONAL", "Filter failure: NOTIONAL"],
    [
      "Account has insufficient balance for requested action.",
      "Account has insufficient balance for requested action.",
    ],
    ["private-secret in signature", undefined],
  ] as const) {
    const { exchange } = setup(() =>
      Response.json({ code: -2010, msg }, { status: 400 }),
    );
    await assert.rejects(
      exchange.placeProtectedEntry(entry),
      (error: unknown) => {
        assert.ok(error instanceof BinanceTestnetError);
        assert.equal(error.kind, "rejected");
        assert.equal(error.reason, reason);
        assert.doesNotMatch(error.message, /private-secret/);
        return true;
      },
    );
  }
});

test("the loop's price, fills and market sell map to Binance's contract", async () => {
  const { exchange, requests } = setup((url) =>
    url.pathname === "/api/v3/ticker/price"
      ? Response.json({ symbol: "BTCUSDT", price: "60123.45000000" })
      : url.pathname === "/api/v3/myTrades"
        ? Response.json([
            {
              symbol: "BTCUSDT",
              id: 5,
              orderId: 12,
              price: "60000.00000000",
              qty: "0.00100000",
              quoteQty: "60.00000000",
              commission: "0.00000100",
              commissionAsset: "BTC",
              time: 1_800_000_000_000,
              isBuyer: true,
            },
          ])
        : Response.json({
            ...orderResponse,
            clientOrderId: "ct_list_001_c1",
            type: "MARKET",
            side: "SELL",
            status: "FILLED",
            executedQty: "0.00099",
          }),
  );
  assert.equal(await exchange.getLastPrice("BTC-USDT"), "60123.45000000");
  assert.equal(requests[0].url.searchParams.get("symbol"), "BTCUSDT");
  // Public: neither signed nor sent with the API key.
  assert.equal(requests[0].url.searchParams.get("signature"), null);

  const [fill] = await exchange.getOrderFills("BTC-USDT", 12);
  assert.equal(fill.commission, "0.00000100");
  const trades = requests.find(
    (request) => request.url.pathname === "/api/v3/myTrades",
  )!;
  assert.equal(trades.url.searchParams.get("orderId"), "12");
  assert.ok(trades.url.searchParams.get("signature"));

  const sold = await exchange.placeMarketSell({
    instrument: "BTC-USDT",
    quantity: "0.00099",
    clientOrderId: "ct_list_001_c1",
  });
  assert.equal(sold.status, "FILLED");
  const sale = requests.at(-1)!;
  const params = new URLSearchParams(String(sale.init.body));
  assert.equal(sale.init.method, "POST");
  assert.equal(sale.url.pathname, "/api/v3/order");
  assert.equal(params.get("side"), "SELL");
  assert.equal(params.get("type"), "MARKET");
  assert.equal(params.get("quantity"), "0.00099");
  assert.equal(params.get("newClientOrderId"), "ct_list_001_c1");
  assert.equal(params.get("price"), null);
  await assert.rejects(
    exchange.placeMarketSell({
      instrument: "BTC-USDT",
      quantity: "-1",
      clientOrderId: "ct_list_001_c2",
    }),
  );
});
