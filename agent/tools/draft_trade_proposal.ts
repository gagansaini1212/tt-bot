import type { SessionAuthContext } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

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
      customerId: customerIdFor(ctx.session.auth.current),
      status: "draft" as const,
      notice: "Independent execution checks are still required.",
    };
  },
});

/**
 * Resolves the customer from the caller's route-auth principal. Customer
 * sign-in does not exist yet, so the only accepted caller is eve's `localDev()`
 * principal, which eve issues only while the process is a local development
 * server; it stands in for the local customer. Every other route-auth caller is
 * rejected, including Vercel OIDC `user` principals, which identify Vercel team
 * members and connected accounts rather than customers. Accept the customer
 * authenticator here when customer sign-in is added.
 */
function customerIdFor(caller: SessionAuthContext | null): string {
  if (
    caller?.authenticator === "local-dev" &&
    caller.principalType === "local-dev"
  ) {
    return caller.principalId;
  }

  throw new Error(
    caller
      ? `An authenticated customer is required to draft a proposal. The caller authenticated through "${caller.authenticator}" as "${caller.principalType}", which does not identify a customer.`
      : "An authenticated customer is required to draft a proposal.",
  );
}
