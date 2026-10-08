import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  getMarketDepth,
  getMarketKlines,
  getMarketTickers,
} from "./market-data";

const ticker = {
  symbol: "BTCUSDT",
  lastPrice: "60000.01",
  openPrice: "61000.00",
  highPrice: "61500.00",
  lowPrice: "59000.00",
  priceChange: "-999.99",
  priceChangePercent: "-1.639",
  volume: "12.5",
  quoteVolume: "750000.12",
  openTime: 1_799_913_600_000,
  closeTime: 1_800_000_000_000,
};
const kline = {
  openTime: 1_800_000_000_000,
  open: "60000.00",
  high: "60100.00",
  low: "59900.00",
  close: "60050.00",
  volume: "1.5",
  closeTime: 1_800_000_059_999,
  quoteVolume: "90000.00",
  trades: 12,
};
const depth = {
  lastUpdateId: 7,
  bids: [{ price: "60000.00", quantity: "1.0" }],
  asks: [{ price: "60001.00", quantity: "2.0" }],
};

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

function worker(body: object) {
  return mock.method(globalThis, "fetch", async () =>
    Response.json({ status: "connected", ...body }),
  );
}
const requested = (fetch: ReturnType<typeof worker>, call = 0) => {
  const url = fetch.mock.calls[call].arguments[0] as URL;
  return `${url.pathname}${url.search}`;
};

test("tickers are requested for every symbol or a list", async () => {
  const fetch = worker({ tickers: [ticker] });
  assert.deepEqual(await getMarketTickers(), {
    status: "connected",
    tickers: [ticker],
  });
  await getMarketTickers(["BTCUSDT", "ETHUSDT"]);
  assert.equal(requested(fetch), "/market/tickers");
  assert.equal(
    requested(fetch, 1),
    "/market/tickers?symbols=BTCUSDT%2CETHUSDT",
  );
  // An account without other assets needs no prices.
  assert.deepEqual(await getMarketTickers([]), {
    status: "connected",
    tickers: [],
  });
  assert.equal(fetch.mock.callCount(), 2);
});

test("klines and depth pass their parameters and keep decimal strings", async () => {
  const klines = worker({ klines: [kline] });
  const result = await getMarketKlines("ETH-USDT", "4h", 200);
  assert.equal(
    result.status === "connected" && result.klines[0].close,
    "60050.00",
  );
  assert.equal(
    requested(klines),
    "/market/klines?instrument=ETH-USDT&interval=4h&limit=200",
  );
  mock.restoreAll();

  const books = worker({ depth });
  assert.deepEqual(await getMarketDepth("BTC-USDT"), {
    status: "connected",
    depth,
  });
  assert.equal(requested(books), "/market/depth?instrument=BTC-USDT");
});

test("malformed or failed market data becomes a message, not data", async () => {
  worker({ tickers: [{ ...ticker, lastPrice: 60000.01 }] });
  const malformed = await getMarketTickers();
  assert.equal(malformed.status, "unavailable");
  assert.ok("message" in malformed && !("reason" in malformed));
  mock.restoreAll();

  mock.method(globalThis, "fetch", async () =>
    Response.json({ status: "unavailable" }, { status: 503 }),
  );
  const failed = await getMarketDepth("BTC-USDT", 10);
  assert.equal(failed.status, "unavailable");
  assert.ok("message" in failed);
});
