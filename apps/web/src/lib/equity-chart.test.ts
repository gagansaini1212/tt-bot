import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  entryName,
  formatPercentage,
  formatPeriod,
  formatSigned,
} from "./backtest-display";
import { dayTicks, linePath, nearestPoint, valueAxis } from "./equity-chart";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("equity chart geometry", () => {
  const points = [
    { time: 0, strategy: 1000, baseline: 1000 },
    { time: HOUR, strategy: 1012.4, baseline: 981.2 },
    { time: 2 * HOUR, strategy: 1003, baseline: 1043.9 },
  ];

  test("spans every point and the allocation with round ticks", () => {
    assert.deepEqual(valueAxis(points, 1000), {
      min: 980,
      max: 1060,
      ticks: [980, 1000, 1020, 1040, 1060],
    });
    // A flat curve still gets a band.
    const flat = valueAxis([{ time: 0, strategy: 1000, baseline: 1000 }], 1000);
    assert.ok(flat.max > flat.min);
  });

  test("labels UTC midnights, thinned to fit", () => {
    assert.deepEqual(dayTicks(0, 3 * DAY, 6), [0, DAY, 2 * DAY, 3 * DAY]);
    assert.deepEqual(dayTicks(HOUR, 30 * DAY, 3), [DAY, 11 * DAY, 21 * DAY]);
  });

  test("draws a path and finds the point nearest a time", () => {
    assert.equal(
      linePath(
        points,
        "strategy",
        (time) => time / HOUR,
        (value) => value - 1000,
      ),
      "M0.00 0.00 L1.00 12.40 L2.00 3.00",
    );
    assert.equal(nearestPoint(points, 0.4 * HOUR), 0);
    assert.equal(nearestPoint(points, 0.6 * HOUR), 1);
    assert.equal(nearestPoint(points, 9 * HOUR), 2);
  });
});

describe("backtest display", () => {
  test("formats signed amounts and percentages exactly", () => {
    assert.equal(formatSigned("1234.567"), "+1,234.57");
    assert.equal(formatSigned("-0.004"), "0.00");
    assert.equal(formatSigned("-19.2737444"), "-19.27");
    assert.equal(formatPercentage("-1.92737444"), "-1.93%");
    assert.equal(
      formatPercentage("1.9764631666954201174", { unsigned: true }),
      "1.98%",
    );
  });

  test("names entries and periods", () => {
    assert.equal(entryName("level:3"), "Level 4");
    assert.equal(entryName("buy:0"), "Buy 1");
    assert.equal(
      formatPeriod({
        start: "2026-09-04T00:00:00.000Z",
        end: "2026-09-11T00:00:00.000Z",
      }),
      "Sep 4 – Sep 10, 2026",
    );
  });
});
