import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BinanceHistoryError,
  BinanceSpotHistory,
} from "./binance-spot-history.js";

const HOUR = 60 * 60 * 1000;

/** A Binance kline array opening at `openTime`. */
function kline(openTime: number) {
  return [
    openTime,
    "100.00000000",
    "101.00000000",
    "99.00000000",
    "100.50000000",
    "12.5",
    openTime + HOUR - 1,
    "1256.25",
    42,
    "6",
    "600",
    "0",
  ];
}

function setup(
  handler: (url: URL) => Response | Promise<Response>,
  now = () => 1_800_000_000_000,
) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const history = new BinanceSpotHistory({
    now,
    fetch: (async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      return handler(url);
    }) as typeof fetch,
  });
  return { history, requests };
}

test("reads public market data only, without credentials", async () => {
  const { history, requests } = setup(() => Response.json([kline(0)]));
  await history.getKlines("BTC-USDT", "1h", 0, HOUR);
  const [{ url, init }] = requests;
  assert.equal(url.origin, "https://data-api.binance.vision");
  assert.equal(url.pathname, "/api/v3/klines");
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers, undefined);
  assert.equal(init.body, undefined);
  assert.equal(url.searchParams.has("signature"), false);
  assert.equal(url.searchParams.has("timestamp"), false);
});

test("follows Binance's pages of 1,000 candles across the range", async () => {
  const start = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
  const end = start + 2_500 * HOUR;
  const { history, requests } = setup((url) => {
    const from = Number(url.searchParams.get("startTime"));
    const until = Number(url.searchParams.get("endTime"));
    const limit = Number(url.searchParams.get("limit"));
    const page = [];
    // Candles that open at or after startTime, as Binance returns them.
    const first = Math.ceil(from / HOUR) * HOUR;
    for (let time = first; time <= until && page.length < limit; time += HOUR)
      page.push(kline(time));
    return Response.json(page);
  });
  const klines = await history.getKlines("ETH-USDT", "1h", start, end);
  assert.equal(klines.length, 2_500);
  assert.equal(klines[0].openTime, start);
  assert.equal(klines.at(-1)!.openTime, end - HOUR);
  assert.deepEqual(
    requests.map(({ url }) => [
      url.searchParams.get("symbol"),
      url.searchParams.get("interval"),
      Number(url.searchParams.get("startTime")),
      Number(url.searchParams.get("endTime")),
      url.searchParams.get("limit"),
    ]),
    [
      ["ETHUSDT", "1h", start, end - 1, "1000"],
      ["ETHUSDT", "1h", start + 999 * HOUR + 1, end - 1, "1000"],
      ["ETHUSDT", "1h", start + 1_999 * HOUR + 1, end - 1, "1000"],
    ],
  );
  // Decimal strings pass through unchanged.
  assert.equal(klines[0].close, "100.50000000");
});

test("stops at a page that brings nothing new", async () => {
  const { history, requests } = setup(() =>
    Response.json(Array.from({ length: 1_000 }, () => kline(0))),
  );
  const klines = await history.getKlines("BTC-USDT", "1h", HOUR, 5_000 * HOUR);
  assert.equal(klines.length, 0);
  assert.equal(requests.length, 1);
});

test("backs off when Binance rate limits, and reports other failures as unavailable", async () => {
  let now = 1_800_000_000_000;
  let status = 429;
  const { history, requests } = setup(
    () => new Response("{}", { status, headers: { "Retry-After": "30" } }),
    () => now,
  );
  await assert.rejects(history.getKlines("BTC-USDT", "1h", 0, HOUR), {
    kind: "rate_limited",
    retryAfterSeconds: 30,
  });
  await assert.rejects(history.getKlines("BTC-USDT", "1h", 0, HOUR), {
    kind: "rate_limited",
  });
  assert.equal(requests.length, 1);
  now += 30_000;
  status = 502;
  await assert.rejects(
    history.getKlines("BTC-USDT", "1h", 0, HOUR),
    (error) =>
      error instanceof BinanceHistoryError && error.kind === "unavailable",
  );

  const malformed = setup(() => Response.json([["not a kline"]]));
  await assert.rejects(malformed.history.getKlines("BTC-USDT", "1h", 0, HOUR), {
    kind: "unavailable",
  });
});

const exchangeInfo = (filters: object[]) => ({
  symbols: [
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      orderTypes: ["LIMIT", "LIMIT_MAKER", "STOP_LOSS"],
      ocoAllowed: true,
      otoAllowed: true,
      opoAllowed: true,
      filters,
      baseAsset: "BTC",
      quoteAsset: "USDT",
    },
  ],
});
const filters = [
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
    maxNotional: "9000000.00000000",
  },
];

test("reads a market's filters and its stop-order limit", async () => {
  const { history, requests } = setup(() =>
    Response.json(
      exchangeInfo([
        ...filters,
        { filterType: "MAX_NUM_ALGO_ORDERS", maxNumAlgoOrders: 5 },
      ]),
    ),
  );
  const result = await history.getSymbolFilters("BTC-USDT");
  assert.equal(requests[0].url.pathname, "/api/v3/exchangeInfo");
  assert.equal(requests[0].url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(result.maxStopOrders, 5);
  assert.equal(result.rules.tickSize, "0.01000000");
  assert.equal(result.rules.stepSize, "0.00001000");
  assert.equal(result.rules.minNotional, "5.00000000");

  const unlimited = setup(() => Response.json(exchangeInfo(filters)));
  await assert.rejects(unlimited.history.getSymbolFilters("BTC-USDT"), {
    kind: "unavailable",
  });
});
