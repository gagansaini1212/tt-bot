import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateAdaptiveDipDrop,
  calculateAdaptivePositionMultiplier,
  deriveLesson,
} from "./trade-mistakes";

describe("trade mistakes learning", () => {
  test("derives an instructive lesson and defensive action from a stop loss hit", () => {
    const { lesson, adaptiveAction } = deriveLesson("stop_loss", {
      instrument: "BTC-USDT",
      entryPrice: "65000",
      exitPrice: "63050",
      lossPercent: "3.00",
    });
    assert.match(lesson, /Stop loss was hit on BTC\/USDT at 63050 \(-3.00%\)/);
    assert.match(lesson, /Avoid entering near short-term resistance/);
    assert.match(adaptiveAction, /Enforced a 60-minute cooldown on BTC\/USDT/);
    assert.match(adaptiveAction, /Downsized subsequent entry capital by 50%/);
  });

  test("derives a lesson from a customer-rejected proposal", () => {
    const { lesson, adaptiveAction } = deriveLesson("rejected_proposal", {
      instrument: "ETH-USDT",
      reason: "High volatility risk before news",
    });
    assert.match(lesson, /Trade proposal on ETH\/USDT was rejected by the customer/);
    assert.match(lesson, /High volatility risk before news/);
    assert.match(adaptiveAction, /AI decision prompt updated with negative reinforcement/);
  });

  test("derives a lesson from holding deadline expiration", () => {
    const { lesson, adaptiveAction } = deriveLesson("holding_deadline", {
      instrument: "SOL-USDT",
      exitPrice: "160.00",
    });
    assert.match(lesson, /Holding deadline expired on SOL\/USDT/);
    assert.match(adaptiveAction, /Reduced maximum target distances/);
  });

  test("derives a lesson from grid lower range stop breach", () => {
    const { lesson, adaptiveAction } = deriveLesson("range_stop", {
      instrument: "BNB-USDT",
      exitPrice: "520.00",
    });
    assert.match(lesson, /dropped through the lower range stop on BNB\/USDT/);
    assert.match(adaptiveAction, /require wider level spacing/);
  });

  test("dynamically widens DCA dip drop percentage after consecutive losses", () => {
    // 0 losses: unchanged
    assert.equal(calculateAdaptiveDipDrop("3.0", 0), "3.0");
    // 1 loss: 3 * (1 + 0.25) = 3.75
    assert.equal(calculateAdaptiveDipDrop("3.0", 1), "3.75");
    // 2 losses: 3 * (1 + 0.50) = 4.50
    assert.equal(calculateAdaptiveDipDrop("3.0", 2), "4.50");
  });

  test("dynamically scales down entry position sizes after consecutive losses", () => {
    assert.equal(calculateAdaptivePositionMultiplier(0), "1.0000");
    assert.equal(calculateAdaptivePositionMultiplier(1), "0.5000");
    assert.equal(calculateAdaptivePositionMultiplier(2), "0.2500");
    // Capped at 0.2500 min
    assert.equal(calculateAdaptivePositionMultiplier(3), "0.2500");
  });
});
