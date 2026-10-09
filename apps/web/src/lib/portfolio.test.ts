import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ticker } from "@crypto-trading/exchanges";
import {
  assetMix,
  fillTotal,
  tickerPrices,
  unvaluedHoldings,
  valuePortfolio,
} from "./portfolio";

// Every ticker last traded here, ten seconds before `now`.
const traded = 1_800_000_000_000;
const now = new Date(traded + 10_000);

function ticker(
  symbol: string,
  lastPrice: string,
  openPrice = lastPrice,
  closeTime = traded,
): Ticker {
  return {
    symbol,
    lastPrice,
    openPrice,
    highPrice: lastPrice,
    lowPrice: lastPrice,
    priceChange: "0",
    priceChangePercent: "0",
    volume: "1",
    quoteVolume: "1",
    openTime: closeTime - 86_400_000,
    closeTime,
  };
}
const balance = (asset: string, free: string, locked = "0") => ({
  asset,
  free,
  locked,
});
const binance = (tickers: Ticker[]) =>
  tickerPrices("binance-spot-testnet", tickers);
const value = (
  balances: ReturnType<typeof balance>[],
  tickers: Ticker[],
  currency = "USDT",
) => valuePortfolio(balances, currency, binance(tickers), now);

test("values balances through a direct market, its inverse, or USDC, and never through anything else", () => {
  const portfolio = value(
    [
      balance("USDT", "100", "50"),
      balance("BTC", "0.5", "0.25"),
      balance("TRY", "1000"),
      balance("ABC", "10"),
      balance("JPY", "10000"),
      balance("XYZ", "5"),
    ],
    [
      ticker("BTCUSDT", "60000", "50000"),
      ticker("ETHUSDT", "3000"),
      ticker("USDTTRY", "40", "50"),
      ticker("ABCUSDC", "2", "2"),
      ticker("USDCUSDT", "1.0005", "1"),
      // BTC is no bridge: JPY has no route to USDT.
      ticker("BTCJPY", "6000000", "5000000"),
    ],
  );
  const byAsset = Object.fromEntries(
    portfolio.holdings.map((holding) => [holding.asset, holding]),
  );

  assert.equal(portfolio.currency, "USDT");
  assert.deepEqual(byAsset.USDT.valuation, {
    price: "1",
    value: "150",
    change: "0",
    changePercent: null,
    source: "Already in USDT",
  });
  assert.equal(byAsset.BTC.quantity, "0.75");
  assert.deepEqual(byAsset.BTC.valuation, {
    price: "60000",
    value: "45000",
    change: "7500",
    changePercent: "20",
    source: "BTC/USDT",
  });
  assert.deepEqual(byAsset.TRY.valuation, {
    price: "0.025",
    value: "25",
    change: "5",
    changePercent: "25",
    source: "1 ÷ USDT/TRY",
  });
  assert.deepEqual(byAsset.ABC.valuation, {
    price: "2.001",
    value: "20.01",
    change: "0.01",
    changePercent: "0.05",
    source: "ABC/USDC × USDC/USDT",
  });

  // Without a route, a balance is listed and left out rather than counted as zero.
  assert.equal(byAsset.JPY.valuation, undefined);
  assert.deepEqual(byAsset.JPY.unconverted, {
    status: "missing",
    reason: "no_route",
  });
  assert.deepEqual(portfolio.unpriced, ["JPY", "XYZ"]);
  assert.equal(portfolio.total, "45195.01");
  assert.equal(portfolio.change, "7505.01");
  // 7505.01 ÷ (150 + 37500 + 20 + 20), the same holdings at the open.
  assert.equal(portfolio.changePercent?.slice(0, 12), "19.912470151");
  assert.deepEqual(
    portfolio.holdings.map(({ asset }) => asset),
    ["BTC", "USDT", "TRY", "ABC", "JPY", "XYZ"],
  );
});

test("a holding whose price is more than 60 seconds old is stale, with its time", () => {
  const old = traded - 60_001;
  const portfolio = value(
    [balance("ETH", "2"), balance("BTC", "1")],
    [ticker("ETHUSDT", "3000", "3000", old), ticker("BTCUSDT", "60000")],
  );
  const eth = portfolio.holdings.find(({ asset }) => asset === "ETH")!;

  assert.equal(eth.valuation, undefined);
  assert.deepEqual(eth.unconverted, { status: "stale", since: old });
  assert.equal(eth.dust, false);
  assert.equal(portfolio.total, "60000");
  assert.deepEqual(portfolio.valuation.unconverted, [
    { asset: "ETH", quantity: "2", status: "stale", since: old },
  ]);
});

test("values in another reporting currency through that venue's markets", () => {
  const portfolio = value(
    [balance("USDT", "112.2"), balance("BTC", "0.001")],
    [
      ticker("EURUSDT", "1.122", "1.1"),
      ticker("BTCEUR", "55000", "50000"),
      ticker("BTCUSDT", "60000"),
    ],
    "EUR",
  );
  const byAsset = Object.fromEntries(
    portfolio.holdings.map((holding) => [holding.asset, holding]),
  );

  assert.equal(byAsset.USDT.valuation?.value, "100");
  assert.equal(byAsset.USDT.valuation?.source, "1 ÷ EUR/USDT");
  // A direct BTC-EUR market is used before a route through USDT.
  assert.equal(byAsset.BTC.valuation?.source, "BTC/EUR");
  assert.equal(portfolio.total, "155");
});

test("only the account's own venue prices it", () => {
  const tickers = [ticker("BTCUSDT", "60000")];
  const elsewhere = valuePortfolio(
    [balance("BTC", "1")],
    "USDT",
    tickerPrices("htx", tickers),
    now,
  );
  assert.equal(elsewhere.total, "0");
  assert.deepEqual(elsewhere.unpriced, ["BTC"]);
});

test("a ticker whose open is not 24 hours back, as HTX's, values the holding without a 24h change", () => {
  // HTX's ticker opens at midnight Singapore time, here 6 hours before.
  const htxTicker = {
    ...ticker("btcusdt", "60000", "50000"),
    openTime: traded - 6 * 3_600_000,
  };
  const portfolio = valuePortfolio(
    [balance("BTC", "1"), balance("USDT", "10")],
    "USDT",
    tickerPrices("htx", [htxTicker]),
    now,
  );
  const btc = portfolio.holdings.find((holding) => holding.asset === "BTC");
  assert.equal(btc?.valuation?.value, "60000");
  assert.equal(btc?.valuation?.change, null);
  assert.equal(portfolio.total, "60010");
  // Nothing is counted as a change since the open.
  assert.equal(portfolio.valuation.change, "0");
});

test("sums and products are exact", () => {
  const portfolio = value(
    [balance("USDT", "0.1", "0.2"), balance("BTC", "123456789.12345678")],
    [ticker("BTCUSDT", "98765.43210987")],
  );
  assert.equal(portfolio.holdings[1].quantity, "0.3");
  assert.equal(
    portfolio.holdings[0].valuation?.value,
    "12193263124675.3076310231564186",
  );
  assert.equal(portfolio.total, "12193263124675.6076310231564186");
});

test("a listed market without a last price leaves its holding without a value; one without an open price has no 24h change", () => {
  const portfolio = value(
    [balance("AAA", "2"), balance("BBB", "3")],
    [
      // AAA's direct market is listed but has never traded, so AAA is not
      // valued through USDC instead.
      ticker("AAAUSDT", "0"),
      ticker("AAAUSDC", "5"),
      ticker("USDCUSDT", "1"),
      ticker("BBBUSDT", "4", "0"),
    ],
  );
  const [bbb, aaa] = portfolio.holdings;
  assert.equal(aaa.valuation, undefined);
  assert.deepEqual(aaa.unconverted, { status: "missing", reason: "no_price" });
  assert.equal(bbb.valuation?.value, "12");
  assert.equal(bbb.valuation?.change, null);
  assert.equal(bbb.valuation?.changePercent, null);
  assert.equal(portfolio.valuation.withoutOpen, 1);
  assert.deepEqual(portfolio.unpriced, ["AAA"]);
  assert.equal(portfolio.change, "0");
});

test("zero and sub-1 balances are dust; balances without a value are not", () => {
  const portfolio = value(
    [
      balance("USDT", "0.99"),
      balance("BTC", "0.00002"),
      balance("ETH", "0", "0"),
      balance("XYZ", "0.000001"),
      balance("BNB", "0.002"),
    ],
    [ticker("BTCUSDT", "50000"), ticker("BNBUSDT", "500")],
  );
  const dust = Object.fromEntries(
    portfolio.holdings.map(({ asset, dust }) => [asset, dust]),
  );
  assert.deepEqual(dust, {
    BTC: false,
    BNB: false,
    USDT: true,
    ETH: true,
    XYZ: false,
  });
  // A zero balance with no route is not reported as left out.
  assert.deepEqual(portfolio.unpriced, ["XYZ"]);
  assert.equal(
    portfolio.holdings.find(({ asset }) => asset === "ETH")?.unconverted,
    undefined,
  );
});

test("dust is judged at the cent shown", () => {
  const portfolio = value(
    [balance("USDT", "0.995"), balance("USDC", "0.99499999")],
    [ticker("USDCUSDT", "1")],
  );
  assert.deepEqual(
    portfolio.holdings.map(({ asset, dust }) => [asset, dust]),
    [
      ["USDT", false],
      ["USDC", true],
    ],
  );
});

test("the 24h percentage is absent when nothing had value at the open", () => {
  const portfolio = value([balance("XYZ", "1")], []);
  assert.equal(portfolio.total, "0");
  assert.equal(portfolio.change, "0");
  assert.equal(portfolio.changePercent, null);
  assert.deepEqual(assetMix(portfolio), []);
});

test("without prices, balances are listed by asset with no value", () => {
  assert.deepEqual(
    unvaluedHoldings([balance("XYZ", "1"), balance("ABC", "0", "0")]),
    [
      { asset: "ABC", free: "0", locked: "0", quantity: "0", dust: true },
      { asset: "XYZ", free: "1", locked: "0", quantity: "1", dust: false },
    ],
  );
});

test("the asset mix folds the smallest holdings into Other past six slices", () => {
  const assets = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"];
  const tickers = assets.map((asset) => ticker(`${asset}USDT`, "1"));
  const balances = assets.map((asset, index) =>
    balance(asset, String(70 - index * 10)),
  );

  const seven = assetMix(value(balances, tickers));
  assert.deepEqual(
    seven.map(({ label, value, folded }) => [label, value, folded]),
    [
      ["AAA", "70", 0],
      ["BBB", "60", 0],
      ["CCC", "50", 0],
      ["DDD", "40", 0],
      ["EEE", "30", 0],
      ["Other", "30", 2],
    ],
  );
  assert.equal(seven[0].share, "25");

  const six = assetMix(
    value(
      [...balances.slice(0, 6), balance("ZERO", "0")],
      [...tickers, ticker("ZEROUSDT", "1")],
    ),
  );
  assert.deepEqual(
    six.map(({ label }) => label),
    ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"],
  );
});

test("a fill's total is price times quantity", () => {
  assert.equal(fillTotal({ price: "60000.01", qty: "0.00123" }), "73.8000123");
});
