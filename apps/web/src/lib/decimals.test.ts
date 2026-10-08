import assert from "node:assert/strict";
import { test } from "node:test";
import { fractionDigits, formatDecimal } from "./decimals";

test("decimals keep their places and group thousands", () => {
  assert.equal(fractionDigits(["82384.01000000", "1.50000000", "7"]), 2);
  assert.equal(fractionDigits(["0.00000001"]), 8);
  assert.equal(fractionDigits([]), 0);
  assert.equal(formatDecimal("82384.5", 2), "82,384.50");
  assert.equal(formatDecimal("1234567.891", 0), "1,234,568");
  assert.equal(formatDecimal("0.1", 3), "0.100");
  assert.equal(formatDecimal("-1234.5", 1), "-1,234.5");
  assert.equal(formatDecimal("999.995", 2), "1,000.00");
});
