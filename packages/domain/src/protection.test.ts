import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkStopLossChange,
  checkTakeProfitChange,
  protectionIsValid,
} from "./protection";

describe("protectionIsValid", () => {
  it("requires the exits on the protective sides of the entry", () => {
    assert.equal(protectionIsValid("long", "100", "90", "110"), true);
    assert.equal(protectionIsValid("long", "100", "100", "110"), false);
    assert.equal(protectionIsValid("long", "100", "90", "100"), false);
    assert.equal(protectionIsValid("short", "100", "110", "90"), true);
    assert.equal(protectionIsValid("short", "100", "90", "110"), false);
  });
});

describe("checkStopLossChange", () => {
  const long = {
    direction: "long" as const,
    currentStopLossPrice: "57000",
    marketPrice: "60000",
  };

  it("lets the AI tighten a stop", () => {
    assert.deepEqual(
      checkStopLossChange({ ...long, proposedStopLossPrice: "58000" }),
      { allowed: true },
    );
    assert.deepEqual(
      checkStopLossChange({ ...long, proposedStopLossPrice: "57000" }),
      { allowed: true },
    );
    assert.deepEqual(
      checkStopLossChange({
        direction: "short",
        currentStopLossPrice: "63000",
        proposedStopLossPrice: "62000",
        marketPrice: "60000",
      }),
      { allowed: true },
    );
  });

  it("never lets the AI loosen or remove a stop", () => {
    const loosened = checkStopLossChange({
      ...long,
      proposedStopLossPrice: "56999.99",
    });
    const short = checkStopLossChange({
      direction: "short",
      currentStopLossPrice: "63000",
      proposedStopLossPrice: "63000.01",
      marketPrice: "60000",
    });
    const removed = checkStopLossChange({
      ...long,
      proposedStopLossPrice: null,
    });

    assert.equal(loosened.allowed, false);
    if (!loosened.allowed) assert.equal(loosened.code, "stop_loss_loosened");
    assert.equal(short.allowed, false);
    if (!short.allowed) assert.equal(short.code, "stop_loss_loosened");
    assert.equal(removed.allowed, false);
    if (!removed.allowed) assert.equal(removed.code, "stop_loss_removed");
  });

  it("rejects a stop the market has already reached", () => {
    const result = checkStopLossChange({
      ...long,
      proposedStopLossPrice: "60000",
    });

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "would_trigger_now");
  });
});

describe("checkTakeProfitChange", () => {
  const change = {
    direction: "long" as const,
    takeProfitAdjustable: true,
    proposedTakeProfitPrice: "65000",
    marketPrice: "60000",
  };

  it("keeps targets fixed unless the customer allows adjustment", () => {
    assert.deepEqual(checkTakeProfitChange(change), { allowed: true });
    const fixed = checkTakeProfitChange({
      ...change,
      takeProfitAdjustable: false,
    });
    assert.equal(fixed.allowed, false);
    if (!fixed.allowed) assert.equal(fixed.code, "take_profit_fixed");
  });

  it("rejects a target the market has already reached", () => {
    const result = checkTakeProfitChange({
      ...change,
      proposedTakeProfitPrice: "60000",
    });

    assert.equal(result.allowed, false);
    if (!result.allowed) assert.equal(result.code, "would_trigger_now");
  });
});
