import { defineTool } from "eve/tools";
import { z } from "zod";
import { customerIdFrom } from "../lib/customer-principal";

const positiveDecimalString = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
  .refine((value) => Number(value) > 0, "Must be greater than zero");

export default defineTool({
  description:
    "Draft a typed trade proposal for later independent checks. This does not place an order or reserve funds.",
  inputSchema: z.object({
    strategyId: z.uuid(),
    strategyVersion: z.int().positive(),
    sourceSnapshotId: z.uuid(),
    instrument: z.enum(["BTC-USDT", "ETH-USDT"]),
    marketKind: z.enum(["spot", "perpetual"]),
    direction: z.enum(["long", "short"]),
    quantity: positiveDecimalString,
    entryPrice: positiveDecimalString,
    entryExpiresAt: z.iso.datetime(),
    stopLossPrice: positiveDecimalString,
    takeProfitPrice: positiveDecimalString,
    leverage: z.int().positive().default(1),
    rationale: z.string().trim().min(1).max(2_000),
  }),
  execute(input, ctx) {
    return {
      ...input,
      customerId: customerIdFrom(ctx.session.auth),
      status: "draft" as const,
      notice: "Independent execution checks are still required.",
    };
  },
});
