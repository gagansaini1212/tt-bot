import "server-only";
import {
  decisionViewSchema,
  proposalApprovalSchema,
  proposalRejectionSchema,
  proposalViewSchema,
  type DecisionView,
  type ProposalApproval,
  type ProposalRejection,
  type ProposalView,
} from "@crypto-trading/exchanges/ai-decisions";
import { z } from "zod";
import {
  callWorkerForCustomer,
  type WorkerFailure,
  type WorkerState,
} from "./worker-client";

export type DecisionHistoryState = WorkerState<{
  decisions: DecisionView[];
  // When the worker read them, on its clock, for measuring their ages.
  readAt: number;
}>;

/** The customer's latest AI decisions, newest first, with their proposals. */
export async function getDecisionHistory(): Promise<DecisionHistoryState> {
  const result = await callWorkerForCustomer({
    path: "/decisions",
    schema: z.object({ decisions: z.array(decisionViewSchema) }),
  });
  return result.status === "connected"
    ? {
        status: "connected",
        decisions: result.data.decisions,
        readAt: Date.parse(result.date ?? "") || Date.now(),
      }
    : { status: result.status, message: result.message };
}

/** The proposal as it now is; null if there is none, or it cannot be read. */
export async function getProposal(
  proposalId: string,
): Promise<ProposalView | null> {
  const result = await callWorkerForCustomer({
    path: "/proposals",
    query: { proposalId },
    schema: z.object({ proposal: proposalViewSchema.nullable() }),
  });
  return result.status === "connected" ? result.data.proposal : null;
}

// A missing token or URL, no signed-in customer, a worker that could not act
// for this customer or a refused body mean the request never took effect.
// After any other failure it may have.
const NOT_SENT = new Set<WorkerFailure["reason"]>([
  "missing_token",
  "invalid_url",
  "signed_out",
  "worker_not_configured",
  "no_exchange_account",
  "database_unavailable",
  "invalid_request",
]);

/**
 * Asks the worker to approve a proposal and place its order. The worker runs
 * every check again, and sends a proposal at most once, so approving again
 * after an unconfirmed answer cannot place a second order.
 */
export async function submitApproval(
  proposalId: string,
): Promise<ProposalApproval> {
  const result = await callWorkerForCustomer({
    method: "POST",
    path: "/proposals/approve",
    body: { proposalId },
    schema: proposalApprovalSchema,
  });
  if (result.status === "connected") return result.data;
  return {
    outcome: NOT_SENT.has(result.reason)
      ? { status: "rejected", message: result.message }
      : {
          status: "unknown",
          message:
            "The execution worker did not confirm the approval, so its order may or may not have been placed. Check the proposal on the Activity page. It is never sent twice.",
        },
    proposal: null,
  };
}

export async function submitRejection(
  proposalId: string,
  reason: string | undefined,
): Promise<ProposalRejection> {
  const result = await callWorkerForCustomer({
    method: "POST",
    path: "/proposals/reject",
    body: { proposalId, reason },
    schema: proposalRejectionSchema,
  });
  if (result.status === "connected") return result.data;
  return {
    rejected: false,
    message: NOT_SENT.has(result.reason)
      ? result.message
      : "The execution worker did not confirm the rejection. Refresh to see the proposal's status.",
    proposal: null,
  };
}
