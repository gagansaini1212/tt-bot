import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import type { MarketKind, TradeDirection } from "@crypto-trading/domain";
import {
  checkProtectedEntry,
  MANUAL_TESTNET_STRATEGY,
  protectedEntrySchema,
  protectedLegIds,
  STRATEGY_LIST_PREFIX,
  type AiDecisionRequest,
  type DecisionView,
  type EntryReconciliation,
  type ManualOrderPlan,
  type ManualOrderTicket,
  type ProposalOrderLeg,
  type ProposalStatus,
  type ProposalView,
  type ProtectedEntry,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import type { EntryState } from "./entry-assessment";
import { audit, insertOrderIntent, type ManualOrder } from "./order-intents";

/**
 * A proposal's saved status. `authorized` is for a strategy's proposals that
 * pass its checks without the customer; nothing here writes it.
 */
export type SavedProposalStatus =
  "draft" | "approved" | "rejected" | "authorized" | "expired";

/** A trade proposal as saved in trade_proposals. */
export type SavedProposal = {
  id: string;
  customerId: string;
  exchangeAccountId: string;
  // Null for a proposal the assistant drafted in conversation.
  strategyId: string | null;
  strategyVersion: number | null;
  sourceSnapshotId: string;
  instrument: string;
  marketKind: MarketKind;
  direction: TradeDirection;
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  leverage: number;
  entryExpiresAt: Date;
  rationale: string;
  status: SavedProposalStatus;
};

export type ProposalRefusal = {
  by: "customer" | "execution_checks";
  reason?: string;
};

/**
 * Where the worker keeps AI decisions and their trade proposals. Each call is
 * one short transaction in the customer's scope, on `scope`'s exchange
 * account; nothing waits on Binance while a transaction is open.
 */
export interface TradeProposalStore {
  /**
   * Records an AI decision, and its proposal as a draft. A request with an
   * idempotency key recorded before changes nothing and returns that decision.
   * An AI-managed strategy's decisions name its strategy and version.
   */
  record(
    scope: AccountScope,
    request: AiDecisionRequest,
    now: Date,
    strategy?: { strategyId: string; strategyVersion: number },
  ): Promise<DecisionView>;
  /** The latest decisions, newest first, with their proposals. */
  decisions(
    scope: AccountScope,
    now: Date,
    limit: number,
  ): Promise<DecisionView[]>;
  view(
    scope: AccountScope,
    proposalId: string,
    now: Date,
  ): Promise<ProposalView | undefined>;
  find(
    scope: AccountScope,
    proposalId: string,
  ): Promise<SavedProposal | undefined>;
  /**
   * Rejects a draft: the assistant's, or an AI-managed strategy's that waits
   * for the customer. Resolves false if it is not a draft any more.
   */
  reject(
    scope: AccountScope,
    proposalId: string,
    refusal: ProposalRefusal,
    now: Date,
  ): Promise<boolean>;
  /** Marks a draft whose entry expiry has passed as expired. */
  expire(scope: AccountScope, proposalId: string, now: Date): Promise<boolean>;
  /**
   * Approves an assistant's draft whose entry expiry has not passed, and saves
   * `order`, the order that carries it out, as its order intent, together.
   * Resolves false, saving nothing, if it is not such a draft any more: a
   * proposal is approved at most once, so it is never sent twice.
   */
  approve(
    scope: AccountScope,
    proposalId: string,
    order: ManualOrder,
    now: Date,
  ): Promise<boolean>;
}

const CANCELLED_STATUSES = [
  "CANCELED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
  "REJECTED",
];

// The execution loop's entry states, as the customer sees the proposal.
const STATUS_OF_ENTRY: Record<
  Exclude<EntryReconciliation["state"], "closed">,
  ProposalStatus
> = {
  working: "submitted",
  partly_filled: "submitted",
  awaiting_exits: "filled",
  protected: "filled",
  unprotected: "filled",
  exiting: "filled",
  not_filled: "cancelled",
  handed_over: "cancelled",
  missing: "cancelled",
};

/**
 * What the customer sees: the saved status, the expiry and the order's fate.
 * Once the execution loop has checked the entry, its finding decides; until
 * then, what Binance reported when the order was placed.
 */
export function proposalStatus(
  status: SavedProposalStatus,
  entryExpiresAt: Date,
  order: {
    intentStatus: string;
    entry: ProposalOrderLeg | null;
    reconciliation: EntryReconciliation | null;
  } | null,
  now: Date,
): ProposalStatus {
  switch (status) {
    case "draft":
      return entryExpiresAt.getTime() <= now.getTime() ? "expired" : "draft";
    case "rejected":
    case "expired":
      return status;
    case "approved":
    case "authorized":
      // Binance has not confirmed the order yet.
      if (
        !order ||
        ["pending", "submitting", "unknown"].includes(order.intentStatus)
      )
        return "approved";
      if (order.intentStatus === "rejected") return "rejected";
      if (order.intentStatus === "cancelled") return "cancelled";
      if (order.reconciliation) {
        const { state, filledQuantity } = order.reconciliation;
        if (state !== "closed") return STATUS_OF_ENTRY[state];
        // Closed: it held something and now holds nothing.
        return new Decimal(filledQuantity).isZero() ? "cancelled" : "filled";
      }
      if (order.entry?.status === "FILLED") return "filled";
      if (order.entry && CANCELLED_STATUSES.includes(order.entry.status))
        return "cancelled";
      return "submitted";
  }
}

/**
 * The client ID of the order list that carries out a proposal. It is the same
 * on every attempt, and an ID is never submitted twice, so a proposal cannot
 * be.
 */
export function proposalClientOrderId(proposalId: string) {
  const bytes = Buffer.from(proposalId.replaceAll("-", ""), "hex");
  return `ct_ai${bytes.toString("base64url")}`;
}

/**
 * The client ID of the order list that carries out one of a strategy's
 * protected entries, from its proposal, like `proposalClientOrderId`. Its
 * prefix keeps it out of the dashboard's own limits.
 */
export function strategyEntryClientOrderId(proposalId: string) {
  const bytes = Buffer.from(proposalId.replaceAll("-", ""), "hex");
  return `${STRATEGY_LIST_PREFIX}${bytes.toString("base64url")}`;
}

/**
 * The order an approved proposal places: a limit buy at its entry price with
 * its stop loss and take profit, one Binance order list like a dashboard
 * order. Binance Spot has no good-till-date orders, so it rests until it
 * fills or is cancelled; the entry expiry bounds approval.
 */
export function proposalEntry(
  proposal: SavedProposal,
): ProtectedEntry | undefined {
  const entry = protectedEntrySchema.safeParse({
    instrument: proposal.instrument,
    quantity: proposal.quantity,
    price: proposal.entryPrice,
    timeInForce: "GTC",
    takeProfitPrice: proposal.takeProfitPrice,
    stopLossPrice: proposal.stopLossPrice,
    listClientOrderId: proposalClientOrderId(proposal.id),
  });
  return entry.success ? entry.data : undefined;
}

/**
 * Runs every pre-execution check for an approval: `authorizeTradeProposal`
 * on the proposal as saved, against the dashboard's manual limits and fresh
 * account data, then the per-order cap, Binance's filters and the free
 * balance. The assistant's proposals belong to no strategy, so the customer
 * approves each one as their own order, under the limits of their own.
 */
export function planProposalOrder(
  proposal: SavedProposal,
  ticket: ManualOrderTicket,
  now: Date,
): ManualOrderPlan {
  const entry = proposalEntry(proposal);
  if (!entry)
    return {
      passed: false,
      checks: [
        {
          name: "limits",
          label: "Account limits",
          passed: false,
          detail:
            "This account takes long spot entries in BASE-QUOTE markets only, with the stop loss below the entry price and the take profit above it.",
        },
      ],
    };
  return checkProtectedEntry(
    entry,
    {
      proposalId: proposal.id,
      customerId: proposal.customerId,
      exchangeAccountId: proposal.exchangeAccountId,
      ...MANUAL_TESTNET_STRATEGY,
      instrument: entry.instrument,
      marketKind: proposal.marketKind,
      direction: proposal.direction,
      quantity: proposal.quantity,
      entryPrice: proposal.entryPrice,
      stopLossPrice: proposal.stopLossPrice,
      takeProfitPrice: proposal.takeProfitPrice,
      leverage: proposal.leverage,
      entryExpiresAt: proposal.entryExpiresAt.toISOString(),
      rationale: proposal.rationale,
      sourceSnapshotId: proposal.sourceSnapshotId,
    },
    ticket,
    now,
    {
      // Binance Spot Testnet: long, unleveraged spot entries only.
      policy: {
        ...ticket.policy,
        marketKind: "spot",
        allowedDirections: ["long"],
      },
    },
  );
}

/** Exact decimal text without PostgreSQL's trailing zeros. */
function plain(value: string) {
  return new Decimal(value).toFixed();
}

type DecisionRow = {
  decision_id: string | null;
  kind: "trade_proposal" | "no_trade";
  created_at: Date;
  decision_instrument: string | null;
  model: string | null;
  prompt_version: string | null;
  source_snapshot_id: string;
  rationale: string;
  proposal_id: string | null;
  strategy_id: string | null;
  strategy_version: number | null;
  instrument: string | null;
  market_kind: MarketKind;
  direction: TradeDirection;
  quantity: string;
  entry_price: string;
  stop_loss_price: string;
  take_profit_price: string;
  leverage: number;
  entry_expires_at: Date;
  status: SavedProposalStatus;
  decided_at: Date | null;
  decided_by: ProposalView["decidedBy"];
  decision_reason: string | null;
  list_client_order_id: string | null;
  intent_status: string | null;
  // The loop's own type, so its states and the view's stay the same.
  entry_state: EntryState | null;
  entry_filled: string | null;
  entry_held: string | null;
  entry_exit_reason: string | null;
  entry_close_blocked_at: Date | null;
  entry_detail: string | null;
  entry_checked_at: Date | null;
  orders:
    | {
        clientOrderId: string;
        orderId: string | null;
        status: string;
        filledQuantity: string;
        averageFillPrice: string | null;
        updatedAt: string;
      }[]
    | null;
};

function proposalViewOf(row: DecisionRow, now: Date): ProposalView {
  let order: ProposalView["order"] = null;
  if (row.list_client_order_id && row.intent_status) {
    const legs = protectedLegIds(row.list_client_order_id);
    const leg = (clientOrderId: string) => {
      const found = row.orders?.find(
        (entry) => entry.clientOrderId === clientOrderId,
      );
      return found
        ? {
            orderId: found.orderId,
            status: found.status,
            filledQuantity: plain(found.filledQuantity),
            averageFillPrice:
              found.averageFillPrice === null
                ? null
                : plain(found.averageFillPrice),
          }
        : null;
    };
    const reconciliation =
      row.entry_state && row.entry_checked_at
        ? {
            state: row.entry_state,
            filledQuantity: plain(row.entry_filled ?? "0"),
            heldQuantity: plain(row.entry_held ?? "0"),
            exitReason: row.entry_exit_reason,
            closeBlocked: row.entry_close_blocked_at !== null,
            detail: row.entry_detail ?? "",
            checkedAt: row.entry_checked_at.toISOString(),
          }
        : null;
    const reported = row.orders?.map((leg) => Date.parse(leg.updatedAt));
    order = {
      listClientOrderId: row.list_client_order_id,
      intentStatus: row.intent_status,
      entry: leg(legs.entry),
      takeProfit: leg(legs.takeProfit),
      stopLoss: leg(legs.stopLoss),
      reconciliation,
      checkedAt:
        reconciliation?.checkedAt ??
        (reported?.length
          ? new Date(Math.max(...reported)).toISOString()
          : null),
    };
  }
  return {
    id: row.proposal_id!,
    instrument: row.instrument!,
    marketKind: row.market_kind,
    direction: row.direction,
    quantity: plain(row.quantity),
    entryPrice: plain(row.entry_price),
    stopLossPrice: plain(row.stop_loss_price),
    takeProfitPrice: plain(row.take_profit_price),
    leverage: row.leverage,
    entryExpiresAt: row.entry_expires_at.toISOString(),
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    status: proposalStatus(row.status, row.entry_expires_at, order, now),
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    order,
  };
}

function decisionViewOf(row: DecisionRow, now: Date): DecisionView {
  return {
    id: row.decision_id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    instrument: row.decision_instrument ?? row.instrument,
    model: row.model,
    promptVersion: row.prompt_version,
    sourceSnapshotId: row.source_snapshot_id,
    rationale: row.rationale,
    proposal: row.proposal_id ? proposalViewOf(row, now) : null,
  };
}

/**
 * Decisions with their proposals, and proposals without a recorded decision,
 * such as a strategy's, on `scope`'s exchange account.
 */
function selectDecisions(
  tx: Transaction,
  scope: AccountScope,
  {
    proposalId,
    decisionId,
    limit,
  }: { proposalId?: string; decisionId?: string; limit: number },
) {
  return tx<DecisionRow[]>`
    select
      d.id as decision_id,
      coalesce(d.kind, 'trade_proposal') as kind,
      coalesce(d.created_at, p.created_at) as created_at,
      d.instrument as decision_instrument,
      d.model,
      d.prompt_version,
      coalesce(d.source_snapshot_id, p.source_snapshot_id) as source_snapshot_id,
      coalesce(d.rationale, p.rationale) as rationale,
      p.id as proposal_id,
      p.strategy_id,
      p.strategy_version,
      p.instrument,
      p.market_kind,
      p.direction,
      p.quantity::text,
      p.entry_price::text,
      p.stop_loss_price::text,
      p.take_profit_price::text,
      p.leverage,
      p.entry_expires_at,
      p.status,
      p.decided_at,
      p.decided_by,
      p.decision_reason,
      i.idempotency_key as list_client_order_id,
      i.status as intent_status,
      r.state as entry_state,
      r.filled_quantity::text as entry_filled,
      r.held_quantity::text as entry_held,
      r.exit_reason as entry_exit_reason,
      r.close_blocked_at as entry_close_blocked_at,
      r.detail as entry_detail,
      r.checked_at as entry_checked_at,
      (
        select json_agg(json_build_object(
          'clientOrderId', o.client_order_id,
          'orderId', o.exchange_order_id,
          'status', o.status,
          'filledQuantity', o.filled_quantity::text,
          'averageFillPrice', o.average_fill_price::text,
          'updatedAt', o.updated_at
        ))
        from exchange_orders o
        where o.order_intent_id = i.id
      ) as orders
    from ai_decisions d
    full join trade_proposals p on p.id = d.proposal_id
    left join order_intents i on i.proposal_id = p.id
    left join entry_reconciliations r on r.order_intent_id = i.id
    where coalesce(d.exchange_account_id, p.exchange_account_id) = ${scope.exchangeAccountId}
      and (${proposalId ?? null}::uuid is null or p.id = ${proposalId ?? null}::uuid)
      and (${decisionId ?? null}::uuid is null or d.id = ${decisionId ?? null}::uuid)
    order by coalesce(d.created_at, p.created_at) desc, p.id
    limit ${limit}
  `;
}

/** AI decisions and trade proposals in PostgreSQL's ai_decisions and trade_proposals. */
export class PostgresTradeProposals implements TradeProposalStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #scoped<T>(scope: AccountScope, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, scope.customerId, work);
  }

  record(
    scope: AccountScope,
    request: AiDecisionRequest,
    now: Date,
    strategy?: { strategyId: string; strategyVersion: number },
  ) {
    return this.#scoped(scope, async (tx) => {
      // A replayed tool call can arrive while the first is still saving it.
      // This waits for that transaction, so the lookup below finds its row.
      await tx`select pg_advisory_xact_lock(hashtext(${request.idempotencyKey}))`;
      const [existing] = await tx<{ id: string }[]>`
        select id from ai_decisions where idempotency_key = ${request.idempotencyKey}
      `;
      const id = existing?.id ?? randomUUID();
      if (!existing) {
        let proposalId: string | null = null;
        if (request.kind === "trade_proposal") {
          proposalId = randomUUID();
          const { proposal } = request;
          await tx`
            insert into trade_proposals (
              id, customer_id, exchange_account_id, strategy_id,
              strategy_version, source_snapshot_id,
              instrument, market_kind, direction, quantity, entry_price,
              stop_loss_price, take_profit_price, leverage, entry_expires_at,
              rationale, status, created_at
            )
            values (
              ${proposalId}, ${scope.customerId}, ${scope.exchangeAccountId},
              ${strategy?.strategyId ?? null}, ${strategy?.strategyVersion ?? null},
              ${request.sourceSnapshotId}, ${proposal.instrument},
              ${proposal.marketKind}, ${proposal.direction},
              ${proposal.quantity}::numeric, ${proposal.entryPrice}::numeric,
              ${proposal.stopLossPrice}::numeric,
              ${proposal.takeProfitPrice}::numeric, ${proposal.leverage},
              ${proposal.entryExpiresAt}::timestamptz, ${request.rationale},
              'draft', ${now}
            )
          `;
        }
        await tx`
          insert into ai_decisions (
            id, customer_id, exchange_account_id, strategy_id, kind,
            proposal_id, instrument, model, prompt_version, source_snapshot_id,
            rationale, idempotency_key, created_at
          )
          values (
            ${id}, ${scope.customerId}, ${scope.exchangeAccountId},
            ${strategy?.strategyId ?? null}, ${request.kind}, ${proposalId},
            ${request.kind === "no_trade" ? request.instrument : null},
            ${request.model}, ${request.promptVersion},
            ${request.sourceSnapshotId}, ${request.rationale},
            ${request.idempotencyKey}, ${now}
          )
        `;
        await audit(tx, scope, id, "ai_decision.recorded", {
          actor: "assistant",
          actorId: request.model,
          subjectType: "ai_decision",
          payload: {
            kind: request.kind,
            proposalId,
            strategyId: strategy?.strategyId ?? null,
            promptVersion: request.promptVersion,
            sourceSnapshotId: request.sourceSnapshotId,
          },
        });
      }
      const [row] = await selectDecisions(tx, scope, {
        decisionId: id,
        limit: 1,
      });
      if (!row)
        throw new Error(
          `Decision ${request.idempotencyKey} was recorded for another exchange account.`,
        );
      return decisionViewOf(row, now);
    });
  }

  async decisions(scope: AccountScope, now: Date, limit: number) {
    const rows = await this.#scoped(scope, (tx) =>
      selectDecisions(tx, scope, { limit }),
    );
    return rows.map((row) => decisionViewOf(row, now));
  }

  async view(scope: AccountScope, proposalId: string, now: Date) {
    const [row] = await this.#scoped(scope, (tx) =>
      selectDecisions(tx, scope, { proposalId, limit: 1 }),
    );
    return row ? proposalViewOf(row, now) : undefined;
  }

  find(scope: AccountScope, proposalId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<
        {
          id: string;
          customer_id: string;
          exchange_account_id: string;
          strategy_id: string | null;
          strategy_version: number | null;
          source_snapshot_id: string;
          instrument: string;
          market_kind: MarketKind;
          direction: TradeDirection;
          quantity: string;
          entry_price: string;
          stop_loss_price: string;
          take_profit_price: string;
          leverage: number;
          entry_expires_at: Date;
          rationale: string;
          status: SavedProposalStatus;
        }[]
      >`
        select id, customer_id, exchange_account_id, strategy_id,
          strategy_version, source_snapshot_id, instrument, market_kind,
          direction, quantity::text, entry_price::text, stop_loss_price::text,
          take_profit_price::text, leverage, entry_expires_at, rationale, status
        from trade_proposals
        where id = ${proposalId} and exchange_account_id = ${scope.exchangeAccountId}
      `;
      if (!row) return undefined;
      return {
        id: row.id,
        customerId: row.customer_id,
        exchangeAccountId: row.exchange_account_id,
        strategyId: row.strategy_id,
        strategyVersion: row.strategy_version,
        sourceSnapshotId: row.source_snapshot_id,
        instrument: row.instrument,
        marketKind: row.market_kind,
        direction: row.direction,
        quantity: plain(row.quantity),
        entryPrice: plain(row.entry_price),
        stopLossPrice: plain(row.stop_loss_price),
        takeProfitPrice: plain(row.take_profit_price),
        leverage: row.leverage,
        entryExpiresAt: row.entry_expires_at,
        rationale: row.rationale,
        status: row.status,
      } satisfies SavedProposal;
    });
  }

  reject(
    scope: AccountScope,
    proposalId: string,
    refusal: ProposalRefusal,
    now: Date,
  ) {
    return this.#scoped(scope, async (tx) => {
      const [changed] = await tx<{ id: string }[]>`
        update trade_proposals
        set status = 'rejected', decided_at = ${now}, decided_by = ${refusal.by},
          decision_reason = ${refusal.reason?.slice(0, 1_000) || null}
        where id = ${proposalId}
          and exchange_account_id = ${scope.exchangeAccountId}
          and status = 'draft'
        returning id
      `;
      if (changed)
        await audit(tx, scope, proposalId, "trade_proposal.rejected", {
          actor: refusal.by === "customer" ? "customer" : "execution_worker",
          subjectType: "trade_proposal",
          payload: { reason: refusal.reason ?? null },
        });
      return Boolean(changed);
    });
  }

  expire(scope: AccountScope, proposalId: string, now: Date) {
    return this.#scoped(scope, async (tx) => {
      const [changed] = await tx<{ id: string }[]>`
        update trade_proposals
        set status = 'expired', decided_at = ${now}, decided_by = 'expiry'
        where id = ${proposalId}
          and exchange_account_id = ${scope.exchangeAccountId}
          and status = 'draft'
          and entry_expires_at <= ${now}
        returning id
      `;
      if (changed)
        await audit(tx, scope, proposalId, "trade_proposal.expired", {
          actor: "execution_worker",
          subjectType: "trade_proposal",
          payload: {},
        });
      return Boolean(changed);
    });
  }

  approve(
    scope: AccountScope,
    proposalId: string,
    order: ManualOrder,
    now: Date,
  ) {
    return this.#scoped(scope, async (tx) => {
      // Two approvals can race here, from two tabs or two workers. Only the
      // first to commit finds the draft.
      const [claimed] = await tx<{ id: string }[]>`
        update trade_proposals
        set status = 'approved', decided_at = ${now}, decided_by = 'customer'
        where id = ${proposalId}
          and exchange_account_id = ${scope.exchangeAccountId}
          and status = 'draft'
          and strategy_id is null
          and entry_expires_at > ${now}
        returning id
      `;
      if (!claimed) return false;
      await audit(tx, scope, proposalId, "trade_proposal.approved", {
        actor: "customer",
        subjectType: "trade_proposal",
        payload: {},
      });
      const intent = await insertOrderIntent(
        tx,
        scope,
        order,
        "assistant_proposal",
        { proposalId },
      );
      // Rolls the approval back too, so nothing is sent.
      if (!intent)
        throw new Error(
          `The client order ID for proposal ${proposalId} was used before.`,
        );
      return true;
    });
  }
}
