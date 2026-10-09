import {
  aiDecisionRequestSchema,
  rejectProposalRequestSchema,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";
import { instrumentLabel, type Instrument } from "@crypto-trading/domain";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import { accountHandler, handler, RequestError } from "../http";
import type { ManualOrderDesk } from "../manual-orders";
import type { StrategyRunner } from "../strategy-runner";
import type { TradeProposalStore } from "../trade-proposals";

// How many decisions the Activity page lists.
const DECISION_LIMIT = 50;

/**
 * AI decisions and the customer's answer to each proposal. Only the analysis
 * assistant records decisions; the web server lists them and approves or
 * rejects proposals for the signed-in customer. An approval places the
 * proposal through the dashboard desk, which runs every check again first.
 */
export function decisions({
  proposals,
  now,
  deskFor,
  disabledMessage,
  strategies,
  instruments,
}: {
  proposals: TradeProposalStore;
  // The instruments an account allows. A decision about any other is refused.
  instruments: (scope: AccountScope) => Promise<Instrument[]>;
  now: () => number;
  deskFor: (exchange: BinanceSpotTestnet) => ManualOrderDesk | undefined;
  disabledMessage: string;
  // Approves an AI-managed strategy's proposals under its own limits.
  strategies?: Pick<StrategyRunner, "approve">;
}) {
  const disabled = { status: "rejected" as const, message: disabledMessage };
  const clock = () => new Date(now());
  // After an approval or rejection, a failed read must not hide its outcome.
  const latest = (account: AccountScope, proposalId: string) =>
    proposals
      .view(account, proposalId, clock())
      .then((view) => view ?? null)
      .catch(() => null);
  return {
    record: accountHandler({
      caller: "assistant",
      query: z.strictObject({}),
      // Checked below, so the assistant learns what to fix.
      body: z.unknown(),
      async handle({ body, account }) {
        const parsed = aiDecisionRequestSchema.safeParse(body);
        if (!parsed.success)
          throw invalidDecision(z.prettifyError(parsed.error));
        const request = parsed.data;
        if (
          request.kind === "trade_proposal" &&
          Date.parse(request.proposal.entryExpiresAt) <= now()
        )
          throw invalidDecision("The entry expiry must be in the future.");
        const instrument =
          request.kind === "trade_proposal"
            ? request.proposal.instrument
            : request.instrument;
        if (instrument) {
          const allowed = await instruments(account);
          if (!allowed.includes(instrument))
            throw invalidDecision(
              `${instrumentLabel(instrument)} is not among this exchange account's allowed instruments: ${allowed.map(instrumentLabel).join(", ") || "none"}.`,
            );
        }
        return {
          status: "connected",
          decision: await proposals.record(account, request, clock()),
        };
      },
    }),
    list: accountHandler({
      query: z.strictObject({}),
      async handle({ account }) {
        return {
          status: "connected",
          decisions: await proposals.decisions(
            account,
            clock(),
            DECISION_LIMIT,
          ),
        };
      },
    }),
    proposal: accountHandler({
      query: z.strictObject({ proposalId: z.uuid() }),
      async handle({ query, account }) {
        return {
          status: "connected",
          proposal:
            (await proposals.view(account, query.proposalId, clock())) ?? null,
        };
      },
    }),
    approve: handler({
      query: z.strictObject({}),
      body: z.strictObject({ proposalId: z.uuid() }),
      async handle({ exchange, body, account }) {
        // A strategy's proposal is checked against the strategy, not the
        // dashboard's limits.
        const saved = await proposals.find(account, body.proposalId);
        const desk = deskFor(exchange);
        const outcome = saved?.strategyId
          ? strategies
            ? await strategies.approve(account, exchange, body.proposalId)
            : {
                status: "rejected" as const,
                message:
                  "This worker does not run strategies. Nothing was sent.",
              }
          : desk
            ? await desk.approve(account, body.proposalId)
            : disabled;
        return {
          status: "connected",
          outcome,
          proposal: await latest(account, body.proposalId),
        };
      },
    }),
    reject: accountHandler({
      query: z.strictObject({}),
      body: rejectProposalRequestSchema,
      async handle({ body, account }) {
        const at = clock();
        const answer = (rejected: boolean, message: string) => ({
          status: "connected",
          rejected,
          message,
        });
        const proposal = await proposals.find(account, body.proposalId);
        if (!proposal)
          return {
            ...answer(false, "There is no such proposal."),
            proposal: null,
          };
        let result;
        if (
          proposal.status === "draft" &&
          proposal.entryExpiresAt.getTime() <= at.getTime()
        ) {
          await proposals.expire(account, body.proposalId, at);
          result = answer(false, "This proposal had already expired.");
        } else if (
          await proposals.reject(
            account,
            body.proposalId,
            { by: "customer", reason: body.reason },
            at,
          )
        )
          result = answer(true, "You rejected this proposal.");
        else
          result = answer(
            false,
            "This proposal was already decided, so it was left as it is.",
          );
        return {
          ...result,
          proposal: await latest(account, body.proposalId),
        };
      },
    }),
  };
}

function invalidDecision(message: string) {
  return new RequestError(400, {
    status: "invalid_request",
    message: message.slice(0, 1_000),
  });
}
