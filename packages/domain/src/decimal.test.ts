import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ceilToStep,
  floorToStep,
  positiveDecimalString,
  quantityFor,
  signedDecimalString,
} from "./decimal";

describe("decimal strings", () => {
  it("rejects malformed numbers instead of throwing", () => {
    for (const value of ["abc", "", "1e5", "01", "1.", ".5", "-1", " 1"])
      assert.equal(positiveDecimalString.safeParse(value).success, false);
    assert.equal(positiveDecimalString.safeParse("0").success, false);
    assert.equal(positiveDecimalString.safeParse("0.00000001").success, true);
  });

  it("accepts signed decimals only in the signed schema", () => {
    assert.equal(signedDecimalString.safeParse("-12.5").success, true);
    assert.equal(signedDecimalString.safeParse("--1").success, false);
  });
});

describe("step rounding", () => {
  it("floors and ceils to the step exactly", () => {
    assert.equal(floorToStep("60000.019", "0.01").toFixed(), "60000.01");
    assert.equal(ceilToStep("60000.011", "0.01").toFixed(), "60000.02");
    assert.equal(ceilToStep("60000.01", "0.01").toFixed(), "60000.01");
    assert.equal(floorToStep("0.3", "0.1").toFixed(), "0.3");
  });

  it("rejects a step that is not positive", () => {
    assert.throws(() => floorToStep("1", "0"), RangeError);
    assert.throws(() => quantityFor("1", "1", "0"), RangeError);
  });
});

describe("quantityFor", () => {
  it("buys whole steps without exceeding the amount", () => {
    // 100 / 60000 is 0.0016666…
    assert.equal(quantityFor("100", "60000", "0.00001").toFixed(), "0.00166");
    // Exactly 0.001 BTC fits.
    assert.equal(quantityFor("60", "60000", "0.00001").toFixed(), "0.001");
    assert.equal(quantityFor("0.5", "60000", "0.00001").toFixed(), "0");
  });
});
