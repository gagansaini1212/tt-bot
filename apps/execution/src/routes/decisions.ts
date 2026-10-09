import Decimal from "decimal.js";
import {
  assistantDecisionRequestSchema,
  canTrade,
  exchangeAccountName,
  rejectProposalRequestSchema,
  type AccountAdapter,
  type AccountReader,
  type AssistantDecisionRequest,
} from "@crypto-trading/exchanges";
import {
  instrumentAssets,
  instrumentLabel,
  type Instrument,
} from "@crypto-trading/domain";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import type { ReportingDirectory } from "../reporting-directory";
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
 *
 * A trade proposal names the exchange account it trades on (ADR 0009). It is
 * recorded only if the customer owns that account, the account can trade,
 * this worker trades on it, and its own free balance pays for the entry.
 * Without `directory`, the worker cannot tell, so it records no proposal.
 */
export function decisions({
  proposals,
  now,
  deskFor,
  disabledMessage,
  strategies,
  instruments,
  directory,
}: {
  proposals: TradeProposalStore;
  // The instruments an account allows. A decision about any other is refused.
  instruments: (scope: AccountScope) => Promise<Instrument[]>;
  // The customer's exchange accounts.
  directory?: Pick<ReportingDirectory, "accounts">;
  now: () => number;
  deskFor: (
    exchange: AccountAdapter,
    account: AccountScope,
  ) => ManualOrderDesk | undefined;
  disabledMessage: (exchange: AccountAdapter) => string;
  // Approves an AI-managed strategy's proposals under its own limits.
  strategies?: Pick<StrategyRunner, "approve">;
}) {
  const disabled = (exchange: AccountAdapter) => ({
    status: "rejected" as const,
    message: disabledMessage(exchange),
  });
  const clock = () => new Date(now());
  // After an approval or rejection, a failed read must not hide its outcome.
  const latest = (account: AccountScope, proposalId: string) =>
    proposals
      .view(account, proposalId, clock())
      .then((view) => view ?? null)
      .catch(() => null);
  /**
   * The name of the account a proposal targets, once it is the customer's,
   * can trade, and is the one this worker trades on. Throws what the
   * assistant should fix otherwise.
   */
  const targetAccount = async (
    account: AccountScope,
    request: Extract<AssistantDecisionRequest, { kind: "trade_proposal" }>,
  ) => {
    if (!directory)
      throw invalidDecision(
        "This execution worker cannot check exchange accounts, so it records no trade proposals.",
      );
    const target = (await directory.accounts(account.customerId)).find(
      (entry) => entry.id === request.exchangeAccountId,
    );
    if (!target)
      throw invalidDecision(
        "None of this customer's exchange accounts has that exchangeAccountId. Use the exchangeAccountId of an account in the client context.",
      );
    const name = exchangeAccountName(target);
    if (target.access === "read_only")
      throw invalidDecision(
        `${name} is a read-only exchange account: the product monitors it but never trades on it. Propose on an account that can trade, or record no trade.`,
      );
    if (target.mode !== "simulation")
      throw invalidDecision(
        `${name} is a live account, and live trading is turned off.`,
      );
    if (target.id !== account.exchangeAccountId)
      throw invalidDecision(
        `The execution worker does not trade on ${name} yet, so it cannot check or place a proposal there.`,
      );
    return name;
  };

  return {
    record: handler({
      caller: "assistant",
      query: z.strictObject({}),
      // Checked below, so the assistant learns what to fix.
      body: z.unknown(),
      async handle({ body, account, exchange }) {
        const parsed = assistantDecisionRequestSchema.safeParse(body);
        if (!parsed.success)
          throw invalidDecision(z.prettifyError(parsed.error));
        const request = parsed.data;
        if (
          request.kind === "trade_proposal" &&
          Date.parse(request.proposal.entryExpiresAt) <= now()
        )
          throw invalidDecision("The entry expiry must be in the future.");
        const allowed = async (instrument: Instrument) => {
          const tradable = await instruments(account);
          if (!tradable.includes(instrument))
            throw invalidDecision(
              `${instrumentLabel(instrument)} is not among this exchange account's allowed instruments: ${tradable.map(instrumentLabel).join(", ") || "none"}.`,
            );
        };
        if (request.kind === "no_trade") {
          if (request.instrument) await allowed(request.instrument);
          return {
            status: "connected",
            decision: await proposals.record(account, request, clock()),
          };
        }
        const name = await targetAccount(account, request);
        const { exchangeAccountId: _target, ...decision } = request;
        await allowed(decision.proposal.instrument);
        await paidByOwnBalance(exchange, name, decision.proposal);
        return {
          status: "connected",
          decision: await proposals.record(account, decision, clock()),
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
        const desk = deskFor(exchange, account);
        const outcome = !canTrade(exchange)
          ? disabled(exchange)
          : saved?.strategyId
            ? strategies
              ? await strategies.approve(account, exchange, body.proposalId)
              : {
                  status: "rejected" as const,
                  message:
                    "This worker does not run strategies. Nothing was sent.",
                }
            : desk
              ? await desk.approve(account, body.proposalId)
              : disabled(exchange);
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

/**
 * Refuses a proposal that the target account's own free balance in the
 * market's quote currency cannot pay for. Capital on another exchange
 * account never pays for it, so no other account's balance is read.
 */
async function paidByOwnBalance(
  exchange: Pick<AccountReader, "getAccount">,
  name: string,
  proposal: { instrument: Instrument; quantity: string; entryPrice: string },
) {
  const { quote } = instrumentAssets(proposal.instrument);
  const { balances } = await exchange.getAccount();
  const free = new Decimal(
    balances.find((balance) => balance.asset === quote)?.free ?? "0",
  );
  const cost = new Decimal(proposal.quantity).times(proposal.entryPrice);
  if (cost.greaterThan(free))
    throw invalidDecision(
      `The entry costs ${cost.toFixed()} ${quote}, but ${name} has ${free.toFixed()} ${quote} free. Only this account's own balance can pay for it: capital on another exchange account cannot.`,
    );
}

function invalidDecision(message: string) {
  return new RequestError(400, {
    status: "invalid_request",
    message: message.slice(0, 1_000),
  });
}
