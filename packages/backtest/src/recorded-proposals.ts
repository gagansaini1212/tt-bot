import Decimal from "decimal.js";
import { z } from "zod";

import {
  aiManagedRulesSchema,
  instrumentSchema,
  marketKindSchema,
  positiveDecimalString,
  tradeDirectionSchema,
} from "@crypto-trading/domain";

import sampleFixture from "./fixtures/sample-ai-proposals.json" with { type: "json" };

/**
 * A trade proposal as the assistant's draft_trade_proposal tool records it,
 * with the time it was made. Replaying it submits it at the first candle open
 * at or after `at`, through the same execution checks as a live proposal.
 */
export const recordedProposalSchema = z.strictObject({
  at: z.iso.datetime(),
  instrument: instrumentSchema,
  marketKind: marketKindSchema,
  direction: tradeDirectionSchema,
  quantity: positiveDecimalString,
  entryPrice: positiveDecimalString,
  stopLossPrice: positiveDecimalString,
  takeProfitPrice: positiveDecimalString,
  leverage: z.int().positive(),
  entryExpiresAt: z.iso.datetime(),
  rationale: z.string().trim().min(1).max(2_000),
});

export type RecordedProposal = z.infer<typeof recordedProposalSchema>;

const utcDate = z.iso.date();

/**
 * Recorded proposals for an AI-managed strategy over a fixed period. A replay
 * shows how the execution checks and the simulator treat these decisions. It
 * is a fixture, not a measure of how the AI trades.
 */
export const recordedProposalFixtureSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    title: z.string().trim().min(1).max(120),
    // Where the proposals came from, shown with every result.
    provenance: z.string().trim().min(1).max(500),
    instrument: instrumentSchema,
    // Inclusive UTC dates.
    period: z.strictObject({ start: utcDate, end: utcDate }),
    allocation: positiveDecimalString,
    rules: aiManagedRulesSchema,
    proposals: z.array(recordedProposalSchema).min(1).max(500),
  })
  .refine(
    (fixture) =>
      fixture.period.start <= fixture.period.end &&
      fixture.proposals.every(
        (proposal, index) =>
          index === 0 ||
          Date.parse(proposal.at) >=
            Date.parse(fixture.proposals[index - 1].at),
      ),
    "The period must not end before it starts, and proposals must be in time order.",
  )
  .refine(
    (fixture) =>
      !new Decimal(fixture.rules.maxPositionNotional).greaterThan(
        fixture.allocation,
      ),
    "The position limit must fit the allocation.",
  )
  .refine(
    (fixture) =>
      fixture.proposals.every(
        (proposal) => proposal.instrument === fixture.instrument,
      ),
    "Every proposal must be for the fixture's market.",
  );

export type RecordedProposalFixture = z.infer<
  typeof recordedProposalFixtureSchema
>;

/** Every recorded-proposal fixture a backtest can replay. */
export const RECORDED_PROPOSAL_FIXTURES: readonly RecordedProposalFixture[] = [
  recordedProposalFixtureSchema.parse(sampleFixture),
];

export function recordedProposalFixture(id: string) {
  return RECORDED_PROPOSAL_FIXTURES.find((fixture) => fixture.id === id);
}
