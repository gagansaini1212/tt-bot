import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MARKET_CATALOGUE_TTL_MS,
  MarketCatalogue,
  UnlistedMarketError,
  type MarketRules,
} from "./market-catalogue.js";

const market = (
  instrument: MarketRules["instrument"],
  venueSymbol: string,
): MarketRules => ({
  instrument,
  venueSymbol,
  status: "trading",
  protectedEntryAllowed: true,
  minPrice: "0.01",
  maxPrice: "1000000",
  tickSize: "0.01",
  minQty: "0.00001",
  maxQty: "9000",
  stepSize: "0.00001",
  minNotional: "5",
  maxNotional: "0",
});

function catalogue(load: () => Promise<MarketRules[]>) {
  let now = 0;
  let loads = 0;
  const markets = new MarketCatalogue({
    venue: "binance-spot-testnet",
    load: () => {
      loads += 1;
      return load();
    },
    now: () => now,
  });
  return {
    markets,
    loads: () => loads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("the catalogue maps instruments to venue symbols and back", async () => {
  const { markets } = catalogue(async () => [
    market("BTC-USDT", "BTCUSDT"),
    market("ETH-BTC", "ETHBTC"),
  ]);
  assert.equal((await markets.rules("ETH-BTC")).venueSymbol, "ETHBTC");
  assert.equal(await markets.instrumentForVenueSymbol("BTCUSDT"), "BTC-USDT");
  assert.equal(await markets.instrumentForVenueSymbol("BTCUSD"), undefined);
  assert.equal(await markets.find("SOL-USDT"), undefined);
  await assert.rejects(
    markets.rules("SOL-USDT"),
    (error: unknown) =>
      error instanceof UnlistedMarketError &&
      error.instrument === "SOL-USDT" &&
      error.venue === "binance-spot-testnet",
  );
});

test("the catalogue loads once per TTL, shares a load in flight, and retries a failed one", async () => {
  let fail = true;
  const c = catalogue(async () => {
    if (fail) throw new Error("unavailable");
    return [market("BTC-USDT", "BTCUSDT")];
  });
  await assert.rejects(c.markets.markets());
  fail = false;
  // Not kept: the next call loads again.
  const [first, second] = await Promise.all([
    c.markets.markets(),
    c.markets.find("BTC-USDT"),
  ]);
  assert.equal(first.length, 1);
  assert.ok(second);
  assert.equal(c.loads(), 2);
  c.advance(MARKET_CATALOGUE_TTL_MS);
  await c.markets.markets();
  assert.equal(c.loads(), 2);
  c.advance(1);
  await c.markets.markets();
  assert.equal(c.loads(), 3);
  c.markets.forget();
  await c.markets.markets();
  assert.equal(c.loads(), 4);
});

test("a venue that lists one instrument or venue symbol twice is not trusted", async () => {
  for (const listing of [
    [market("BTC-USDT", "BTCUSDT"), market("BTC-USDT", "XBTUSDT")],
    [market("BTC-USDT", "BTCUSDT"), market("XBT-USDT", "BTCUSDT")],
  ]) {
    const { markets } = catalogue(async () => listing);
    await assert.rejects(markets.markets(), /more than once/);
  }
});
