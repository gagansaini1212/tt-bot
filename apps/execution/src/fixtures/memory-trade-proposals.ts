import { randomUUID } from "node:crypto";
import {
  protectedLegIds,
  type AiDecisionRequest,
  type DecisionView,
  type ProposalView,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "../accounts";
import { clientOrderIdOf, type ManualOrder } from "../order-intents";
import {
  proposalStatus,
  type ProposalRefusal,
  type SavedProposal,
  type TradeProposalStore,
} from "../trade-proposals";
import type { MemoryOrderIntents } from "./memory-order-intents";

type Decision = Omit<DecisionView, "proposal"> & {
  scope: AccountScope;
  idempotencyKey: string;
  proposalId: string | null;
};

type Proposal = SavedProposal & {
  decidedAt: Date | null;
  decidedBy: ProposalView["decidedBy"];
  decisionReason: string | null;
  clientOrderId: string | null;
};

/**
 * An in-memory TradeProposalStore whose approvals save their order intents in
 * `intents`. trade-proposals.test.ts proves the PostgreSQL store behaves the
 * same way.
 */
export class MemoryTradeProposals implements TradeProposalStore {
  readonly decisionList: Decision[] = [];
  readonly proposals = new Map<string, Proposal>();

  constructor(readonly intents: MemoryOrderIntents) {}

  async record(scope: AccountScope, request: AiDecisionRequest, now: Date) {
    let decision = this.decisionList.find(
      (entry) => entry.idempotencyKey === request.idempotencyKey,
    );
    if (decision && decision.scope.customerId !== scope.customerId)
      throw new Error("The idempotency key belongs to another customer.");
    if (!decision) {
      let proposalId: string | null = null;
      if (request.kind === "trade_proposal") {
        proposalId = randomUUID();
        this.proposals.set(proposalId, {
          ...request.proposal,
          id: proposalId,
          customerId: scope.customerId,
          exchangeAccountId: scope.exchangeAccountId,
          strategyId: null,
          strategyVersion: null,
          sourceSnapshotId: request.sourceSnapshotId,
          entryExpiresAt: new Date(request.proposal.entryExpiresAt),
          rationale: request.rationale,
          status: "draft",
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          clientOrderId: null,
        });
      }
      decision = {
        scope,
        idempotencyKey: request.idempotencyKey,
        proposalId,
        id: randomUUID(),
        kind: request.kind,
        createdAt: now.toISOString(),
        instrument:
          request.kind === "no_trade"
            ? request.instrument
            : request.proposal.instrument,
        model: request.model,
        promptVersion: request.promptVersion,
        sourceSnapshotId: request.sourceSnapshotId,
        rationale: request.rationale,
      };
      this.decisionList.push(decision);
    }
    return this.#decisionView(decision, now);
  }

  async decisions(scope: AccountScope, now: Date, limit: number) {
    return this.decisionList
      .filter((decision) => this.#mine(scope, decision.scope))
      .toReversed()
      .slice(0, limit)
      .map((decision) => this.#decisionView(decision, now));
  }

  async view(scope: AccountScope, proposalId: string, now: Date) {
    const proposal = this.#owned(scope, proposalId);
    return proposal ? this.#proposalView(proposal, now) : undefined;
  }

  async find(scope: AccountScope, proposalId: string) {
    const proposal = this.#owned(scope, proposalId);
    if (!proposal) return undefined;
    const {
      decidedAt: _at,
      decidedBy: _by,
      decisionReason: _reason,
      clientOrderId: _id,
      ...saved
    } = proposal;
    return structuredClone(saved);
  }

  async reject(
    scope: AccountScope,
    proposalId: string,
    refusal: ProposalRefusal,
    now: Date,
  ) {
    const proposal = this.#owned(scope, proposalId);
    if (proposal?.status !== "draft" || proposal.strategyId !== null)
      return false;
    Object.assign(proposal, {
      status: "rejected",
      decidedAt: now,
      decidedBy: refusal.by,
      decisionReason: refusal.reason || null,
    });
    return true;
  }

  async expire(scope: AccountScope, proposalId: string, now: Date) {
    const proposal = this.#owned(scope, proposalId);
    if (
      proposal?.status !== "draft" ||
      proposal.entryExpiresAt.getTime() > now.getTime()
    )
      return false;
    Object.assign(proposal, {
      status: "expired",
      decidedAt: now,
      decidedBy: "expiry",
    });
    return true;
  }

  async approve(
    scope: AccountScope,
    proposalId: string,
    order: ManualOrder,
    now: Date,
  ) {
    const proposal = this.#owned(scope, proposalId);
    if (
      proposal?.status !== "draft" ||
      proposal.strategyId !== null ||
      proposal.entryExpiresAt.getTime() <= now.getTime()
    )
      return false;
    // Claimed before the first await, as the database's row lock would.
    Object.assign(proposal, {
      status: "approved",
      decidedAt: now,
      decidedBy: "customer",
    });
    if (!(await this.intents.record(scope, order, "assistant_proposal"))) {
      Object.assign(proposal, {
        status: "draft",
        decidedAt: null,
        decidedBy: null,
      });
      throw new Error("The client order ID was used before.");
    }
    proposal.clientOrderId = clientOrderIdOf(order);
    return true;
  }

  #mine(scope: AccountScope, owner: AccountScope) {
    return (
      owner.customerId === scope.customerId &&
      owner.exchangeAccountId === scope.exchangeAccountId
    );
  }

  #owned(scope: AccountScope, proposalId: string) {
    const proposal = this.proposals.get(proposalId);
    return proposal && this.#mine(scope, proposal) ? proposal : undefined;
  }

  #decisionView(decision: Decision, now: Date): DecisionView {
    const {
      scope: _scope,
      idempotencyKey: _key,
      proposalId,
      ...view
    } = decision;
    const proposal = proposalId ? this.proposals.get(proposalId) : undefined;
    return {
      ...view,
      proposal: proposal ? this.#proposalView(proposal, now) : null,
    };
  }

  #proposalView(proposal: Proposal, now: Date): ProposalView {
    const intent = proposal.clientOrderId
      ? this.intents.intents.get(proposal.clientOrderId)
      : undefined;
    const leg = (clientOrderId: string) => {
      const order = this.intents.orders.get(clientOrderId);
      return order
        ? {
            orderId: String(order.orderId),
            status: order.status,
            filledQuantity: order.executedQty,
            averageFillPrice: null,
          }
        : null;
    };
    const legs = proposal.clientOrderId
      ? protectedLegIds(proposal.clientOrderId)
      : undefined;
    const order =
      intent && legs
        ? {
            listClientOrderId: intent.clientOrderId,
            intentStatus: intent.status,
            entry: leg(legs.entry),
            takeProfit: leg(legs.takeProfit),
            stopLoss: leg(legs.stopLoss),
            reconciliation: null,
            checkedAt: null,
          }
        : null;
    return {
      id: proposal.id,
      instrument: proposal.instrument,
      marketKind: proposal.marketKind,
      direction: proposal.direction,
      quantity: proposal.quantity,
      entryPrice: proposal.entryPrice,
      stopLossPrice: proposal.stopLossPrice,
      takeProfitPrice: proposal.takeProfitPrice,
      leverage: proposal.leverage,
      entryExpiresAt: proposal.entryExpiresAt.toISOString(),
      strategyId: proposal.strategyId,
      strategyVersion: proposal.strategyVersion,
      status: proposalStatus(
        proposal.status,
        proposal.entryExpiresAt,
        order,
        now,
      ),
      decidedAt: proposal.decidedAt?.toISOString() ?? null,
      decidedBy: proposal.decidedBy,
      decisionReason: proposal.decisionReason,
      order,
    };
  }
}
