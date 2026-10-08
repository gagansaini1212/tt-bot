import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AiManagedRules } from "@crypto-trading/domain";
import {
  EveDecisionSource,
  parseEveHost,
  RECORDED_FIXTURE_MODEL,
  RecordedDecisionSource,
  STRATEGY_PROMPT_VERSION,
  type EveConnection,
  type AnalysisRequest,
} from "./ai-decisions";

const rules: AiManagedRules = {
  kind: "ai_managed",
  allowedInstruments: ["BTC-USDT", "ETH-USDT"],
  marketKind: "spot",
  allowShort: false,
  maxLeverage: 1,
  maxPositionNotional: "200",
  maxProtectedEntries: 3,
  holdingPeriodSeconds: 3_600,
  takeProfitAdjustable: false,
  lossLimits: { daily: "20", total: "50" },
};

const request = (sequence: number, available = "200"): AnalysisRequest => ({
  strategy: { id: "7b0b4a4e-38a8-4f39-8d1c-1d4b8f0a6c11", name: "AI", rules },
  markets: [
    {
      instrument: "BTC-USDT",
      lastPrice: "60000",
      bestAsk: "60000.01",
      tickSize: "0.01",
      stepSize: "0.00001",
      minNotional: "5",
    },
    {
      instrument: "ETH-USDT",
      lastPrice: "3000",
      bestAsk: "3000.01",
      tickSize: "0.01",
      stepSize: "0.0001",
      minNotional: "5",
    },
  ],
  entries: [],
  availableAllocation: available,
  now: new Date("2026-10-08T12:00:00Z"),
  sequence,
});

describe("recorded fixture decisions", () => {
  test("take turns, are priced from the market, sized within the limits and labelled", async () => {
    const source = new RecordedDecisionSource();
    assert.equal(source.source.kind, "fixture");
    const first = await source.decide(request(0));
    assert.equal(first.kind, "trade_proposal");
    assert.equal(first.model, RECORDED_FIXTURE_MODEL);
    assert.match(first.rationale, /^Recorded fixture, not an AI analysis:/);
    if (first.kind === "trade_proposal") {
      // 0.3% below 60,000; stop 1.5% and target 2% from there, on the tick;
      // 40% of the 200 USDT position limit.
      assert.deepEqual(
        {
          instrument: first.proposal.instrument,
          entry: first.proposal.entryPrice,
          stop: first.proposal.stopLossPrice,
          target: first.proposal.takeProfitPrice,
          quantity: first.proposal.quantity,
          expiry: first.proposal.entryExpiresAt,
        },
        {
          instrument: "BTC-USDT",
          entry: "59820",
          stop: "58922.7",
          target: "61016.4",
          quantity: "0.00133",
          expiry: "2026-10-08T13:00:00.000Z",
        },
      );
    }
    // The next decision, on the next instrument, is not to trade.
    const second = await source.decide(request(1));
    assert.equal(second.kind, "no_trade");
    if (second.kind === "no_trade") assert.equal(second.instrument, "ETH-USDT");
    // The same input, the same snapshot ID.
    assert.equal(
      (await source.decide(request(0))).sourceSnapshotId,
      first.sourceSnapshotId,
    );
  });

  test("decide not to trade when the allocation left is too small", async () => {
    const decision = await new RecordedDecisionSource().decide(request(0, "1"));
    assert.equal(decision.kind, "no_trade");
    assert.match(decision.rationale, /too little allocation/);
  });
});

describe("decisions from the eve assistant", () => {
  const connection = (data: unknown, status = "completed"): EveConnection => ({
    model: async () => "openai/gpt-6-luna",
    ask: async ({ message, clientContext, outputSchema }) => {
      assert.match(message, /Do not call any tool/);
      assert.equal(clientContext.kind, "strategy_analysis");
      assert.equal(outputSchema.type, "object");
      return { status, data };
    },
  });
  const trade = {
    decision: "trade",
    instrument: "ETH-USDT",
    quantity: "0.05",
    entryPrice: "2990",
    stopLossPrice: "2950",
    takeProfitPrice: "3050",
    entryExpiresAt: "2026-10-08T13:00:00Z",
    rationale: "Support at 2,990.",
  };

  test("are recorded with the model and the worker's prompt version", async () => {
    const source = new EveDecisionSource({
      host: "http://127.0.0.1:2000",
      connect: async () => connection(trade),
    });
    assert.equal(source.source.kind, "eve");
    const decision = await source.decide(request(0));
    assert.equal(decision.kind, "trade_proposal");
    assert.equal(decision.model, "openai/gpt-6-luna");
    assert.equal(decision.promptVersion, STRATEGY_PROMPT_VERSION);
    if (decision.kind === "trade_proposal")
      assert.equal(decision.proposal.entryPrice, "2990");
    const none = await new EveDecisionSource({
      host: "http://127.0.0.1:2000",
      connect: async () =>
        connection({
          ...trade,
          decision: "no_trade",
          quantity: null,
          entryPrice: null,
          stopLossPrice: null,
          takeProfitPrice: null,
          entryExpiresAt: null,
          rationale: "No edge.",
        }),
    }).decide(request(0));
    assert.equal(none.kind, "no_trade");
  });

  test("are refused outside the strategy's instruments, without prices, or unfinished", async () => {
    const decide = (data: unknown, status?: string) =>
      new EveDecisionSource({
        host: "http://127.0.0.1:2000",
        connect: async () => connection(data, status),
      }).decide({
        ...request(0),
        strategy: {
          ...request(0).strategy,
          rules: { ...rules, allowedInstruments: ["BTC-USDT"] },
        },
      });
    await assert.rejects(decide(trade), /outside the strategy's instruments/);
    await assert.rejects(
      decide({ ...trade, instrument: "BTC-USDT", stopLossPrice: "70000" }),
      /without valid prices/,
    );
    await assert.rejects(decide(trade, "failed"), /did not finish/);
    await assert.rejects(decide({ nonsense: true }), /not a decision/);
  });

  test("only reach an assistant on this machine", () => {
    assert.equal(
      parseEveHost("http://127.0.0.1:2000/"),
      "http://127.0.0.1:2000",
    );
    assert.equal(
      parseEveHost("http://localhost:3000/eve"),
      "http://localhost:3000/eve",
    );
    assert.equal(parseEveHost("https://example.com"), undefined);
    assert.equal(parseEveHost("http://10.0.0.2:2000"), undefined);
  });
});
