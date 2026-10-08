import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAge,
  formatAmount,
  formatChange,
  formatDecimal,
  formatPercent,
  formatPrice,
  formatUtc,
} from "./format";

test("amounts round to cents without losing digits", () => {
  assert.equal(
    formatAmount("12345678901234567890.125"),
    "12,345,678,901,234,567,890.13",
  );
  assert.equal(formatAmount("9917.86"), "9,917.86");
  assert.equal(formatAmount("0"), "0.00");
  assert.equal(formatAmount("0.004"), "< 0.01");
});

test("decimals drop trailing zeros but no digits", () => {
  assert.equal(formatDecimal("0.00120000"), "0.0012");
  assert.equal(formatDecimal("25000.00000000"), "25,000");
  assert.equal(formatDecimal("0.00000001"), "0.00000001");
  assert.equal(formatDecimal("82364.70000000", { cents: true }), "82,364.70");
  assert.equal(formatDecimal("0.00012345", { cents: true }), "0.00012345");
});

test("changes and percentages carry a sign unless they round to zero", () => {
  assert.equal(formatChange("1234.5"), "+1,234.50");
  assert.equal(formatChange("-0.456"), "-0.46");
  assert.equal(formatChange("-0.001"), "0.00");
  assert.equal(formatPercent("19.868689"), "+19.87%");
  assert.equal(formatPercent("-1.434"), "-1.43%");
  assert.equal(formatPercent("0"), "0.00%");
});

test("prices keep four significant digits below 1", () => {
  assert.equal(formatPrice("82364.7"), "82,364.70");
  assert.equal(formatPrice("1"), "1.00");
  assert.equal(formatPrice("0.020325203252032520325"), "0.02033");
  assert.equal(formatPrice("0.00000123"), "0.00000123");
});

test("times show in UTC and relative to a reference time", () => {
  const time = Date.UTC(2026, 9, 8, 13, 5, 9);
  assert.equal(formatUtc(time), "2026-10-08 13:05:09 UTC");
  assert.equal(formatAge(time, time + 59_999), "just now");
  // Clock differences can put a fill slightly after the reference time.
  assert.equal(formatAge(time, time - 5_000), "just now");
  assert.equal(formatAge(time, time + 5 * 60_000), "5m ago");
  assert.equal(formatAge(time, time + 2 * 3_600_000 + 59 * 60_000), "2h ago");
  assert.equal(formatAge(time, time + 3 * 86_400_000), "3d ago");
});
