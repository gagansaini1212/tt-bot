import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountReader } from "./contract";
import { CredentialsError } from "./signing";
import {
  binanceSpotTestnetVenue,
  canTrade,
  VenueRegistry,
} from "./venue-registry";

test("each registered venue keeps its own limits, catalogue and public client, shared by its accounts", () => {
  const venue = binanceSpotTestnetVenue();
  const registry = new VenueRegistry([venue]);
  assert.deepEqual(registry.venues, ["binance-spot-testnet"]);
  const first = registry.connect("binance-spot-testnet", {
    kind: "hmac",
    apiKey: "first",
    secret: "first-secret",
  });
  const second = registry.connect("binance-spot-testnet", {
    kind: "hmac",
    apiKey: "second",
    secret: "second-secret",
  });
  assert.notEqual(first, second);
  assert.equal(first.markets, venue.market.markets);
  assert.equal(second.markets, venue.market.markets);
  // Another registry, as for another venue, shares none of it.
  const other = binanceSpotTestnetVenue();
  assert.notEqual(other.limits, venue.limits);
  assert.notEqual(other.market.markets, venue.market.markets);
  assert.throws(
    () => new VenueRegistry([venue, other]),
    /Two venues registered as binance-spot-testnet/,
  );
});

test("a venue without a connector, or credentials it cannot use, gets no client", () => {
  const registry = new VenueRegistry([]);
  assert.equal(registry.get("binance-spot-testnet"), undefined);
  assert.throws(
    () =>
      registry.connect("binance-spot-testnet", {
        kind: "hmac",
        apiKey: "key",
        secret: "secret",
      }),
    /does not connect to binance-spot-testnet/,
  );
  assert.throws(
    () =>
      binanceSpotTestnetVenue().connect({
        kind: "hmac",
        apiKey: "key",
        secret: "secret",
        passphrase: "phrase",
      }),
    CredentialsError,
  );
});

test("only a client of a venue that places orders, with every order method, can trade", () => {
  const binance = binanceSpotTestnetVenue().connect({
    kind: "hmac",
    apiKey: "key",
    secret: "secret",
  });
  assert.equal(canTrade(binance), true);
  // A reader on the same venue, without order methods, only reads.
  const reader = {
    venue: "binance-spot-testnet",
    getAccount: binance.getAccount.bind(binance),
  } as unknown as AccountReader;
  assert.equal(canTrade(reader), false);
});
