import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addExchangeAccountRequestSchema,
  excessKeyPermissions,
  exchangeAccountLabelSchema,
  venueCapabilitiesSchema,
} from "./exchange-accounts.js";
import { accountModes, VENUES, type Venue } from "./venues.js";

const binance = VENUES["binance-spot-testnet"];
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
  },
};

test("a testnet account simulates, a read-only venue's account is live, and a venue that would trade real funds has none", () => {
  assert.deepEqual(accountModes(binance), ["simulation"]);
  assert.deepEqual(accountModes(readOnly), ["live"]);
  assert.deepEqual(
    accountModes({
      ...binance,
      capabilities: { ...binance.capabilities, funds: "real" },
    }),
    [],
  );
});

test("no key may withdraw, and a read-only account's key may not trade either", () => {
  const none = { trade: false, withdraw: false };
  assert.deepEqual(excessKeyPermissions(binance, none), []);
  assert.deepEqual(
    excessKeyPermissions(binance, { trade: true, withdraw: false }),
    [],
  );
  assert.deepEqual(
    excessKeyPermissions(binance, { trade: true, withdraw: true }),
    ["withdraw"],
  );
  assert.deepEqual(excessKeyPermissions(readOnly, none), []);
  assert.deepEqual(
    excessKeyPermissions(readOnly, { trade: true, withdraw: true }),
    ["trade", "withdraw"],
  );
});

test("every venue's declared capabilities can be recorded on an account", () => {
  for (const venue of Object.values(VENUES))
    assert.deepEqual(
      venueCapabilitiesSchema.parse(venue.capabilities),
      venue.capabilities,
    );
});

test("labels are trimmed, and must say something without control characters", () => {
  assert.equal(exchangeAccountLabelSchema.parse("  Main  "), "Main");
  for (const label of ["", "   ", "a".repeat(65), "Main\nline"])
    assert.equal(exchangeAccountLabelSchema.safeParse(label).success, false);
  const request = {
    venue: "binance-spot-testnet",
    label: "Main",
    mode: "simulation",
    accountingCurrency: "USDT",
    credentials: {
      kind: "hmac",
      apiKey: "k".repeat(16),
      secretKey: "s".repeat(16),
    },
  };
  assert.equal(
    addExchangeAccountRequestSchema.safeParse(request).success,
    true,
  );
  // Only venues this build knows, and only USDT accounting in M4.
  for (const change of [
    { venue: "htx-live" },
    { accountingCurrency: "GBP" },
    { mode: "paper" },
  ])
    assert.equal(
      addExchangeAccountRequestSchema.safeParse({ ...request, ...change })
        .success,
      false,
    );
});
