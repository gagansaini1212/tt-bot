import assert from "node:assert/strict";
import { test } from "node:test";
import {
  depthAt,
  depthDomain,
  depthPath,
  niceTicks,
  type DepthCurve,
} from "./depth-chart";

// Bids reach 4 below the mid of 100; asks reach 10 above it.
const curve: DepthCurve = {
  bids: [
    { price: 99.5, total: 1 },
    { price: 98, total: 3 },
    { price: 96, total: 6 },
  ],
  asks: [
    { price: 100.5, total: 2 },
    { price: 103, total: 4 },
    { price: 110, total: 50 },
  ],
};

test("the range is centred on the mid and as wide as the shorter side", () => {
  assert.deepEqual(depthDomain(curve), {
    mid: 100,
    min: 96,
    max: 104,
    maxTotal: 6,
  });
});

test("one empty side uses the other side's reach", () => {
  assert.deepEqual(depthDomain({ bids: curve.bids, asks: [] }), {
    mid: 99.5,
    min: 96,
    max: 103,
    maxTotal: 6,
  });
  assert.deepEqual(
    depthDomain({ bids: [], asks: [{ price: 2000, total: 1 }] }),
    { mid: 2000, min: 1998, max: 2002, maxTotal: 1 },
  );
  assert.equal(depthDomain({ bids: [], asks: [] }), null);
});

test("the edge level counts towards the height despite rounding", () => {
  const domain = depthDomain({
    bids: [
      { price: 82384, total: 1 },
      { price: 82383.99, total: 5 },
    ],
    asks: [
      { price: 82384.01, total: 2 },
      { price: 82390, total: 3 },
    ],
  });
  assert.equal(domain?.maxTotal, 5);
});

test("depth at a price sums the levels between it and the mid", () => {
  assert.deepEqual(depthAt(curve, 100, 99.8), { side: "bids", total: 0 });
  assert.deepEqual(depthAt(curve, 100, 99.5), { side: "bids", total: 1 });
  assert.deepEqual(depthAt(curve, 100, 97), { side: "bids", total: 3 });
  assert.deepEqual(depthAt(curve, 100, 100.2), { side: "asks", total: 0 });
  assert.deepEqual(depthAt(curve, 100, 103.9), { side: "asks", total: 4 });
});

test("paths step outward and only extend towards the edge", () => {
  const same = (value: number) => value;
  assert.equal(depthPath(curve.bids, same, same, 96), "M99.5 0V1H98V3H96V6");
  assert.equal(
    depthPath(curve.bids.slice(0, 2), same, same, 96, true),
    "M99.5 0V1H98V3H96V0H99.5Z",
  );
  // The asks run past the edge, so the path must not turn back to it.
  assert.equal(
    depthPath(curve.asks, same, same, 104),
    "M100.5 0V2H103V4H110V50",
  );
  assert.equal(depthPath([], same, same, 104), "");
});

test("ticks are round numbers from zero", () => {
  assert.deepEqual(niceTicks(6, 4), [0, 2, 4, 6]);
  assert.deepEqual(niceTicks(62.13, 3), [0, 25, 50]);
  assert.deepEqual(niceTicks(0.3, 3), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(0, 3), [0]);
});
