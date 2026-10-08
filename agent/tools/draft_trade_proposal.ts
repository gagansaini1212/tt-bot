import { defineTool } from "eve/tools";
import { z } from "zod";

import { customerIdFrom } from "../lib/customer-principal";
import { recordDecision } from "../lib/decisions";

const positiveDecimalString = z
  .string()
  .max(32)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
  .refine((value) => Number(value) > 0, "Must be greater than zero");

export default defineTool({
  description:
    "Draft a trade proposal for the customer to approve or reject. It is saved as a draft and shown on the Activity page. This does not place an order or reserve funds: the execution worker checks it again, with current account data and the customer's limits, only if the customer approves it.",
  inputSchema: z.object({
    instrument: z.enum(["BTC-USDT", "ETH-USDT"]),
    // Binance Spot Testnet takes long, unleveraged spot entries only.
    marketKind: z.literal("spot").default("spot"),
    direction: z.literal("long").default("long"),
    quantity: positiveDecimalString.describe(
      "Base asset quantity, such as 0.001 BTC.",
    ),
    entryPrice: positiveDecimalString.describe(
      "Limit price of the entry, in USDT.",
    ),
    entryExpiresAt: z.iso
      .datetime({ offset: true })
      .describe(
        "When the proposal can no longer be approved. Must be in the future.",
      ),
    stopLossPrice: positiveDecimalString.describe(
      "Below the entry price, in USDT.",
    ),
    takeProfitPrice: positiveDecimalString.describe(
      "Above the entry price, in USDT.",
    ),
    leverage: z.literal(1).default(1),
    sourceSnapshotId: z
      .uuid()
      .describe(
        "The snapshotId of the accountSnapshot in client context that this proposal is based on.",
      ),
    rationale: z.string().trim().min(1).max(2_000),
  }),
  async execute(input, ctx) {
    const { sourceSnapshotId, rationale, ...proposal } = input;
    const saved = await recordDecision(
      customerIdFrom(ctx.session.auth),
      { sessionId: ctx.session.id, callId: ctx.callId },
      { kind: "trade_proposal", proposal, sourceSnapshotId, rationale },
    );
    return saved.recorded
      ? {
          ...input,
          proposalId: saved.proposalId,
          status: "draft" as const,
          notice:
            "Saved as a draft for the customer to approve or reject. Independent execution checks run again before anything is sent.",
        }
      : {
          ...input,
          proposalId: null,
          status: "not_saved" as const,
          notice: `Not saved, so it cannot be approved. ${saved.reason}`,
        };
  },
});
