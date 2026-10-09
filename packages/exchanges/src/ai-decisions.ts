// Browser-safe: the execution worker records and reports AI decisions in
// these shapes, and the web app shows them.
import Decimal from "decimal.js";
import { z } from "zod";
import {
  instrumentSchema,
  marketKindSchema,
  protectionIsValid,
  tradeDirectionSchema,
} from "@crypto-trading/domain";
import { exitReasonSchema } from "./execution-state";
import { manualOrderOutcomeSchema } from "./manual-order";
import { listClientOrderIdSchema } from "./order-rules";

const decimal = z
  .string()
  .max(48)
  .regex(/^\d+(\.\d+)?$/);
const amount = decimal.max(32).refine((value) => /[1-9]/.test(value));
const timestamp = z.iso.datetime({ offset: true });

/**
 * A trade the assistant proposes on the Binance Spot Testnet account: a long
 * spot limit entry with its stop loss and take profit. It trades only if the
 * customer approves it and the execution checks pass.
 */
export const tradeProposalDraftSchema = z
  .strictObject({
    instrument: instrumentSchema,
    marketKind: z.literal("spot"),
    direction: z.literal("long"),
    quantity: amount,
    entryPrice: amount,
    stopLossPrice: amount,
    takeProfitPrice: amount,
    leverage: z.literal(1),
    // Approval is refused from this time on.
    entryExpiresAt: timestamp,
  })
  .refine(
    (proposal) =>
      protectionIsValid(
        proposal.direction,
        proposal.entryPrice,
        proposal.stopLossPrice,
        proposal.takeProfitPrice,
      ),
    "Spot entries are long only: the stop loss must be below the entry price and the take profit above it.",
  );
export type TradeProposalDraft = z.infer<typeof tradeProposalDraftSchema>;

const decisionFields = {
  // The model and prompt version that made the decision.
  model: z.string().trim().min(1).max(200),
  promptVersion: z.string().trim().min(1).max(100),
  // The account snapshot the decision was based on.
  sourceSnapshotId: z.uuid(),
  rationale: z.string().trim().min(1).max(2_000),
  // The assistant's tool call. Repeating it returns the decision it recorded.
  idempotencyKey: z.string().min(1).max(200),
};

/** What the assistant asks the execution worker to record. */
export const aiDecisionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("trade_proposal"),
    proposal: tradeProposalDraftSchema,
    ...decisionFields,
  }),
  z.strictObject({
    kind: z.literal("no_trade"),
    // The instrument the assistant decided not to trade, if one.
    instrument: instrumentSchema.nullable(),
    ...decisionFields,
  }),
]);
export type AiDecisionRequest = z.infer<typeof aiDecisionRequestSchema>;

/**
 * What the analysis assistant sends the worker to record. A trade proposal
 * names the one exchange account it trades on (ADR 0009). The worker checks
 * that the customer owns it, that it can trade, and that its own balances pay
 * for the entry: capital on another exchange account never does.
 */
export const assistantDecisionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("trade_proposal"),
    exchangeAccountId: z.uuid(),
    proposal: tradeProposalDraftSchema,
    ...decisionFields,
  }),
  aiDecisionRequestSchema.options[1],
]);
export type AssistantDecisionRequest = z.infer<
  typeof assistantDecisionRequestSchema
>;

/**
 * Where a proposal stands, as the customer sees it.
 * - draft: waiting for the customer, until its entry expiry.
 * - approved: approved and saved, but Binance has not confirmed the order.
 * - rejected: by the customer, by the execution checks, or by Binance.
 * - submitted: on Binance, not yet filled, or partly filled.
 * - filled: the entry filled, and the execution loop is watching or has
 *   closed the position.
 * - cancelled: the entry ended on Binance without filling, or was handed
 *   over to the customer, or Binance no longer knows it.
 * - expired: its entry expiry passed before anyone approved it.
 */
export const proposalStatusSchema = z.enum([
  "draft",
  "approved",
  "rejected",
  "submitted",
  "filled",
  "cancelled",
  "expired",
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

/** What Binance last reported for one order of a protected entry. */
const orderLegSchema = z.object({
  // Binance's order ID, as the fills table shows it.
  orderId: z.string().max(40).nullable(),
  status: z.string().max(40),
  filledQuantity: decimal,
  averageFillPrice: decimal.nullable(),
});
export type ProposalOrderLeg = z.infer<typeof orderLegSchema>;

/**
 * The execution loop's latest finding for a protected entry, from
 * entry_reconciliations. The states are the worker's EntryState.
 */
const entryReconciliationSchema = z.object({
  state: z.enum([
    "working",
    "partly_filled",
    "awaiting_exits",
    "protected",
    "unprotected",
    "exiting",
    "closed",
    "not_filled",
    "handed_over",
    "missing",
  ]),
  filledQuantity: decimal,
  heldQuantity: decimal,
  exitReason: exitReasonSchema.nullable(),
  // The worker stopped trying to sell what it holds. The customer must act.
  closeBlocked: z.boolean(),
  detail: z.string().max(500),
  checkedAt: timestamp,
});
export type EntryReconciliation = z.infer<typeof entryReconciliationSchema>;

export const proposalViewSchema = z.object({
  id: z.uuid(),
  instrument: z.string().max(40),
  marketKind: marketKindSchema,
  direction: tradeDirectionSchema,
  quantity: decimal,
  entryPrice: decimal,
  stopLossPrice: decimal,
  takeProfitPrice: decimal,
  leverage: z.int().positive(),
  entryExpiresAt: timestamp,
  // Null for a proposal the assistant drafted in conversation.
  strategyId: z.uuid().nullable(),
  strategyVersion: z.int().positive().nullable(),
  status: proposalStatusSchema,
  decidedAt: timestamp.nullable(),
  decidedBy: z.enum(["customer", "execution_checks", "expiry"]).nullable(),
  decisionReason: z.string().max(1_000).nullable(),
  // The order list an approval placed, as last saved.
  order: z
    .object({
      listClientOrderId: listClientOrderIdSchema,
      intentStatus: z.string().max(40),
      entry: orderLegSchema.nullable(),
      takeProfit: orderLegSchema.nullable(),
      stopLoss: orderLegSchema.nullable(),
      // Null until the execution loop has checked the entry.
      reconciliation: entryReconciliationSchema.nullable(),
      checkedAt: timestamp.nullable(),
    })
    .nullable(),
});
export type ProposalView = z.infer<typeof proposalViewSchema>;

export const decisionViewSchema = z.object({
  // Null for a strategy's proposal that has no recorded AI decision.
  id: z.uuid().nullable(),
  kind: z.enum(["trade_proposal", "no_trade"]),
  createdAt: timestamp,
  instrument: z.string().max(40).nullable(),
  model: z.string().max(200).nullable(),
  promptVersion: z.string().max(100).nullable(),
  sourceSnapshotId: z.uuid().nullable(),
  rationale: z.string().max(2_000),
  proposal: proposalViewSchema.nullable(),
});
export type DecisionView = z.infer<typeof decisionViewSchema>;

/** The answer to an approval, with the proposal as it now is. */
export const proposalApprovalSchema = z.object({
  outcome: manualOrderOutcomeSchema,
  proposal: proposalViewSchema.nullable(),
});
export type ProposalApproval = z.infer<typeof proposalApprovalSchema>;

export const rejectProposalRequestSchema = z.strictObject({
  proposalId: z.uuid(),
  // The customer's reason, if they gave one.
  reason: z.string().trim().max(500).optional(),
});

/** The answer to a rejection, with the proposal as it now is. */
export const proposalRejectionSchema = z.object({
  rejected: z.boolean(),
  message: z.string().max(500),
  proposal: proposalViewSchema.nullable(),
});
export type ProposalRejection = z.infer<typeof proposalRejectionSchema>;

/** Size, risk and reward of a long entry, in the quote currency. */
export function proposalRisk(proposal: {
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
}) {
  const entry = new Decimal(proposal.entryPrice);
  const risk = entry.minus(proposal.stopLossPrice);
  const reward = new Decimal(proposal.takeProfitPrice).minus(entry);
  const percent = (price: string) =>
    new Decimal(price).minus(entry).dividedBy(entry).times(100);
  return {
    notional: entry.times(proposal.quantity).toFixed(),
    stopLossPercent: percent(proposal.stopLossPrice).toFixed(),
    takeProfitPercent: percent(proposal.takeProfitPrice).toFixed(),
    // Reward per unit of risk: 2 means 1 : 2. Null without a risk.
    rewardPerRisk: risk.greaterThan(0)
      ? reward.dividedBy(risk).toFixed()
      : null,
  };
}
