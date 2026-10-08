import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { strategyStatusLabel } from "./strategy-status";

describe("strategyStatusLabel", () => {
  it("maps stored statuses onto Running, Paused and Completed", () => {
    assert.equal(strategyStatusLabel("simulation"), "Running");
    assert.equal(strategyStatusLabel("active"), "Running");
    assert.equal(strategyStatusLabel("paused"), "Paused");
    assert.equal(strategyStatusLabel("retired"), "Completed");
  });
});
