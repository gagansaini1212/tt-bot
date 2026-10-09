import assert from "node:assert/strict";
import { test } from "node:test";
import { VENUES, type Venue } from "@crypto-trading/exchanges/venues";
import {
  accountVenue,
  addableVenues,
  describeFeatures,
  isReadOnly,
  signingChoices,
} from "./exchange-account-display";

const binance = VENUES["binance-spot-testnet"];

test("an account's venue is known only if this build has its adapter", () => {
  assert.equal(accountVenue("binance-spot-testnet"), binance);
  assert.equal(accountVenue("htx"), VENUES.htx);
  assert.equal(accountVenue("kraken"), undefined);
  // HTX accounts can be added, read only.
  assert.deepEqual(addableVenues(), [binance, VENUES.htx]);
  assert.equal(isReadOnly(binance), false);
  assert.equal(isReadOnly(VENUES.htx), true);
});

test("a venue's keys sign with the kinds it accepts", () => {
  assert.deepEqual(signingChoices(binance), [
    { value: "hmac", label: "Secret key (HMAC)" },
    { value: "private_key", label: "Private key (Ed25519, RSA)" },
  ]);
  const jwtOnly: Venue = {
    ...binance,
    credentials: { keyTypes: ["es256"], passphrase: false },
  };
  assert.deepEqual(signingChoices(jwtOnly), [
    { value: "private_key", label: "Private key (ES256)" },
  ]);
});

test("what a venue supports reads in a few words", () => {
  assert.equal(
    describeFeatures({
      ...binance.capabilities,
      marketKinds: [...binance.capabilities.marketKinds],
      orderTypes: [...binance.capabilities.orderTypes],
      timeInForce: [...binance.capabilities.timeInForce],
      orderLists: [...binance.capabilities.orderLists],
    }),
    "Spot · trades with virtual funds · exits attached (OPOCO)",
  );
  assert.equal(
    describeFeatures({
      ...binance.capabilities,
      marketKinds: ["spot"],
      access: "read_only",
      funds: "real",
      orderTypes: [],
      timeInForce: [],
      orderLists: [],
      attachedExits: null,
      stopOrders: "none",
    }),
    "Spot · read only, real funds",
  );
});
