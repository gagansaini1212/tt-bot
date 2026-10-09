// Where an AI-managed strategy's decisions come from: the eve analysis
// assistant, or, with no model configured, a recorded fixture that is
// labelled as one on every decision it makes.
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import {
  ceilToStep,
  floorToStep,
  protectionIsValid,
  quantityFor,
  type AiManagedRules,
  type Instrument,
  instrumentSchema,
} from "@crypto-trading/domain";
import {
  RECORDED_FIXTURE_MODEL,
  tradeProposalDraftSchema,
  type AiDecisionRequest,
  type AiSource,
} from "@crypto-trading/exchanges";
import recordedDecisions from "./recorded-decisions.json" with { type: "json" };

/** A market an AI-managed strategy may trade, as the worker read it. */
export type AnalysisMarket = {
  instrument: Instrument;
  lastPrice: string;
  bestAsk: string | null;
  tickSize: string;
  stepSize: string;
  minNotional: string;
};

/** What the worker gives the AI for one scheduled analysis. */
export type AnalysisRequest = {
  strategy: { id: string; name: string; rules: AiManagedRules };
  markets: AnalysisMarket[];
  // What the strategy holds now, pending or open.
  entries: {
    instrument: Instrument;
    quantity: string;
    entryPrice: string;
  }[];
  // The allocation it has not committed or reserved.
  availableAllocation: string;
  now: Date;
  // How many decisions it has made before, so a fixture takes its turn.
  sequence: number;
};

/** A decision to record, without its idempotency key. */
export type AnalysisDecision = AiDecisionRequest extends infer Request
  ? Request extends AiDecisionRequest
    ? Omit<Request, "idempotencyKey">
    : never
  : never;

export interface DecisionSource {
  readonly source: AiSource;
  decide(request: AnalysisRequest): Promise<AnalysisDecision>;
}

export { RECORDED_FIXTURE_MODEL };

const percent = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((value) => new Decimal(value).gt(0) && new Decimal(value).lt(100));
const recordedDecisionsSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  title: z.string().min(1).max(120),
  provenance: z.string().min(1).max(500),
  decisions: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("trade_proposal"),
          // How far below the last price the entry rests.
          entryBelowPercent: percent,
          stopLossPercent: percent,
          takeProfitPercent: percent,
          // Of the strategy's position limit.
          positionPercent: percent,
          expiresAfterMinutes: z
            .int()
            .min(1)
            .max(24 * 60),
          rationale: z.string().min(1).max(500),
        }),
        z.strictObject({
          kind: z.literal("no_trade"),
          rationale: z.string().min(1).max(500),
        }),
      ]),
    )
    .min(1),
});
export type RecordedDecisions = z.infer<typeof recordedDecisionsSchema>;

export const RECORDED_DECISIONS =
  recordedDecisionsSchema.parse(recordedDecisions);

/**
 * A stable ID for exactly this content, shaped as a UUID, so a decision can
 * name the market snapshot it was based on.
 */
export function contentId(content: unknown): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The input a decision was based on, by its content. */
function snapshotId(request: AnalysisRequest) {
  return contentId({
    strategyId: request.strategy.id,
    markets: request.markets,
    entries: request.entries,
    availableAllocation: request.availableAllocation,
    at: request.now.toISOString(),
  });
}

const FIXTURE_LABEL = "Recorded fixture, not an AI analysis:";

/**
 * Replays recorded decisions in turn, each priced from the market when it is
 * made and sized within the strategy's position limit. Every decision is
 * recorded with the model `recorded-fixture` and says it is a fixture.
 */
export class RecordedDecisionSource implements DecisionSource {
  readonly #fixture: RecordedDecisions;
  readonly source: AiSource;

  constructor(fixture: RecordedDecisions = RECORDED_DECISIONS) {
    this.#fixture = fixture;
    this.source = {
      kind: "fixture",
      description: `No model is configured, so AI-managed strategies replay "${fixture.title}". ${fixture.provenance}`,
    };
  }

  async decide(request: AnalysisRequest): Promise<AnalysisDecision> {
    const { decisions } = this.#fixture;
    const step = decisions[request.sequence % decisions.length];
    const instruments = request.strategy.rules.allowedInstruments;
    const instrument = instruments[request.sequence % instruments.length];
    const common = {
      model: RECORDED_FIXTURE_MODEL,
      promptVersion: this.#fixture.id,
      sourceSnapshotId: snapshotId(request),
    };
    const noTrade = (why: string): AnalysisDecision => ({
      kind: "no_trade",
      instrument: instrumentSchema.safeParse(instrument).data ?? null,
      ...common,
      rationale: `${FIXTURE_LABEL} ${why}`,
    });
    if (step.kind === "no_trade") return noTrade(step.rationale);
    const market = request.markets.find(
      (entry) => entry.instrument === instrument,
    );
    if (!market) return noTrade(`There is no current price for ${instrument}.`);
    const fraction = (value: string) => new Decimal(value).dividedBy(100);
    const entry = floorToStep(
      new Decimal(market.lastPrice).times(
        new Decimal(1).minus(fraction(step.entryBelowPercent)),
      ),
      market.tickSize,
    );
    const stopLoss = ceilToStep(
      entry.times(new Decimal(1).minus(fraction(step.stopLossPercent))),
      market.tickSize,
    );
    const takeProfit = ceilToStep(
      entry.times(new Decimal(1).plus(fraction(step.takeProfitPercent))),
      market.tickSize,
    );
    const notional = Decimal.min(
      new Decimal(request.strategy.rules.maxPositionNotional).times(
        fraction(step.positionPercent),
      ),
      request.availableAllocation,
    );
    const quantity = quantityFor(
      Decimal.max(notional, 0),
      entry,
      market.stepSize,
    );
    if (
      quantity.isZero() ||
      quantity.times(entry).lt(market.minNotional) ||
      !protectionIsValid("long", entry, stopLoss, takeProfit)
    )
      return noTrade(
        `${step.rationale} The strategy has too little allocation left for an entry Binance would take.`,
      );
    return {
      kind: "trade_proposal",
      proposal: tradeProposalDraftSchema.parse({
        instrument,
        marketKind: "spot",
        direction: "long",
        quantity: quantity.toFixed(),
        entryPrice: entry.toFixed(),
        stopLossPrice: stopLoss.toFixed(),
        takeProfitPrice: takeProfit.toFixed(),
        leverage: 1,
        entryExpiresAt: new Date(
          request.now.getTime() + step.expiresAfterMinutes * 60_000,
        ).toISOString(),
      }),
      ...common,
      rationale: `${FIXTURE_LABEL} ${step.rationale}`,
    };
  }
}

/** The structured answer the worker asks the assistant for. */
const decisionOutputSchema = z.object({
  decision: z.enum(["trade", "no_trade"]),
  instrument: instrumentSchema.nullable(),
  quantity: z.string().nullable(),
  entryPrice: z.string().nullable(),
  stopLossPrice: z.string().nullable(),
  takeProfitPrice: z.string().nullable(),
  entryExpiresAt: z.string().nullable(),
  rationale: z.string().trim().min(1).max(2_000),
});

// The same, as the JSON Schema eve hands the model, which may name only
// the markets it is offered.
const decisionOutputJsonSchema = (instruments: readonly Instrument[]) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["trade", "no_trade"] },
    instrument: {
      type: ["string", "null"],
      enum: [...instruments, null],
    },
    quantity: { type: ["string", "null"] },
    entryPrice: { type: ["string", "null"] },
    stopLossPrice: { type: ["string", "null"] },
    takeProfitPrice: { type: ["string", "null"] },
    entryExpiresAt: { type: ["string", "null"] },
    rationale: { type: "string" },
  },
  required: [
    "decision",
    "instrument",
    "quantity",
    "entryPrice",
    "stopLossPrice",
    "takeProfitPrice",
    "entryExpiresAt",
    "rationale",
  ],
});

/**
 * The version of the scheduled-analysis prompt below, recorded with every
 * decision the assistant makes for a strategy. Change it whenever the prompt
 * or the output schema changes.
 */
export const STRATEGY_PROMPT_VERSION = "strategy-analysis-2026-10-08.1";

/** What eve's client does for one analysis; replaced in tests. */
export type EveConnection = {
  model(): Promise<string>;
  ask(input: {
    message: string;
    clientContext: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  }): Promise<{ status: string; data: unknown }>;
};

/** Connects to the eve assistant at `host` with eve's own client. */
export async function connectEve(host: string): Promise<EveConnection> {
  const { Client } = await import("eve/client");
  const client = new Client({ host, redirect: "error" });
  return {
    async model() {
      const info = await client.info({ signal: AbortSignal.timeout(10_000) });
      return info.agent.model.id ?? "eve";
    },
    async ask({ message, clientContext, outputSchema }) {
      const { response } = await client.sessions.create({
        message,
        clientContext: clientContext as never,
        outputSchema: outputSchema as never,
        signal: AbortSignal.timeout(120_000),
      });
      const result = await response.result();
      return { status: result.status, data: result.data };
    },
  };
}

// The assistant's address must stay on this machine.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `value` as an eve host on this machine, or undefined. */
export function parseEveHost(value: string): string | undefined {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  return url.toString().replace(/\/$/, "");
}

/**
 * Asks the eve analysis assistant for a decision, as a structured answer the
 * worker records itself: the assistant's tools act only for a signed-in
 * customer in their own conversation, and this is the worker's analysis.
 * Throws if the assistant cannot answer; nothing is recorded then.
 */
export class EveDecisionSource implements DecisionSource {
  readonly source: AiSource;
  readonly #connect: () => Promise<EveConnection>;
  #connection?: Promise<EveConnection>;

  constructor({
    host,
    connect = () => connectEve(host),
  }: {
    host: string;
    connect?: () => Promise<EveConnection>;
  }) {
    this.#connect = connect;
    this.source = {
      kind: "eve",
      description: `AI-managed strategies ask the eve analysis assistant at ${host} on their schedule.`,
    };
  }

  async decide(request: AnalysisRequest): Promise<AnalysisDecision> {
    this.#connection ??= this.#connect().catch((error: unknown) => {
      this.#connection = undefined;
      throw error;
    });
    const eve = await this.#connection;
    const [model, answer] = await Promise.all([
      eve.model(),
      eve.ask({
        message: analysisPrompt(request),
        clientContext: {
          kind: "strategy_analysis",
          strategy: {
            name: request.strategy.name,
            rules: request.strategy.rules,
          },
          markets: request.markets,
          entries: request.entries,
          availableAllocation: request.availableAllocation,
          capturedAt: request.now.toISOString(),
        },
        outputSchema: decisionOutputJsonSchema(
          request.markets.map((market) => market.instrument),
        ),
      }),
    ]);
    if (answer.status !== "completed")
      throw new Error("The analysis assistant did not finish its analysis.");
    const output = decisionOutputSchema.safeParse(answer.data);
    if (!output.success)
      throw new Error("The analysis assistant's answer was not a decision.");
    const common = {
      model: model.slice(0, 200),
      promptVersion: STRATEGY_PROMPT_VERSION,
      sourceSnapshotId: snapshotId(request),
      rationale: output.data.rationale,
    };
    const { data } = output;
    if (data.decision === "no_trade")
      return { kind: "no_trade", instrument: data.instrument, ...common };
    // Checked again, with the strategy's limits, before it can trade.
    const proposal = tradeProposalDraftSchema.safeParse({
      instrument: data.instrument,
      marketKind: "spot",
      direction: "long",
      quantity: data.quantity,
      entryPrice: data.entryPrice,
      stopLossPrice: data.stopLossPrice,
      takeProfitPrice: data.takeProfitPrice,
      leverage: 1,
      entryExpiresAt: data.entryExpiresAt,
    });
    if (
      !proposal.success ||
      !request.strategy.rules.allowedInstruments.includes(
        proposal.data.instrument,
      ) ||
      !request.markets.some(
        (market) => market.instrument === proposal.data.instrument,
      )
    )
      throw new Error(
        "The analysis assistant proposed a trade outside the strategy's instruments, or without valid prices.",
      );
    return { kind: "trade_proposal", proposal: proposal.data, ...common };
  }
}

function analysisPrompt(request: AnalysisRequest) {
  const { rules } = request.strategy;
  return [
    `Scheduled analysis for the AI-managed strategy "${request.strategy.name}". Do not call any tool: answer with the structured decision only. The execution worker records it and checks it against the strategy's limits.`,
    `Decide whether to open one long spot limit entry now in ${request.markets.map((market) => market.instrument).join(" or ")}, or not to trade. A trade needs a quantity, an entry price, a stop loss below it, a take profit above it, and an entry expiry in the future (ISO 8601).`,
    `Limits: positions up to ${rules.maxPositionNotional} USDT per instrument, at most ${rules.maxProtectedEntries} entries at once, ${request.availableAllocation} USDT of the allocation uncommitted, each entry held at most ${Math.round(rules.holdingPeriodSeconds / 60)} minutes. The market data and the strategy's entries are in the client context, captured at ${request.now.toISOString()}. A no-trade decision is valid.`,
  ].join("\n\n");
}
