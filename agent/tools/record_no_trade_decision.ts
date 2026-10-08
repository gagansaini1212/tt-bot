import { defineTool } from "eve/tools";
import { z } from "zod";

import { customerIdFrom } from "../lib/customer-principal";
import { recordDecision } from "../lib/decisions";

export default defineTool({
  description:
    "Record a decision not to trade, with its rationale, when your analysis of whether to trade concludes that no trade is warranted. It is shown on the Activity page.",
  inputSchema: z.object({
    instrument: z
      .enum(["BTC-USDT", "ETH-USDT"])
      .optional()
      .describe("The instrument you decided not to trade, if one."),
    sourceSnapshotId: z
      .uuid()
      .describe(
        "The snapshotId of the accountSnapshot in client context that this decision is based on.",
      ),
    rationale: z.string().trim().min(1).max(2_000),
  }),
  async execute(input, ctx) {
    const saved = await recordDecision(
      customerIdFrom(ctx.session.auth),
      { sessionId: ctx.session.id, callId: ctx.callId },
      {
        kind: "no_trade",
        instrument: input.instrument ?? null,
        sourceSnapshotId: input.sourceSnapshotId,
        rationale: input.rationale,
      },
    );
    return {
      ...input,
      decision: "no_trade" as const,
      recorded: saved.recorded,
      notice: saved.recorded
        ? "Recorded on the Activity page."
        : `Not recorded. ${saved.reason}`,
    };
  },
});
