import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestnetTicker } from "@crypto-trading/exchanges";
import { allocationSlices, fillTotal, valuePortfolio } from "./portfolio";

function ticker(
  symbol: string,
  lastPrice: string,
  openPrice = lastPrice,
): TestnetTicker {
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
    openTime: 1_799_913_600_000,
    closeTime: 1_800_000_000_000,
  };
}
const balance = (asset: string, free: string, locked = "0") => ({
  asset,
  free,
  locked,
});

test("values balances directly, inversely and through a bridge asset", () => {
  const portfolio = valuePortfolio(
    [
      balance("USDT", "100", "50"),
      balance("BTC", "0.5", "0.25"),
      balance("TRY", "1000"),
      balance("JPY", "10000"),
      balance("THB", "100"),
      balance("XYZ", "5"),
    ],
    [
      ticker("BTCUSDT", "60000", "50000"),
      ticker("ETHUSDT", "3000"),
      ticker("USDTTRY", "40", "50"),
      ticker("BTCJPY", "6000000", "5000000"),
      ticker("ETHTHB", "100000"),
    ],
  );
  const byAsset = Object.fromEntries(
    portfolio.holdings.map((holding) => [holding.asset, holding]),
  );

  assert.deepEqual(byAsset.USDT.valuation, {
    price: "1",
    value: "150",
    change: "0",
    changePercent: null,
    source: "USDT counts as 1",
  });
  assert.equal(byAsset.BTC.quantity, "0.75");
  assert.deepEqual(byAsset.BTC.valuation, {
    price: "60000",
    value: "45000",
    change: "7500",
    changePercent: "20",
    source: "BTCUSDT",
  });
  assert.deepEqual(byAsset.TRY.valuation, {
    price: "0.025",
    value: "25",
    change: "5",
    changePercent: "25",
    source: "1 ÷ USDTTRY",
  });
  assert.deepEqual(byAsset.JPY.valuation, {
    price: "0.01",
    value: "100",
    change: "0",
    changePercent: "0",
    source: "1 ÷ BTCJPY × BTCUSDT",
  });
  assert.equal(byAsset.THB.valuation?.price, "0.03");
  assert.equal(byAsset.THB.valuation?.source, "1 ÷ ETHTHB × ETHUSDT");

  // XYZ has no market, so it is listed and left out rather than counted as zero.
  assert.equal(byAsset.XYZ.valuation, undefined);
  assert.deepEqual(portfolio.unpriced, ["XYZ"]);
  assert.equal(portfolio.total, "45278");
  assert.equal(portfolio.change, "7505");
  // 7505 ÷ (150 + 37500 + 20 + 100 + 3), the same holdings at the open.
  assert.equal(portfolio.changePercent?.slice(0, 12), "19.868689275");
  assert.deepEqual(
    portfolio.holdings.map(({ asset }) => asset),
    ["BTC", "USDT", "JPY", "TRY", "THB", "XYZ"],
  );
});

test("sums and products are exact", () => {
  const portfolio = valuePortfolio(
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

test("markets without a last or open price are skipped", () => {
  const portfolio = valuePortfolio(
    [balance("AAA", "2"), balance("BBB", "3")],
    [
      ticker("AAAUSDT", "0"),
      ticker("AAABTC", "0.0001"),
      ticker("BTCUSDT", "50000"),
      ticker("BBBUSDT", "4", "0"),
    ],
  );
  assert.equal(portfolio.holdings[0].valuation?.source, "AAABTC × BTCUSDT");
  assert.equal(portfolio.holdings[0].valuation?.value, "10");
  assert.deepEqual(portfolio.unpriced, ["BBB"]);
});

test("zero and sub-1 USDT balances are dust; unpriced balances are not", () => {
  const portfolio = valuePortfolio(
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
  // A zero balance with no price is not reported as left out.
  assert.deepEqual(portfolio.unpriced, ["XYZ"]);
});

test("the 24h percentage is absent when nothing had value at the open", () => {
  const portfolio = valuePortfolio([balance("XYZ", "1")], []);
  assert.equal(portfolio.total, "0");
  assert.equal(portfolio.change, "0");
  assert.equal(portfolio.changePercent, null);
  assert.deepEqual(allocationSlices(portfolio), []);
});

test("allocation folds the smallest holdings into Other past six slices", () => {
  const assets = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"];
  const tickers = assets.map((asset) => ticker(`${asset}USDT`, "1"));
  const balances = assets.map((asset, index) =>
    balance(asset, String(70 - index * 10)),
  );

  const seven = allocationSlices(valuePortfolio(balances, tickers));
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

  const six = allocationSlices(
    valuePortfolio(
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
