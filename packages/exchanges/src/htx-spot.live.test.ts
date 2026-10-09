// Parses HTX's live public market data. These send unsigned GET requests to
// https://api.huobi.pro with no API key, so nothing here can read an account
// or trade. They need the network, so they run only when asked:
//
//   HTX_LIVE_MARKET_DATA=1 pnpm --filter @crypto-trading/exchanges test
import assert from "node:assert/strict";
import { test } from "node:test";
import { HtxSpot } from "./htx-spot.js";
import { UnlistedMarketError } from "./market-catalogue.js";

const skip =
  process.env.HTX_LIVE_MARKET_DATA === "1"
    ? false
    : "set HTX_LIVE_MARKET_DATA=1 to read HTX's live market data";

const sent: URL[] = [];
const exchange = new HtxSpot({
  publicData: true,
  fetch: (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    sent.push(url);
    return fetch(input, init);
  }) as typeof fetch,
});

test(
  "live: HTX's market catalogue lists BTC-USDT with its trading rules",
  { skip },
  async () => {
    const markets = await exchange.loadMarkets();
    assert.ok(markets.length > 100, `${markets.length} markets`);
    const btc = await exchange.getMarketRules("BTC-USDT");
    assert.equal(btc.venueSymbol, "btcusdt");
    assert.equal(btc.status, "trading");
    for (const value of [
      btc.tickSize,
      btc.stepSize,
      btc.minQty,
      btc.minNotional,
    ])
      assert.ok(Number(value) > 0, value);
    assert.ok(
      markets.every((market) => market.protectedEntryAllowed === false),
    );
    await assert.rejects(
      exchange.getMarketRules("NOSUCHCOIN-USDT"),
      UnlistedMarketError,
    );
  },
);

test(
  "live: every HTX ticker parses, and BTC's is priced",
  { skip },
  async () => {
    const tickers = await exchange.getTickers();
    assert.ok(tickers.length > 100, `${tickers.length} tickers`);
    const [btc] = await exchange.getTickers(["btcusdt"]);
    assert.ok(Number(btc.lastPrice) > 0);
    assert.ok(btc.openTime < btc.closeTime);
    assert.ok(btc.closeTime - btc.openTime <= 86_400_000);
  },
);

test(
  "live: HTX's hourly klines come oldest first, an hour apart",
  { skip },
  async () => {
    const klines = await exchange.getKlines("BTC-USDT", "1h", 10);
    assert.equal(klines.length, 10);
    for (const [index, kline] of klines.entries()) {
      assert.equal(kline.closeTime, kline.openTime + 3_599_999);
      if (index > 0)
        assert.equal(kline.openTime - klines[index - 1].openTime, 3_600_000);
    }
  },
);

test("live: HTX's order book and last trade parse", { skip }, async () => {
  const depth = await exchange.getDepth("BTC-USDT", 20);
  assert.equal(depth.bids.length, 20);
  assert.equal(depth.asks.length, 20);
  assert.ok(Number(depth.bids[0].price) < Number(depth.asks[0].price));
  assert.ok(Number(await exchange.getLastPrice("BTC-USDT")) > 0);
});

test("live: nothing sent to HTX was signed or carried a key", { skip }, () => {
  assert.ok(sent.length > 0);
  for (const url of sent) {
    assert.equal(url.origin, "https://api.huobi.pro");
    assert.equal(url.searchParams.has("Signature"), false);
    assert.equal(url.searchParams.has("AccessKeyId"), false);
  }
});
