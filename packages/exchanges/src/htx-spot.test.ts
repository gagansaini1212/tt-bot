import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AccountReader, TradingAdapter } from "./contract.js";
import { FakeHtx } from "./fixtures/fake-htx.js";
import {
  htxCanonicalQuery,
  htxPreSignedText,
  htxSignatureV2,
  htxTimestamp,
} from "./htx-signature.js";
import { HtxError, HtxSpot, parseHtxJson } from "./htx-spot.js";
import { UnlistedMarketError } from "./market-catalogue.js";
import {
  canPlaceOrders,
  htxClientOrderIds,
  htxVenueSymbols,
  venueFor,
} from "./venues.js";

const NOW = Date.UTC(2026, 9, 9, 1, 0, 0);

/**
 * An adapter whose requests the fake HTX answers. HTX's clock runs
 * `clockSkew` milliseconds ahead of the adapter's.
 */
function setup({ clockSkew = 0 }: { clockSkew?: number } = {}) {
  let now = NOW;
  const htx = new FakeHtx({ now: () => now + clockSkew });
  const exchange = new HtxSpot({
    apiKey: htx.apiKey,
    apiSecret: htx.apiSecret,
    now: () => now,
    fetch: htx.fetch,
  });
  const requests = (path: string) =>
    htx.requests.filter((request) => request.path === path);
  return {
    htx,
    exchange,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const kinds = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HtxError, String(error));
    return error;
  }
  assert.fail("expected an HtxError");
};

test("signature v2 reproduces the official HTX SDKs' test vectors", () => {
  // huobi_Golang internal/requestbuilder/privateurlbuilder_test.go
  const golang = htxSignatureV2({ accessKey: "access", secretKey: "secret" });
  const time = Date.UTC(2019, 10, 21, 10, 0, 0);
  assert.equal(
    `https://api.huobi.pro/v1/account/accounts?${golang.sign({ host: "api.huobi.pro", path: "/v1/account/accounts", parameters: {}, time })}`,
    "https://api.huobi.pro/v1/account/accounts?AccessKeyId=access&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=2019-11-21T10%3A00%3A00&Signature=rWnLcMt3XBAsmXoNHtTQVpvMbH%2FcE1PXFwQAGeYwt3s%3D",
  );
  assert.equal(
    `https://api.huobi.pro/v1/account/history?${golang.sign({
      host: "api.huobi.pro",
      path: "/v1/account/history",
      parameters: { currency: "btc", "account-id": "123" },
      time,
    })}`,
    "https://api.huobi.pro/v1/account/history?AccessKeyId=access&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=2019-11-21T10%3A00%3A00&account-id=123&currency=btc&Signature=SGZYJ9Ub%2FhFerEBbSWsCxl8Djk%2BLRBgEZOB4fLc4T9Q%3D",
  );
  // huobi_CSharp Huobi.SDK.Core.Test/RequestBuilder/SignerTest.cs
  const csharp = htxSignatureV2({
    accessKey: "abcdefg-hijklmn-opqrst-uvwxyz",
    secretKey: "12345-67890-12345-67890",
  });
  const query = new URLSearchParams(
    csharp.sign({
      host: "api.huobi.pro",
      path: "/v1/account/accounts",
      parameters: {},
      time: Date.UTC(2020, 3, 1, 12, 34, 56),
    }),
  );
  assert.equal(
    query.get("Signature"),
    "3IUZcEak4IIRrh7/idFrP2Jj77MaWGXR/oQbe9gL4+I=",
  );
});

test("the canonical request matches HTX's documented signing example", () => {
  // From "Signature Method" in HTX's Spot API documentation. Its access key
  // is masked and its secret unpublished, so its signature cannot be
  // reproduced; the text it signs can.
  const query = htxCanonicalQuery({
    "order-id": "1234567890",
    AccessKeyId: "e2xxxxxx-99xxxxxx-84xxxxxx-7xxxx",
    SignatureMethod: "HmacSHA256",
    SignatureVersion: "2",
    Timestamp: htxTimestamp(Date.UTC(2017, 4, 11, 15, 19, 30, 999)),
  });
  assert.equal(
    htxPreSignedText("API.HUOBI.PRO", "/v1/order/orders", query),
    "GET\napi.huobi.pro\n/v1/order/orders\nAccessKeyId=e2xxxxxx-99xxxxxx-84xxxxxx-7xxxx&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=2017-05-11T15%3A19%3A30&order-id=1234567890",
  );
  // UTF-8, upper-case hex, and a space as %20.
  assert.equal(
    htxCanonicalQuery({ b: "a b:c*'é", a: "~-_." }),
    "a=~-_.&b=a%20b%3Ac%2A%27%C3%A9",
  );
  // The signature is the raw HmacSHA256 digest in base64, not its hex.
  const signed = new URLSearchParams(
    htxSignatureV2({ accessKey: "key", secretKey: "secret" }).sign({
      host: "api.huobi.pro",
      path: "/v1/order/openOrders",
      parameters: { symbol: "btcusdt" },
      time: 0,
    }),
  );
  const signature = signed.get("Signature");
  signed.delete("Signature");
  assert.equal(
    signature,
    createHmac("sha256", "secret")
      .update(
        `GET\napi.huobi.pro\n/v1/order/openOrders\n${signed.toString().replaceAll("+", "%20")}`,
      )
      .digest("base64"),
  );
  assert.throws(
    () => htxSignatureV2({ accessKey: " ", secretKey: "secret-value" }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("secret-value"),
  );
});

test("signed requests carry HTX's clock and pass the fake's independent signature check", async () => {
  // The adapter's clock runs three minutes behind HTX's.
  const { exchange, htx, requests } = setup({ clockSkew: 180_000 });
  await exchange.getAccount();
  const [accounts] = requests("/v1/account/accounts");
  assert.equal(accounts.signed, true);
  assert.equal(
    accounts.parameters.get("Timestamp"),
    htxTimestamp(NOW + 180_000),
  );
  assert.equal(requests("/v1/common/timestamp").length, 1);
  // A wrong secret fails HTX's check, and the error names no secret.
  const wrong = new HtxSpot({
    apiKey: htx.apiKey,
    apiSecret: "not-the-secret",
    now: htx.now,
    fetch: htx.fetch,
  });
  const error = await kinds(wrong.getAccount());
  assert.equal(error.kind, "rejected");
  assert.equal(error.code, "api-signature-not-valid");
  assert.doesNotMatch(error.message, /not-the-secret|e2xxxxxx|Signature=/);
});

test("balances add up exactly, leave out empty assets and say the account cannot trade", async () => {
  const { exchange, requests } = setup();
  const account = await exchange.getAccount();
  assert.equal(account.canTrade, false);
  assert.deepEqual(account.balances, [
    {
      asset: "USDT",
      free: "91.850043797676510303",
      locked: "5.160000000000000015",
    },
    { asset: "BTC", free: "0.00125", locked: "0.001" },
    { asset: "POLY", free: "147.928994082840236", locked: "0" },
  ]);
  await exchange.getAccount();
  // The spot account's ID is looked up once.
  assert.equal(requests("/v1/account/accounts").length, 1);
  assert.equal(requests("/v1/account/accounts/10000001/balance").length, 2);
});

test("open orders keep HTX's IDs as strings and translate states and types", async () => {
  const { exchange, requests } = setup();
  assert.deepEqual(await exchange.getOpenOrders("BTC-USDT"), [
    {
      instrument: "BTC-USDT",
      orderId: "357630527817871",
      clientOrderId: "ct_web_001",
      price: "60000.01",
      origQty: "0.002",
      executedQty: "0.001",
      cumulativeQuoteQty: "60.00001",
      status: "PARTIALLY_FILLED",
      type: "LIMIT",
      side: "BUY",
      orderListId: null,
    },
  ]);
  const [request] = requests("/v1/order/openOrders");
  assert.equal(request.parameters.get("account-id"), "10000001");
  assert.equal(request.parameters.get("symbol"), "btcusdt");
  // An ID a double would round to 9007199254740992 stays exact.
  const [eth] = await exchange.getOpenOrders("ETH-USDT");
  assert.equal(eth.orderId, "9007199254740993");
  assert.equal(eth.clientOrderId, "");
  assert.equal(eth.type, "LIMIT_MAKER");
  assert.equal(eth.side, "SELL");
  assert.equal(eth.status, "NEW");
});

test("fills keep IDs as strings, compute their value exactly, and read fees, deductions and rebates", async () => {
  const { exchange } = setup();
  const [points, fee] = await exchange.getFills("BTC-USDT");
  assert.deepEqual(fee, {
    instrument: "BTC-USDT",
    id: "313288753120940",
    orderId: "357630527817871",
    price: "60000.01",
    qty: "0.001",
    quoteQty: "60.00001",
    commission: "0.000002",
    commissionAsset: "BTC",
    time: NOW - 25 * 60_000,
    isBuyer: true,
  });
  // HTX took the fee in points instead.
  assert.equal(points.commission, "0.1");
  assert.equal(points.commissionAsset, "HBPOINT");
  assert.equal(points.quoteQty, "30.5");
  assert.equal(points.isBuyer, false);
  // A maker rebate is income, not a commission.
  const [rebate] = await exchange.getFills("ETH-USDT");
  assert.equal(rebate.commission, "0");
  assert.equal(rebate.commissionAsset, "USDT");
  assert.equal(rebate.quoteQty, "300.05");
  const fills = await exchange.getOrderFills("BTC-USDT", "357630527817871");
  assert.deepEqual(
    fills.map((fill) => fill.id),
    ["313288753120940"],
  );
});

test("an order looked up by ID reads HTX's documented field names and refuses other markets", async () => {
  const { exchange, htx } = setup();
  const order = await exchange.getOrderById("BTC-USDT", "357632718898331");
  assert.equal(order.orderId, "357632718898331");
  assert.equal(order.executedQty, "0");
  assert.equal(order.origQty, "5");
  assert.equal(order.clientOrderId, "23456");
  const elsewhere = await kinds(
    exchange.getOrderById("ETH-USDT", "357632718898331"),
  );
  assert.equal(elsewhere.orderNotFound, true);
  const missing = await kinds(exchange.getOrderById("BTC-USDT", "1"));
  assert.equal(missing.kind, "rejected");
  assert.equal(missing.orderNotFound, true);
  const sent = htx.requests.length;
  await assert.rejects(exchange.getOrderById("BTC-USDT", "1/../../v2/user"));
  assert.equal(htx.requests.length, sent);
});

test("the snapshot covers listed instruments with one open-orders request, newest fills first", async () => {
  const { exchange, requests } = setup();
  const snapshot = await exchange.getSnapshot([
    "BTC-USDT",
    "ETH-USDT",
    "BTC-USDT",
    // HTX lists XRP-USDT, but the recorded catalogue does not.
    "XRP-USDT",
  ]);
  assert.equal(snapshot.venue, "htx");
  assert.equal(snapshot.canTrade, false);
  assert.equal(snapshot.capturedAt, new Date(NOW).toISOString());
  assert.deepEqual(
    snapshot.orders.map((order) => [order.instrument, order.orderId]),
    [
      ["BTC-USDT", "357630527817871"],
      ["ETH-USDT", "9007199254740993"],
    ],
  );
  assert.deepEqual(snapshot.orderLists, []);
  assert.deepEqual(snapshot.pendingOrders, []);
  assert.deepEqual(
    snapshot.fills.map((fill) => fill.id),
    ["313288753120941", "313288753120950", "313288753120940"],
  );
  const [openOrders] = requests("/v1/order/openOrders");
  assert.equal(requests("/v1/order/openOrders").length, 1);
  assert.equal(openOrders.parameters.has("symbol"), false);
  assert.deepEqual(
    requests("/v1/order/matchresults").map((request) =>
      request.parameters.get("symbol"),
    ),
    ["btcusdt", "ethusdt"],
  );
});

test("a key with trade or withdraw permission is refused; a read-only key is verified", async () => {
  const { exchange, htx, requests } = setup();
  assert.deepEqual(await exchange.getKeyPermissions(), {
    trade: false,
    withdraw: false,
  });
  assert.equal(await exchange.checkReadOnlyKey(), "verified");
  const [query] = requests("/v2/user/api-key");
  assert.equal(query.parameters.get("uid"), htx.uid);
  assert.equal(query.parameters.get("accessKey"), htx.apiKey);
  for (const [permission, expected] of [
    ["readOnly,trade", { trade: true, withdraw: false }],
    ["readOnly,withdraw", { trade: false, withdraw: true }],
    ["trade,readOnly,withdraw", { trade: true, withdraw: true }],
  ] as const) {
    htx.permission = permission;
    assert.deepEqual(await exchange.getKeyPermissions(), expected);
    const refused = await kinds(exchange.checkReadOnlyKey());
    assert.equal(refused.kind, "rejected");
    assert.match(refused.message, /can trade or withdraw/);
  }
  // A permission HTX has not documented could allow anything.
  htx.permission = "readOnly,transfer";
  assert.equal((await kinds(exchange.checkReadOnlyKey())).kind, "unavailable");
});

test("a sub-user's key, which HTX will not describe, is unverified rather than accepted or refused", async () => {
  const { exchange, htx } = setup();
  htx.subUser = true;
  assert.equal(await exchange.getKeyPermissions(), null);
  assert.equal(await exchange.checkReadOnlyKey(), "unverified");
  // HTX may also refuse with HTTP 403.
  htx.subUser = false;
  htx.failNext(
    "/v2/user/uid",
    () => new Response("Forbidden", { status: 403 }),
  );
  assert.equal(await exchange.checkReadOnlyKey(), "unverified");
  // Any other failure is an error, never a pass.
  htx.failNext("/v2/user/api-key", () => new Response("", { status: 502 }));
  assert.equal((await kinds(exchange.checkReadOnlyKey())).kind, "unavailable");
});

test("rate limits, outages and unreadable answers become venue-neutral errors that reveal nothing", async () => {
  const { exchange, htx, advance } = setup();
  htx.failNext(
    "/v1/account/accounts",
    () => new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
  );
  const limited = await kinds(exchange.getAccount());
  assert.equal(limited.kind, "rate_limited");
  assert.equal(limited.retryAfterSeconds, 3);
  // Nothing is sent until the wait is over, public data included.
  const sent = htx.requests.length;
  assert.equal(
    (await kinds(exchange.getLastPrice("BTC-USDT"))).kind,
    "rate_limited",
  );
  assert.equal(htx.requests.length, sent);
  advance(3_001);
  assert.equal(await exchange.getLastPrice("BTC-USDT"), "81834.51");

  // HTX's documented "Exceed rate limit" code, without a Retry-After.
  htx.failNext(
    "/market/trade",
    () => new Response(`{"code":1006,"message":"Exceed rate limit"}`),
  );
  const coded = await kinds(exchange.getLastPrice("BTC-USDT"));
  assert.equal(coded.kind, "rate_limited");
  assert.equal(coded.code, "1006");
  assert.equal(coded.retryAfterSeconds, 10);
  advance(10_001);

  htx.failNext("/market/trade", () => new Response("<html>", { status: 503 }));
  assert.equal(
    (await kinds(exchange.getLastPrice("BTC-USDT"))).kind,
    "unavailable",
  );
  htx.failNext(
    "/market/trade",
    () =>
      new Response(
        `{"status":"error","err-code":"base-system-error","err-msg":"system error"}`,
      ),
  );
  assert.equal(
    (await kinds(exchange.getLastPrice("BTC-USDT"))).kind,
    "unavailable",
  );
  htx.failNext("/market/trade", () => new Response(`{"status":"ok"}`));
  assert.equal(
    (await kinds(exchange.getLastPrice("BTC-USDT"))).kind,
    "unavailable",
  );
  // An echoed request is never repeated as an error code.
  htx.failNext(
    "/market/trade",
    () =>
      new Response(
        `{"status":"error","err-code":"https://api.huobi.pro/?Signature=abc","err-msg":"x"}`,
      ),
  );
  const echoed = await kinds(exchange.getLastPrice("BTC-USDT"));
  assert.equal(echoed.kind, "rejected");
  assert.equal(echoed.code, undefined);
  // HTX answers an unlisted symbol with HTTP 200 and status "error".
  const unlisted = await kinds(exchange.getLastPrice("XRP-USDT"));
  assert.equal(unlisted.kind, "rejected");
  assert.equal(unlisted.code, "invalid-parameter");

  const offline = new HtxSpot({
    apiKey: htx.apiKey,
    apiSecret: htx.apiSecret,
    fetch: async () => {
      throw new Error(`connect ECONNREFUSED ${htx.apiSecret}`);
    },
  });
  const unreachable = await kinds(offline.getAccount());
  assert.equal(unreachable.kind, "unavailable");
  assert.doesNotMatch(unreachable.message, new RegExp(htx.apiSecret));
});

test("the market catalogue reads HTX's symbol settings and leaves out what it cannot trust", async () => {
  const { exchange } = setup();
  const markets = await exchange.loadMarkets();
  assert.deepEqual(
    markets.map((market) => [
      market.instrument,
      market.venueSymbol,
      market.status,
    ]),
    [
      ["BTC-USDT", "btcusdt", "trading"],
      ["ETH-USDT", "ethusdt", "trading"],
      ["SHIB-USDT", "shibusdt", "trading"],
      ["人生K线-USDT", "人生k线usdt", "trading"],
      // Suspended. The offline maticusdc, which trades POL, is left out.
      ["STG-USDT", "stgusdt", "halted"],
    ],
  );
  assert.deepEqual(await exchange.getMarketRules("BTC-USDT"), {
    instrument: "BTC-USDT",
    venueSymbol: "btcusdt",
    status: "trading",
    protectedEntryAllowed: false,
    minPrice: "0",
    maxPrice: "0",
    tickSize: "0.01",
    minQty: "0.00001",
    maxQty: "1000",
    stepSize: "0.000001",
    minNotional: "1",
    maxNotional: "0",
  });
  const shib = await exchange.getMarketRules("SHIB-USDT");
  assert.equal(shib.tickSize, "0.00000001");
  assert.equal(shib.stepSize, "0.01");
  assert.equal(shib.maxQty, "245098039215");
  assert.equal(
    await exchange.markets.instrumentForVenueSymbol("人生k线usdt"),
    "人生K线-USDT",
  );
  await assert.rejects(
    exchange.getMarketRules("POL-USDC"),
    UnlistedMarketError,
  );
});

test("tickers read HTX's exponent numbers exactly, with the price window HTX uses", async () => {
  const { exchange } = setup();
  const tickers = await exchange.getTickers();
  assert.equal(tickers.length, 5);
  const ts = 1791506994673;
  assert.deepEqual(tickers[0], {
    symbol: "btcusdt",
    lastPrice: "81834.51",
    openPrice: "81014.72",
    highPrice: "81897.18",
    lowPrice: "80419.16",
    priceChange: "819.79",
    priceChangePercent: "1.012",
    volume: "5027.6059290403455",
    quoteVolume: "413251618.10855335",
    // HTX's day starts at midnight Singapore time, 16:00 UTC.
    openTime: Date.UTC(2026, 9, 8, 16, 0, 0),
    closeTime: ts,
  });
  const shib = tickers.find((ticker) => ticker.symbol === "shibusdt")!;
  assert.equal(shib.lastPrice, "0.00000531");
  assert.equal(shib.priceChange, "0.00000015");
  assert.equal(shib.priceChangePercent, "2.907");
  assert.equal(shib.volume, "10534635772.881386");
  assert.deepEqual(
    (await exchange.getTickers(["ethusdt", "人生k线usdt"])).map(
      (ticker) => ticker.symbol,
    ),
    ["ethusdt", "人生k线usdt"],
  );
  // Venue symbols are HTX's own, in lowercase.
  await assert.rejects(exchange.getTickers(["BTCUSDT"]));
});

test("klines come oldest first, with close times on HTX's Singapore calendar", async () => {
  const { exchange, htx } = setup();
  const hourly = await exchange.getKlines("BTC-USDT", "1h", 3);
  const request = htx.requests.at(-1)!;
  assert.equal(request.parameters.get("period"), "60min");
  assert.equal(request.parameters.get("size"), "3");
  assert.deepEqual(
    hourly.map((kline) => kline.openTime),
    [1791496800000, 1791500400000, 1791504000000],
  );
  assert.deepEqual(hourly[2], {
    openTime: 1791504000000,
    open: "81704.4",
    high: "81855.6",
    low: "81679.81",
    close: "81834.51",
    volume: "141.83162753753894",
    closeTime: 1791507599999,
    quoteVolume: "11593275.33808104",
    trades: 59539,
  });
  const monthly = await exchange.getKlines("BTC-USDT", "1M", 2);
  // September and October 2026, from midnight on the 1st in Singapore.
  assert.deepEqual(
    monthly.map((kline) => [kline.openTime, kline.closeTime]),
    [
      [Date.UTC(2026, 7, 31, 16), Date.UTC(2026, 8, 30, 16) - 1],
      [Date.UTC(2026, 8, 30, 16), Date.UTC(2026, 9, 31, 16) - 1],
    ],
  );
  const daily = await exchange.getKlines("BTC-USDT", "1d", 2);
  assert.equal(daily[1].closeTime - daily[1].openTime, 86_400_000 - 1);
  const sent = htx.requests.length;
  const unsupported = await kinds(exchange.getKlines("BTC-USDT", "3m"));
  assert.equal(unsupported.kind, "rejected");
  assert.match(unsupported.message, /HTX has no 3m candles/);
  assert.equal(htx.requests.length, sent);
});

test("depth asks HTX for the fewest levels that cover the limit", async () => {
  const { exchange, htx } = setup();
  const five = await exchange.getDepth("BTC-USDT", 5);
  assert.equal(htx.requests.at(-1)!.parameters.get("depth"), "5");
  assert.equal(htx.requests.at(-1)!.parameters.get("type"), "step0");
  assert.equal(five.lastUpdateId, 194286763665);
  assert.equal(five.bids.length, 5);
  assert.deepEqual(five.bids[2], { price: "81831.2", quantity: "0.0005" });
  assert.ok(Number(five.bids[0].price) < Number(five.asks[0].price));
  const fifteen = await exchange.getDepth("BTC-USDT", 15);
  assert.equal(htx.requests.at(-1)!.parameters.get("depth"), "20");
  assert.equal(fifteen.asks.length, 15);
  await exchange.getDepth("BTC-USDT");
  assert.equal(htx.requests.at(-1)!.parameters.has("depth"), false);
});

test("JSON numbers are read as HTX wrote them", () => {
  assert.deepEqual(
    parseHtxJson(
      `{"id":1942865091321697327365228733,"vol":4.1325161810855335E8,"q":[5.0E-5],"s":"1.5"}`,
    ),
    {
      id: "1942865091321697327365228733",
      vol: "4.1325161810855335E8",
      q: ["5.0E-5"],
      s: "1.5",
    },
  );
});

test("a public market data client sends nothing signed", async () => {
  const htx = new FakeHtx();
  const exchange = new HtxSpot({ publicData: true, fetch: htx.fetch });
  assert.equal(await exchange.getLastPrice("ETH-USDT"), "81834.51");
  await assert.rejects(exchange.getAccount(), /public market data only/);
  await assert.rejects(exchange.getKeyPermissions(), /public market data only/);
  assert.ok(htx.requests.every((request) => !request.signed));
});

test("HTX is a read-only venue with real funds, lowercase symbols and the application's client IDs", () => {
  const htx = venueFor("htx");
  assert.equal(htx.name, "HTX");
  assert.deepEqual(htx.capabilities, {
    marketKinds: ["spot"],
    access: "read_only",
    funds: "real",
    orderTypes: [],
    timeInForce: [],
    orderLists: [],
    attachedExits: null,
    stopOrders: "none",
    testOrders: false,
    lookupByClientOrderId: false,
  });
  assert.equal(canPlaceOrders(htx), false);
  assert.equal(htxVenueSymbols.toVenueSymbol("BTC-USDT"), "btcusdt");
  assert.equal(htxVenueSymbols.toVenueSymbol("人生K线-USDT"), "人生k线usdt");
  assert.equal(htxVenueSymbols.assetCode("usdt"), "USDT");
  assert.equal(htxClientOrderIds.toVenue("ct_sgabc123_tp"), "ct_sgabc123_tp");
  assert.equal(htxClientOrderIds.fromVenue("ct_web_001"), "ct_web_001");
  for (const foreign of ["", "23456", "web_8f2c1d"])
    assert.equal(htxClientOrderIds.fromVenue(foreign), undefined);
  assert.throws(() => htxClientOrderIds.toVenue("web_8f2c1d"));
});

test("the HTX adapter exposes no trading methods and sends nothing but GETs", async () => {
  // Every method it has: AccountReader's and the key check, nothing else.
  const methods = Object.getOwnPropertyNames(HtxSpot.prototype).sort();
  assert.deepEqual(methods, [
    "checkReadOnlyKey",
    "constructor",
    "getAccount",
    "getDepth",
    "getFills",
    "getKeyPermissions",
    "getKlines",
    "getLastPrice",
    "getMarketRules",
    "getOpenOrders",
    "getOrderById",
    "getOrderFills",
    "getSnapshot",
    "getTickers",
    "loadMarkets",
  ]);
  const trading: (keyof TradingAdapter)[] = [
    "getOrder",
    "getOrderList",
    "getOpenOrderLists",
    "testLimitOrder",
    "placeLimitOrder",
    "cancelOrder",
    "cancelOrderById",
    "placeMarketSell",
    "testProtectedEntry",
    "placeProtectedEntry",
    "cancelOrderList",
  ];
  const { exchange, htx } = setup();
  for (const method of trading) assert.equal(method in exchange, false, method);
  const reader: AccountReader = exchange;
  // @ts-expect-error The HTX adapter is not a TradingAdapter.
  const trader: TradingAdapter = exchange;
  assert.equal(reader, trader);

  // No order, cancel or withdrawal endpoint and no other method appears in
  // its source.
  for (const file of ["htx-spot.ts", "htx-signature.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /"(POST|PUT|DELETE|PATCH)"|orders\/place|batch-orders|submitcancel|batchcancel|batchCancelOpenOrders|algo-orders|dead-man|\/dw\/|withdraw\/|transfer/i,
      file,
    );
  }

  // Exercise every method; the fake refuses anything but a GET.
  await exchange.getSnapshot(["BTC-USDT", "ETH-USDT"]);
  await exchange.getOrderById("BTC-USDT", "357632718898331");
  await exchange.getOrderFills("BTC-USDT", "357630527817871");
  await exchange.checkReadOnlyKey();
  await exchange.getTickers();
  await exchange.getKlines("BTC-USDT", "1h");
  await exchange.getDepth("BTC-USDT");
  await exchange.getLastPrice("BTC-USDT");
  assert.deepEqual(htx.refused, []);
  assert.ok(htx.requests.length > 10);
});
