import assert from "node:assert/strict";
import { test } from "node:test";
import { marketsHref, parseMarketSelection } from "./markets";

const read = (params: Record<string, string | string[] | undefined>) => {
  const { market, interval } = parseMarketSelection(params);
  return `${market.label} ${interval}`;
};

test("the pair and interval come from the query", () => {
  assert.equal(read({}), "BTC/USDT 1h");
  assert.equal(read({ pair: "ETH-USDT", interval: "4h" }), "ETH/USDT 4h");
  assert.equal(read({ pair: "BTC-USDT", interval: "15m" }), "BTC/USDT 15m");
  assert.equal(read({ interval: "1d" }), "BTC/USDT 1d");
});

test("unknown, repeated or unsupported values fall back to the defaults", () => {
  assert.equal(read({ pair: "DOGE-USDT", interval: "1M" }), "BTC/USDT 1h");
  assert.equal(read({ pair: "ETHUSDT", interval: "1H" }), "BTC/USDT 1h");
  assert.equal(
    read({ pair: ["ETH-USDT", "ETH-USDT"], interval: ["4h"] }),
    "BTC/USDT 1h",
  );
});

test("links carry the pair and interval", () => {
  const selection = parseMarketSelection({ pair: "ETH-USDT", interval: "15m" });
  assert.equal(marketsHref(selection), "/markets?pair=ETH-USDT&interval=15m");
  assert.deepEqual(
    parseMarketSelection(
      Object.fromEntries(
        new URL(marketsHref(selection), "http://localhost").searchParams,
      ),
    ),
    selection,
  );
});
