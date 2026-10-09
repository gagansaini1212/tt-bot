import assert from "node:assert/strict";
import { test } from "node:test";
import {
  binanceClientOrderIds,
  binanceVenueSymbols,
  canPlaceOrders,
  exchangeAccountAccess,
  VENUE_IDS,
  venueFor,
  venueIdSchema,
  VENUES,
  type Venue,
} from "./venues.js";
import { closeOrderId, protectedLegIds } from "./order-rules.js";

test("every venue is known by its ID, and only known IDs are venues", () => {
  assert.deepEqual(VENUE_IDS, ["binance-spot-testnet", "htx"]);
  assert.equal(venueFor("binance-spot-testnet").name, "Binance Spot Testnet");
  assert.equal(venueFor("htx").name, "HTX");
  for (const id of ["binance", "htx-live", "", "BINANCE-SPOT-TESTNET"])
    assert.equal(venueIdSchema.safeParse(id).success, false, id);
});

test("Binance's venue symbols join the assets, and the asset codes are its own", () => {
  assert.equal(binanceVenueSymbols.toVenueSymbol("BTC-USDT"), "BTCUSDT");
  assert.equal(binanceVenueSymbols.toVenueSymbol("ETH-BTC"), "ETHBTC");
  assert.equal(binanceVenueSymbols.assetCode("BTC"), "BTC");
  assert.throws(() =>
    binanceVenueSymbols.toVenueSymbol("BTCUSDT" as "BTC-USDT"),
  );
});

test("the application's order IDs translate to Binance's client order IDs and back unchanged", () => {
  // Stored intents keep working: today's ct_ IDs, their legs and closes.
  const list = "ct_Zm9vYmFyYmF6cXV4cXV1eA";
  const ids = [
    list,
    "ct_sgabc123",
    "ct_dev_001",
    ...Object.values(protectedLegIds(list)),
    closeOrderId(list, 9),
  ];
  for (const id of ids) {
    const venueId = binanceClientOrderIds.toVenue(id);
    assert.equal(venueId, id);
    assert.ok(venueId.length <= 36);
    assert.equal(binanceClientOrderIds.fromVenue(venueId), id);
  }
  // Orders placed outside the application are not the application's.
  for (const foreign of ["web_8f2c1d", "x-AB12", "and_123", ""])
    assert.equal(binanceClientOrderIds.fromVenue(foreign), undefined);
  // An ID Binance could not carry, or that is not the application's, is
  // refused before anything is sent.
  for (const invalid of [
    "web_8f2c1d",
    `ct_${"a".repeat(34)}`,
    "ct_has space",
    "ct_",
  ])
    assert.throws(() => binanceClientOrderIds.toVenue(invalid), invalid);
});

test("capabilities are explicit, and only a testnet that attaches exits places orders", () => {
  const binance = VENUES["binance-spot-testnet"];
  assert.deepEqual(binance.capabilities.marketKinds, ["spot"]);
  assert.equal(binance.capabilities.attachedExits, "opoco");
  assert.equal(binance.capabilities.stopOrders, "exits_only");
  assert.equal(canPlaceOrders(binance), true);
  // HTX is read only in M4: its funds are real, and its adapter only reads.
  assert.equal(canPlaceOrders(VENUES.htx), false);
  // Live trading stays impossible: no venue with real funds trades.
  for (const venue of Object.values(VENUES) as Venue[])
    assert.ok(
      !canPlaceOrders(venue) || venue.capabilities.funds === "virtual",
      venue.id,
    );

  // A read-only venue, as HTX is in M4, never places orders, whatever its
  // other capabilities say.
  const readOnly: Venue = {
    ...binance,
    capabilities: {
      ...binance.capabilities,
      access: "read_only",
      funds: "real",
      orderTypes: [],
      orderLists: [],
      attachedExits: null,
      stopOrders: "none",
      testOrders: false,
      lookupByClientOrderId: false,
    },
  };
  assert.equal(canPlaceOrders(readOnly), false);
  for (const capabilities of [
    { ...binance.capabilities, funds: "real" as const },
    { ...binance.capabilities, attachedExits: null },
    { ...binance.capabilities, access: "read_only" as const },
  ])
    assert.equal(canPlaceOrders({ ...binance, capabilities }), false);
});

test("an exchange account trades only on a venue that places orders; any other is read only", () => {
  assert.equal(exchangeAccountAccess("binance-spot-testnet"), "trade");
  // A venue this build has no trading adapter for, such as HTX, or a value
  // that names no venue, is never traded.
  for (const exchange of ["htx", "binance", "", "BINANCE-SPOT-TESTNET"])
    assert.equal(exchangeAccountAccess(exchange), "read_only", exchange);
});
