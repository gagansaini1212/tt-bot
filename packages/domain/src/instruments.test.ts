import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowedInstrumentsSchema,
  DEFAULT_ALLOWED_INSTRUMENTS,
  instrumentAssets,
  instrumentFor,
  instrumentLabel,
  instrumentSchema,
  isInstrument,
} from "./instruments";

test("an instrument is any BASE-QUOTE market, not a fixed list", () => {
  for (const valid of [
    "BTC-USDT",
    "ETH-BTC",
    "BTC-USD",
    "1000SATS-USDT",
    // Binance lists some assets in scripts without case.
    "币安人生-USDT",
  ])
    assert.equal(instrumentSchema.safeParse(valid).success, true, valid);
  for (const invalid of [
    "BTCUSDT",
    "btc-usdt",
    "BTC/USDT",
    "BTC-US-DT",
    "-USDT",
    "BTC-",
    "BTC_USDT",
    "BTC-USDT ",
    `${"A".repeat(21)}-USDT`,
    42,
  ])
    assert.equal(
      instrumentSchema.safeParse(invalid).success,
      false,
      String(invalid),
    );
  assert.equal(isInstrument("ETH-BTC"), true);
  assert.equal(isInstrument("ETHBTC"), false);
});

test("an instrument splits into its assets and back", () => {
  assert.deepEqual(instrumentAssets("ETH-BTC"), { base: "ETH", quote: "BTC" });
  assert.equal(instrumentFor("ETH", "BTC"), "ETH-BTC");
  assert.equal(instrumentFor("eth", "BTC"), undefined);
  assert.equal(instrumentFor("ETH-X", "BTC"), undefined);
  assert.equal(instrumentLabel("BTC-USDT"), "BTC/USDT");
  assert.throws(() => instrumentAssets("BTCUSDT" as "B-Q"));
});

test("the default allowed instruments are today's two, as configuration", () => {
  assert.deepEqual(DEFAULT_ALLOWED_INSTRUMENTS, ["BTC-USDT", "ETH-USDT"]);
  assert.equal(
    allowedInstrumentsSchema.safeParse(DEFAULT_ALLOWED_INSTRUMENTS).success,
    true,
  );
  assert.equal(allowedInstrumentsSchema.safeParse([]).success, false);
  assert.equal(
    allowedInstrumentsSchema.safeParse(["BTC-USDT", "BTC-USDT"]).success,
    false,
  );
});
