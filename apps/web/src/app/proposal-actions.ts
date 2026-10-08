"use server";

import { refresh } from "next/cache";
import {
  rejectProposalRequestSchema,
  type ProposalApproval,
  type ProposalRejection,
  type ProposalView,
} from "@crypto-trading/exchanges/ai-decisions";
import { z } from "zod";

import { getCurrentCustomer } from "@/lib/current-customer";
import { getProposal, submitApproval, submitRejection } from "@/lib/decisions";
import { isLocalRequest } from "@/lib/local-request";

// Approving places an order on the connected testnet account, so these
// actions refuse any request that is not from this machine, like the order
// actions. The worker checks every approval again.
const REFUSED =
  "Proposals can only be approved or rejected from the dashboard on this machine.";
const SIGNED_OUT = "Sign in to approve or reject proposals.";
const proposalIdSchema = z.uuid();

export async function loadProposal(
  input: unknown,
): Promise<ProposalView | null> {
  const id = proposalIdSchema.safeParse(input);
  if (!id.success || !(await isLocalRequest())) return null;
  return getProposal(id.data);
}

export async function approveProposal(
  input: unknown,
): Promise<ProposalApproval> {
  if (!(await isLocalRequest()))
    return {
      outcome: { status: "rejected", message: REFUSED },
      proposal: null,
    };
  const id = proposalIdSchema.safeParse(input);
  if (!id.success)
    return {
      outcome: { status: "invalid", message: "The proposal ID is invalid." },
      proposal: null,
    };
  if (!(await getCurrentCustomer()))
    return {
      outcome: { status: "rejected", message: SIGNED_OUT },
      proposal: null,
    };
  const approval = await submitApproval(id.data);
  refresh();
  return approval;
}

export async function rejectProposal(
  input: unknown,
): Promise<ProposalRejection> {
  if (!(await isLocalRequest()))
    return { rejected: false, message: REFUSED, proposal: null };
  const request = rejectProposalRequestSchema.safeParse(input);
  if (!request.success)
    return {
      rejected: false,
      message: "Give a reason of at most 500 characters, or none.",
      proposal: null,
    };
  if (!(await getCurrentCustomer()))
    return { rejected: false, message: SIGNED_OUT, proposal: null };
  const rejection = await submitRejection(
    request.data.proposalId,
    request.data.reason || undefined,
  );
  refresh();
  return rejection;
}
