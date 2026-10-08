import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import {
  withCustomerScope,
  type Database,
  type JSONValue,
  type Transaction,
} from "@crypto-trading/database";
import {
  authorizeTradeProposal,
  entryIntentProposal,
  ruleLimits,
  strategyRulesSchema,
  type EntryIntent,
  type StrategyRules,
  type StrategyStatus,
} from "@crypto-trading/domain";
import {
  aiSettingsSchema,
  testnetInstrumentSchema,
  type AiSettings,
  type PortfolioLimitsState,
  type ProtectedEntry,
  type StrategyDraft,
  type TestnetInstrument,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import { TERMINAL_STATES, type EntryState } from "./entry-assessment";
import { requestExitIn, requestStrategyExits } from "./execution-store";
import { raiseNotification, type NewNotification } from "./notifications";
import {
  audit,
  insertOrderIntent,
  type OrderIntentStatus,
} from "./order-intents";
import type { MeasuredFill } from "./strategy-pnl";
import { strategyEntryClientOrderId } from "./trade-proposals";

/** A strategy, with its current version's rules and its allocation. */
export type StrategyRecord = {
  id: string;
  name: string;
  status: StrategyStatus;
  version: number;
  createdAt: Date;
  rules: StrategyRules;
  ai: AiSettings | null;
  allocation: string;
  pauseReason: string | null;
  pausedAt: Date | null;
  exitRequest: string | null;
  rulesEndedAt: Date | null;
  rulesEndedReason: string | null;
  completedAt: Date | null;
  runnerNote: string;
  runnerCheckedAt: Date | null;
  nextAnalysisAt: Date | null;
};

/**
 * One of a strategy's protected entries: its proposal and, once saved, the
 * order intent that carries it out and the loop's latest finding. An AI
 * proposal waiting for the customer has no intent yet.
 */
export type StrategyEntry = {
  proposalId: string;
  strategyId: string;
  version: number;
  key: string | null;
  attempt: number | null;
  instrument: TestnetInstrument;
  quantity: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  entryExpiresAt: Date;
  proposalStatus: string;
  createdAt: Date;
  orderIntentId: string | null;
  listClientOrderId: string | null;
  intentStatus: OrderIntentStatus | null;
  state: EntryState | null;
  filled: string;
  exitReason: string | null;
};

const RUNNING = ["simulation", "active"] as const;
const terminal = TERMINAL_STATES as readonly string[];
const NOT_PLACED = ["rejected", "cancelled"];

/** Sent or held, and not finished: it counts against every limit. */
export function isUnclosed(entry: StrategyEntry) {
  return (
    entry.intentStatus !== null &&
    !NOT_PLACED.includes(entry.intentStatus) &&
    (entry.state === null || !terminal.includes(entry.state))
  );
}

export function isRunning(status: StrategyStatus) {
  return (RUNNING as readonly string[]).includes(status);
}

/** What the worker would place for an entry, if its checks pass. */
export type EntryCandidate = {
  strategyId: string;
  // What the entry fills within the rules: 'level:3', 'buy:12', 'entry:0',
  // or 'ai'. A strategy holds at most one unclosed entry per key, except
  // 'ai'.
  key: string;
  // A DCA buy is made at most once, whatever became of it.
  once: boolean;
  intent: EntryIntent;
  rationale: string;
  sourceSnapshotId: string;
  // The proposal's ID, which the entry's client order ID comes from.
  proposalId: string;
  // Set for an AI proposal already saved as a draft: who decided to place it.
  draft?: { decidedBy: "customer" | "execution_checks" };
  // Stop orders Binance would still take on the symbol, beyond the ones
  // open now. Each entry's stop loss uses one.
  freeStopOrders: number;
};

export type Reservation =
  | { status: "saved"; proposalId: string; entry: ProtectedEntry }
  // `waits` when the entry may pass later unchanged: another strategy
  // holds the market's position, or Binance's stop orders are in use.
  | { status: "refused"; reason: string; waits?: boolean };

export type ControlResult =
  | { result: "saved"; message: string; strategy: StrategyRecord }
  | { result: "refused" | "conflict"; message: string };

type StrategyRow = {
  id: string;
  name: string;
  status: StrategyStatus;
  current_version: number;
  created_at: Date;
  pause_reason: string | null;
  paused_at: Date | null;
  exit_request: string | null;
  rules_ended_at: Date | null;
  rules_ended_reason: string | null;
  completed_at: Date | null;
  runner_note: string;
  runner_checked_at: Date | null;
  next_analysis_at: Date | null;
  rules: unknown;
  proposal_approval: string | null;
  analysis_interval_minutes: number | null;
  allocation: string;
};

function toRecord(row: StrategyRow): StrategyRecord | undefined {
  const rules = strategyRulesSchema.safeParse(row.rules);
  if (!rules.success) return undefined;
  const ai = aiSettingsSchema.safeParse({
    proposalApproval: row.proposal_approval,
    analysisIntervalMinutes: row.analysis_interval_minutes,
  });
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: row.current_version,
    createdAt: row.created_at,
    rules: rules.data,
    ai: ai.success ? ai.data : null,
    allocation: plain(row.allocation),
    pauseReason: row.pause_reason,
    pausedAt: row.paused_at,
    exitRequest: row.exit_request,
    rulesEndedAt: row.rules_ended_at,
    rulesEndedReason: row.rules_ended_reason,
    completedAt: row.completed_at,
    runnerNote: row.runner_note,
    runnerCheckedAt: row.runner_checked_at,
    nextAnalysisAt: row.next_analysis_at,
  };
}

function selectStrategies(
  tx: Transaction,
  scope: AccountScope,
  { id, lock = false }: { id?: string; lock?: boolean } = {},
) {
  return tx<StrategyRow[]>`
    select s.id, s.name, s.status, s.current_version, s.created_at,
      s.pause_reason, s.paused_at, s.exit_request, s.rules_ended_at,
      s.rules_ended_reason, s.completed_at, s.runner_note, s.runner_checked_at,
      s.next_analysis_at, v.rules, v.proposal_approval,
      v.analysis_interval_minutes, a.amount::text as allocation
    from strategies s
    join strategy_versions v
      on v.strategy_id = s.id and v.version = s.current_version
    join allocations a on a.strategy_id = s.id
    where s.exchange_account_id = ${scope.exchangeAccountId}
      and (${id ?? null}::uuid is null or s.id = ${id ?? null}::uuid)
    order by s.created_at desc, s.id
    ${lock ? tx`for update of s, a` : tx``}
  `;
}

/**
 * Strategies, their versions, allocations, entries and budget reservations
 * in PostgreSQL, one customer scope at a time. Nothing here waits on Binance.
 */
export class StrategyStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #scoped<T>(scope: AccountScope, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, scope.customerId, work);
  }

  /** The account's strategies, newest first. */
  list(scope: AccountScope): Promise<StrategyRecord[]> {
    return this.#scoped(scope, async (tx) =>
      (await selectStrategies(tx, scope)).flatMap((row) => toRecord(row) ?? []),
    );
  }

  get(scope: AccountScope, strategyId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await selectStrategies(tx, scope, { id: strategyId });
      return row && toRecord(row);
    });
  }

  /** Every entry of these strategies, oldest first, by strategy. */
  entries(
    scope: AccountScope,
    strategyIds: string[],
  ): Promise<Map<string, StrategyEntry[]>> {
    if (!strategyIds.length) return Promise.resolve(new Map());
    return this.#scoped(scope, async (tx) => {
      const rows = await selectEntries(tx, scope, strategyIds);
      const entries = new Map<string, StrategyEntry[]>();
      for (const row of rows) {
        const entry = toEntry(row);
        if (!entry) continue;
        entries.set(entry.strategyId, [
          ...(entries.get(entry.strategyId) ?? []),
          entry,
        ]);
      }
      return entries;
    });
  }

  /** The fills of these entries' orders and of the worker's sells for them. */
  fills(scope: AccountScope, orderIntentIds: string[]) {
    if (!orderIntentIds.length) return Promise.resolve([]);
    return this.#scoped(scope, async (tx) => {
      const rows = await tx<
        {
          entry_intent_id: string;
          client_order_id: string;
          quantity: string;
          price: string;
          fee: string;
          fee_currency: string;
          filled_at: Date;
        }[]
      >`
        select coalesce(c.closes_order_intent_id, c.id) as entry_intent_id,
          o.client_order_id, f.quantity::text, f.price::text, f.fee::text,
          f.fee_currency, f.filled_at
        from fills f
        join exchange_orders o on o.id = f.exchange_order_id
        join order_intents c on c.id = o.order_intent_id
        where coalesce(c.closes_order_intent_id, c.id) in ${tx(orderIntentIds)}
      `;
      return rows.map((row): MeasuredFill => ({
        orderIntentId: row.entry_intent_id,
        // An entry's own order is its list's _en leg; the rest sell.
        side: row.client_order_id.endsWith("_en") ? "buy" : "sell",
        quantity: plain(row.quantity),
        price: plain(row.price),
        fee: plain(row.fee),
        feeAsset: row.fee_currency,
        at: row.filled_at,
      }));
    });
  }

  /**
   * The list client order IDs of protected entries on the account being
   * sent, or sent without Binance confirming them, in `instrument`. Each
   * may hold one of Binance's stop orders on the symbol soon.
   */
  inFlightEntries(scope: AccountScope, instrument: TestnetInstrument) {
    return this.#scoped(scope, async (tx) =>
      (
        await tx<{ id: string }[]>`
          select idempotency_key as id from order_intents
          where exchange_account_id = ${scope.exchangeAccountId}
            and status in ('submitting', 'unknown')
            and manual_order ->> 'kind' = 'protected_entry'
            and manual_order -> 'entry' ->> 'instrument' = ${instrument}
        `
      ).map((row) => row.id),
    );
  }

  /** The latest AI decision of each of these strategies. */
  latestDecisions(scope: AccountScope, strategyIds: string[]) {
    type Latest = {
      at: Date;
      kind: "trade_proposal" | "no_trade";
      model: string;
    };
    if (!strategyIds.length) return Promise.resolve(new Map<string, Latest>());
    return this.#scoped(scope, async (tx) => {
      const rows = await tx<
        {
          strategy_id: string;
          created_at: Date;
          kind: Latest["kind"];
          model: string;
        }[]
      >`
        select distinct on (strategy_id) strategy_id, created_at, kind, model
        from ai_decisions
        where strategy_id in ${tx(strategyIds)}
        order by strategy_id, created_at desc, id
      `;
      return new Map(
        rows.map((row): [string, Latest] => [
          row.strategy_id,
          { at: row.created_at, kind: row.kind, model: row.model },
        ]),
      );
    });
  }

  /** How many decisions the AI has made for the strategy. */
  decisionCount(scope: AccountScope, strategyId: string) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await tx<{ count: number }[]>`
        select count(*)::int as count from ai_decisions
        where strategy_id = ${strategyId}
      `;
      return row.count;
    });
  }

  /**
   * Creates a strategy, running in simulation, from its first version and
   * its allocation. It needs the portfolio's daily drawdown limit set.
   */
  create(
    scope: AccountScope,
    draft: StrategyDraft,
    now: Date,
  ): Promise<ControlResult> {
    return this.#scoped(scope, async (tx) => {
      if (!(await latestPortfolioLimit(tx, scope)))
        return {
          result: "refused",
          message:
            "Set the portfolio's daily drawdown limit in Settings → Risk limits before starting a strategy.",
        };
      const id = randomUUID();
      await tx`
        insert into strategies (
          id, customer_id, exchange_account_id, name, status, current_version,
          next_analysis_at
        )
        values (
          ${id}, ${scope.customerId}, ${scope.exchangeAccountId}, ${draft.name},
          'simulation', 1, ${draft.ai ? now : null}
        )
      `;
      await insertVersion(tx, scope, id, 1, draft);
      await tx`
        insert into allocations
          (customer_id, exchange_account_id, strategy_id, currency, amount)
        values (
          ${scope.customerId}, ${scope.exchangeAccountId}, ${id}, 'USDT',
          ${draft.allocation}::numeric
        )
      `;
      await audit(tx, scope, id, "strategy.created", {
        actor: "customer",
        subjectType: "strategy",
        payload: versionPayload(draft, 1),
      });
      const [row] = await selectStrategies(tx, scope, { id });
      return {
        result: "saved",
        message: `${draft.name} is running.`,
        strategy: toRecord(row)!,
      };
    });
  }

  /**
   * Saves `draft` as the next version, made from `baseVersion`, and sets
   * the allocation. Entries keep the version they were made under. The
   * kind cannot change, and a completed strategy has no new versions.
   */
  newVersion(
    scope: AccountScope,
    strategyId: string,
    baseVersion: number,
    draft: StrategyDraft,
  ): Promise<ControlResult> {
    return this.#scoped(scope, async (tx) => {
      const [row] = await selectStrategies(tx, scope, {
        id: strategyId,
        lock: true,
      });
      const current = row && toRecord(row);
      if (!current)
        return { result: "refused", message: "There is no such strategy." };
      if (current.status === "retired")
        return {
          result: "refused",
          message: "This strategy has completed. Create a new one instead.",
        };
      if (current.version !== baseVersion)
        return {
          result: "conflict",
          message: `Version ${current.version} was saved since you started editing. Review it and edit again.`,
        };
      if (current.rules.kind !== draft.rules.kind)
        return {
          result: "refused",
          message:
            "A new version keeps the strategy's kind. Create a new strategy for another kind.",
        };
      const version = current.version + 1;
      await insertVersion(tx, scope, strategyId, version, draft);
      await tx`
        update strategies set name = ${draft.name}, current_version = ${version},
          rules_ended_at = null, rules_ended_reason = null, updated_at = now()
        where id = ${strategyId}
      `;
      await tx`
        update allocations set amount = ${draft.allocation}::numeric,
          updated_at = now()
        where strategy_id = ${strategyId}
      `;
      await audit(tx, scope, strategyId, "strategy.version_created", {
        actor: "customer",
        subjectType: "strategy",
        payload: {
          ...versionPayload(draft, version),
          previousAllocation: current.allocation,
        },
      });
      const [saved] = await selectStrategies(tx, scope, { id: strategyId });
      return {
        result: "saved",
        message: `Saved version ${version}. Open entries keep the version they were made under.`,
        strategy: toRecord(saved)!,
      };
    });
  }

  /**
   * Pauses the strategy: no new entries, and the worker cancels its pending
   * ones on its next pass. Open entries keep their exits and deadlines.
   */
  pause(scope: AccountScope, strategyId: string) {
    return this.#control(scope, strategyId, async (tx, current) => {
      if (current.status === "retired")
        return refused("This strategy has completed.");
      if (current.status === "paused")
        return refused("This strategy is already paused.");
      await stopStrategy(tx, scope, strategyId, {
        pauseReason: "customer",
        exitRequest: "pause",
      });
      await audit(tx, scope, strategyId, "strategy.paused", {
        actor: "customer",
        subjectType: "strategy",
        payload: { reason: "customer" },
      });
      return "Paused. Pending entries are being cancelled; open entries keep their take profit, stop loss and holding deadline.";
    });
  }

  /**
   * Pauses the strategy and closes everything it holds: the worker cancels
   * its pending entries and sells what its open entries hold at market.
   */
  closeAll(scope: AccountScope, strategyId: string) {
    return this.#control(scope, strategyId, async (tx, current) => {
      if (current.status === "retired")
        return refused("This strategy has completed and holds nothing.");
      await stopStrategy(tx, scope, strategyId, {
        pauseReason: current.status === "paused" ? undefined : "close_all",
        exitRequest: "close_all",
      });
      await audit(tx, scope, strategyId, "strategy.close_all", {
        actor: "customer",
        subjectType: "strategy",
        payload: {},
      });
      return "Closing everything: pending entries are being cancelled and open entries sold at market. The strategy stays paused.";
    });
  }

  /**
   * Resumes a paused strategy. The caller checks first that no loss limit,
   * and not the portfolio's drawdown limit, is still reached.
   */
  resume(scope: AccountScope, strategyId: string): Promise<ControlResult> {
    return this.#control(scope, strategyId, async (tx, current) => {
      if (current.status !== "paused")
        return refused(
          current.status === "retired"
            ? "This strategy has completed."
            : "This strategy is already running.",
        );
      if (!(await latestPortfolioLimit(tx, scope)))
        return refused(
          "Set the portfolio's daily drawdown limit in Settings → Risk limits before resuming a strategy.",
        );
      await tx`
        update strategies set status = 'simulation', pause_reason = null,
          paused_at = null, exit_request = null, updated_at = now(),
          next_analysis_at = case when next_analysis_at is null then null
            else greatest(next_analysis_at, now()) end
        where id = ${strategyId}
      `;
      await audit(tx, scope, strategyId, "strategy.resumed", {
        actor: "customer",
        subjectType: "strategy",
        payload: { pausedFor: current.pauseReason },
      });
      return "Resumed. The worker plans new entries on its next pass.";
    });
  }

  async #control(
    scope: AccountScope,
    strategyId: string,
    act: (
      tx: Transaction,
      current: StrategyRecord,
    ) => Promise<string | { refused: string }>,
  ): Promise<ControlResult> {
    return this.#scoped(scope, async (tx) => {
      const [row] = await selectStrategies(tx, scope, {
        id: strategyId,
        lock: true,
      });
      const current = row && toRecord(row);
      if (!current)
        return { result: "refused", message: "There is no such strategy." };
      const outcome = await act(tx, current);
      if (typeof outcome !== "string")
        return { result: "refused", message: outcome.refused };
      const [saved] = await selectStrategies(tx, scope, { id: strategyId });
      return { result: "saved", message: outcome, strategy: toRecord(saved)! };
    });
  }

  /**
   * The kill switch: pauses every strategy on the account, and closes every
   * protected entry the worker manages there, strategies' and the
   * customer's own from the dashboard or an approved proposal. Stop-limit
   * entries the worker holds are cancelled. Orders placed elsewhere, such
   * as with the CLI, are left alone. Audited, with a critical notification.
   */
  killSwitch(scope: AccountScope) {
    return this.#scoped(scope, async (tx) => {
      const strategies = await tx<{ id: string; status: StrategyStatus }[]>`
        select id, status from strategies
        where exchange_account_id = ${scope.exchangeAccountId}
          and status <> 'retired'
        order by created_at, id
        for update
      `;
      let paused = 0;
      let closing = 0;
      for (const strategy of strategies) {
        if (isRunning(strategy.status)) paused++;
        closing += await stopStrategy(tx, scope, strategy.id, {
          pauseReason: isRunning(strategy.status) ? "kill_switch" : undefined,
          exitRequest: "kill_switch",
        });
      }
      // The customer's own protected entries.
      const manual = await tx<{ id: string }[]>`
        select i.id from order_intents i
        left join trade_proposals p on p.id = i.proposal_id
        left join entry_reconciliations r on r.order_intent_id = i.id
        where i.exchange_account_id = ${scope.exchangeAccountId}
          and i.status = 'acknowledged'
          and i.manual_order ->> 'kind' = 'protected_entry'
          and p.strategy_id is null
          and (r.state is null or r.state not in ${tx(terminal)})
        order by i.created_at, i.id
      `;
      for (const { id } of manual)
        if (await requestExitIn(tx, scope, id, "kill_switch")) closing++;
      const triggers = await tx<{ id: string }[]>`
        update order_intents set status = 'cancelled', updated_at = now()
        where exchange_account_id = ${scope.exchangeAccountId}
          and status = 'pending'
        returning id
      `;
      for (const { id } of triggers)
        await audit(tx, scope, id, "order_intent.cancelled", {
          actor: "customer",
          payload: { reason: "kill_switch" },
        });
      const counts = {
        pausedStrategies: paused,
        closingEntries: closing,
        cancelledTriggers: triggers.length,
      };
      await audit(tx, scope, scope.exchangeAccountId, "kill_switch.activated", {
        actor: "customer",
        subjectType: "exchange_account",
        payload: counts,
      });
      await raiseNotification(tx, scope.customerId, {
        kind: "kill_switch",
        severity: "critical",
        title: "Kill switch used",
        body: `You used the kill switch. ${plural(paused, "strategy", "strategies")} paused, ${plural(closing, "entry", "entries")} being cancelled and sold at market, and ${plural(triggers.length, "held stop-limit entry", "held stop-limit entries")} cancelled. Resume each strategy when you are ready.`,
        data: counts,
      });
      return counts;
    });
  }

  /**
   * Stops a strategy that reached a loss limit: it is paused until the
   * customer resumes it, its pending entries are cancelled and its open
   * entries sold. The notification is raised once per breach.
   */
  lossLimitReached(
    scope: AccountScope,
    strategyId: string,
    detail: { limit: "daily" | "total"; loss: string; amount: string },
  ) {
    return this.#scoped(scope, async (tx) => {
      const [row] = await selectStrategies(tx, scope, {
        id: strategyId,
        lock: true,
      });
      const current = row && toRecord(row);
      if (!current || current.status === "retired") return false;
      if (current.exitRequest === "loss_limit") {
        // Already stopped; entries sent since then are stopped too.
        await requestStrategyExits(tx, scope, strategyId, "loss_limit", {
          unrequested: true,
        });
        return false;
      }
      await stopStrategy(tx, scope, strategyId, {
        pauseReason: isRunning(current.status) ? "loss_limit" : undefined,
        exitRequest: "loss_limit",
      });
      await audit(tx, scope, strategyId, "strategy.loss_limit_reached", {
        actor: "execution_worker",
        subjectType: "strategy",
        payload: detail,
      });
      await raiseNotification(tx, scope.customerId, {
        kind: "loss_limit_reached",
        severity: "critical",
        title: `${current.name} reached its ${detail.limit} loss limit`,
        body: `${current.name} has lost ${detail.loss} USDT${detail.limit === "daily" ? " since midnight UTC" : " in total"}, reaching its ${detail.limit} loss limit of ${detail.amount} USDT. The worker is cancelling its pending entries and selling what its open entries hold at market. It stays paused until you resume it${detail.limit === "total" ? ", which needs a new version with a higher total loss limit" : ""}.`,
        data: { strategyId, ...detail },
      });
      return true;
    });
  }

  /**
   * Pauses every running strategy on the account: the portfolio reached its
   * daily drawdown limit. Open entries keep their exits.
   */
  drawdownReached(
    scope: AccountScope,
    detail: { drawdownPercent: string; limitPercent: string; pnl: string },
  ) {
    return this.#scoped(scope, async (tx) => {
      const running = await tx<{ id: string; name: string }[]>`
        select id, name from strategies
        where exchange_account_id = ${scope.exchangeAccountId}
          and status in ${tx(RUNNING)}
        order by created_at, id
        for update
      `;
      if (!running.length) return 0;
      for (const strategy of running)
        await stopStrategy(tx, scope, strategy.id, {
          pauseReason: "drawdown",
          exitRequest: "pause",
        });
      await audit(
        tx,
        scope,
        scope.exchangeAccountId,
        "portfolio.drawdown_reached",
        {
          actor: "execution_worker",
          subjectType: "exchange_account",
          payload: {
            ...detail,
            paused: running.map((strategy) => strategy.id),
          },
        },
      );
      await raiseNotification(tx, scope.customerId, {
        kind: "drawdown_reached",
        severity: "critical",
        title: "Portfolio daily drawdown limit reached",
        body: `Your strategies have lost ${detail.drawdownPercent}% of their allocations since midnight UTC (${detail.pnl} USDT), reaching your limit of ${detail.limitPercent}%. The worker paused ${plural(running.length, "strategy", "strategies")} (${running.map((strategy) => strategy.name).join(", ")}) and is cancelling their pending entries. Open entries keep their exits.`,
        data: detail,
      });
      return running.length;
    });
  }

  /**
   * Applies a strategy's exit request to entries sent since it was made, so
   * an entry that was being sent when the customer paused is stopped too.
   */
  applyExitRequest(scope: AccountScope, strategyId: string, reason: string) {
    return this.#scoped(scope, (tx) =>
      requestStrategyExits(tx, scope, strategyId, reason, {
        unrequested: true,
      }),
    );
  }

  /** Cancels entries past their entry expiry that have not filled completely. */
  expire(scope: AccountScope, orderIntentIds: string[]) {
    if (!orderIntentIds.length) return Promise.resolve(0);
    return this.#scoped(scope, async (tx) => {
      let expired = 0;
      for (const id of orderIntentIds)
        if (await requestExitIn(tx, scope, id, "entry_expired")) expired++;
      return expired;
    });
  }

  /**
   * Records that the rules open no more entries. With `exitRequest`, such
   * as when a grid leaves its range, everything it holds is closed too.
   */
  endRules(
    scope: AccountScope,
    strategyId: string,
    reason: string,
    exitRequest?: string,
  ) {
    return this.#scoped(scope, async (tx) => {
      const [ended] = await tx<{ name: string }[]>`
        update strategies set rules_ended_at = now(),
          rules_ended_reason = ${reason},
          exit_request = coalesce(${exitRequest ?? null}, exit_request),
          updated_at = now()
        where id = ${strategyId} and rules_ended_at is null
          and status <> 'retired'
        returning name
      `;
      if (!ended) return;
      if (exitRequest)
        await requestStrategyExits(tx, scope, strategyId, exitRequest);
      await audit(tx, scope, strategyId, "strategy.rules_ended", {
        actor: "execution_worker",
        subjectType: "strategy",
        payload: { reason },
      });
    });
  }

  /**
   * Completes a strategy whose rules open no more entries once it holds
   * nothing. Resolves whether it completed.
   */
  complete(scope: AccountScope, strategyId: string) {
    return this.#scoped(scope, async (tx) => {
      const [done] = await tx<{ name: string; reason: string }[]>`
        update strategies s set status = 'retired', completed_at = now(),
          updated_at = now()
        where s.id = ${strategyId} and s.status <> 'retired'
          and s.rules_ended_at is not null
          and not exists (
            select from trade_proposals p
            join order_intents i on i.proposal_id = p.id
            left join entry_reconciliations r on r.order_intent_id = i.id
            where p.strategy_id = s.id
              and i.status not in ${tx(NOT_PLACED)}
              and (r.state is null or r.state not in ${tx(terminal)})
          )
        returning s.name, s.rules_ended_reason as reason
      `;
      if (!done) return false;
      await audit(tx, scope, strategyId, "strategy.completed", {
        actor: "execution_worker",
        subjectType: "strategy",
        payload: { reason: done.reason },
      });
      await raiseNotification(tx, scope.customerId, {
        kind: "strategy_completed",
        severity: "info",
        title: `${done.name} completed`,
        body: `${done.name} will open no more entries (${ENDED_LABELS[done.reason] ?? done.reason.replace(/_/g, " ")}) and holds nothing, so it has completed.`,
        data: { strategyId },
      });
      return true;
    });
  }

  /**
   * Releases the budget of the strategy's entries that ended, and commits
   * that of entries that filled, so its reservations follow its entries.
   */
  settleReservations(scope: AccountScope, strategyId: string) {
    return this.#scoped(scope, async (tx) => {
      const [allocation] = await tx<{ id: string }[]>`
        select id from allocations where strategy_id = ${strategyId}
      `;
      if (allocation) await sweepReservations(tx, strategyId, allocation.id);
    });
  }

  /** Keeps the worker's note on the strategy, if it changed. */
  note(scope: AccountScope, strategyId: string, note: string) {
    return this.#scoped(scope, async (tx) => {
      await tx`
        update strategies set runner_note = ${note.slice(0, 500)},
          runner_checked_at = now()
        where id = ${strategyId}
          and (runner_note <> ${note.slice(0, 500)}
            or runner_checked_at is null
            or runner_checked_at < now() - interval '1 minute')
      `;
    });
  }

  /**
   * Claims an AI-managed strategy's analysis due at `now`, moving the next
   * one an interval on. Resolves false if it is not due, or another worker
   * claimed it.
   */
  claimAnalysis(
    scope: AccountScope,
    strategyId: string,
    now: Date,
    intervalMinutes: number,
  ) {
    return this.#scoped(scope, async (tx) => {
      const [claimed] = await tx<{ id: string }[]>`
        update strategies set
          next_analysis_at = ${new Date(now.getTime() + intervalMinutes * 60_000)}
        where id = ${strategyId} and status in ${tx(RUNNING)}
          and (next_analysis_at is null or next_analysis_at <= ${now})
        returning id
      `;
      return Boolean(claimed);
    });
  }

  /** Tells the customer that an AI proposal waits for their approval. */
  awaitingApproval(
    scope: AccountScope,
    strategy: StrategyRecord,
    proposal: { id: string; summary: string },
  ) {
    return this.#scoped(scope, (tx) =>
      raiseNotification(tx, scope.customerId, {
        kind: "proposal_awaiting_approval",
        severity: "info",
        title: `${strategy.name} proposes a trade`,
        body: `${proposal.summary} It waits for your approval on Activity, and the worker checks it against ${strategy.name}'s limits again when you approve it.`,
        data: { strategyId: strategy.id, proposalId: proposal.id },
      }),
    );
  }

  notify(scope: AccountScope, notification: NewNotification) {
    return this.#scoped(scope, (tx) =>
      raiseNotification(tx, scope.customerId, notification),
    );
  }

  /**
   * Checks an entry against the strategy's current version, allocation,
   * reserved budget and limits with `authorizeTradeProposal`, and if it
   * passes, reserves its budget and saves its proposal and order intent, in
   * one transaction. The strategy's row and allocation stay locked until it
   * commits, so concurrent reservations, and a pause, wait for each other.
   * Then the caller sends the entry. Nothing is sent if this refuses.
   */
  reserve(
    scope: AccountScope,
    candidate: EntryCandidate,
    now: Date,
  ): Promise<Reservation> {
    return this.#scoped(scope, async (tx) => {
      const refuse = (reason: string, waits = false): Reservation => ({
        status: "refused",
        reason,
        waits,
      });
      const [row] = await selectStrategies(tx, scope, {
        id: candidate.strategyId,
        lock: true,
      });
      const strategy = row && toRecord(row);
      if (!strategy) return refuse("There is no such strategy.");
      if (!isRunning(strategy.status))
        return refuse(
          strategy.status === "paused"
            ? "The strategy is paused."
            : "The strategy has completed.",
        );
      if (strategy.rulesEndedAt && !candidate.draft)
        return refuse("The strategy's rules open no more entries.");
      const { intent } = candidate;
      // One strategy owns an instrument's position on an account.
      await tx`
        select pg_advisory_xact_lock(hashtextextended(${`position:${scope.exchangeAccountId}:${intent.instrument}`}, 0))
      `;
      const [allocation] = await tx<{ id: string; amount: string }[]>`
        select id, amount::text from allocations
        where strategy_id = ${strategy.id}
      `;
      const budget = await sweepReservations(tx, strategy.id, allocation.id);
      const entries = (await selectEntries(tx, scope, [strategy.id]))
        .flatMap((entry) => toEntry(entry) ?? [])
        .filter(isUnclosed);
      if (!candidate.draft) {
        if (
          candidate.key !== "ai" &&
          entries.some((entry) => entry.key === candidate.key)
        )
          return refuse(`The strategy already holds ${candidate.key}.`);
        if (candidate.once) {
          const [made] = await tx`
            select 1 from trade_proposals
            where strategy_id = ${strategy.id} and entry_key = ${candidate.key}
          `;
          if (made) return refuse(`${candidate.key} was made already.`);
        }
      }
      const [owner] = await tx<{ name: string }[]>`
        select s.name from trade_proposals p
        join strategies s on s.id = p.strategy_id
        join order_intents i on i.proposal_id = p.id
        left join entry_reconciliations r on r.order_intent_id = i.id
        where p.exchange_account_id = ${scope.exchangeAccountId}
          and p.instrument = ${intent.instrument}
          and p.strategy_id <> ${strategy.id}
          and i.status not in ${tx(NOT_PLACED)}
          and (r.state is null or r.state not in ${tx(terminal)})
        union all
        select s.name from position_ownership o
        join strategies s on s.id = o.strategy_id
        where o.exchange_account_id = ${scope.exchangeAccountId}
          and o.instrument = ${intent.instrument}
          and o.status in ('open', 'closing')
          and o.strategy_id <> ${strategy.id}
        limit 1
      `;
      if (owner)
        return refuse(
          `${owner.name} holds the ${intent.instrument.replace("-", "/")} position on this account; a strategy waits until it holds nothing there.`,
          true,
        );
      if (candidate.freeStopOrders <= 0)
        return refuse(
          `Binance's limit on open stop orders for ${intent.instrument.replace("-", "/")} is full, so the entry could not be protected.`,
          true,
        );
      const limits = ruleLimits(strategy.rules);
      const positionNotionalByInstrument: Partial<
        Record<TestnetInstrument, string>
      > = {};
      for (const entry of entries)
        positionNotionalByInstrument[entry.instrument] = new Decimal(
          positionNotionalByInstrument[entry.instrument] ?? 0,
        )
          .plus(new Decimal(entry.quantity).times(entry.entryPrice))
          .toFixed();
      const { proposalId } = candidate;
      if (candidate.draft) {
        const version = await draftVersion(tx, proposalId);
        if (version !== strategy.version)
          return refuse(
            `The proposal was made under version ${version}, and the strategy is now at version ${strategy.version}. Its next analysis uses the new version.`,
          );
      }
      const proposal = entryIntentProposal(intent, {
        proposalId,
        customerId: scope.customerId,
        exchangeAccountId: scope.exchangeAccountId,
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        sourceSnapshotId: candidate.sourceSnapshotId,
        rationale: candidate.rationale,
      });
      const authorization = authorizeTradeProposal(
        proposal,
        {
          customerId: scope.customerId,
          exchangeAccountId: scope.exchangeAccountId,
          strategyId: strategy.id,
          strategyVersion: strategy.version,
          // Binance Spot Testnet funds are virtual: simulated trading.
          tradingMode: "simulation",
          strategyStatus: strategy.status as "simulation" | "active",
          liveTradingEnabled: false,
          allowedInstruments: limits.allowedInstruments,
          allocation: plain(allocation.amount),
          committedCapital: budget.committed,
          reservedBudget: budget.reserved,
          maxPositionNotional: limits.maxPositionNotional,
          maxLeverage: limits.maxLeverage,
          marketKind: limits.marketKind,
          allowedDirections: limits.allowedDirections,
          // The lower of the rules' limit and what Binance can protect.
          maxProtectedEntries: Math.min(
            limits.maxProtectedEntries,
            entries.length + candidate.freeStopOrders,
          ),
          protectedEntries: entries.length,
          positionNotionalByInstrument,
        },
        now,
      );
      if (!authorization.allowed) return refuse(authorization.reason);
      const [{ attempt }] = await tx<{ attempt: number }[]>`
        select coalesce(max(entry_attempt), 0)::int + 1 as attempt
        from trade_proposals
        where strategy_id = ${strategy.id} and entry_key = ${candidate.key}
      `;
      if (candidate.draft) {
        const [claimed] = await tx`
          update trade_proposals set
            status = ${candidate.draft.decidedBy === "customer" ? "approved" : "authorized"},
            decided_at = ${now}, decided_by = ${candidate.draft.decidedBy},
            entry_key = ${candidate.key}, entry_attempt = ${attempt}
          where id = ${proposalId} and strategy_id = ${strategy.id}
            and status = 'draft' and entry_expires_at > ${now}
          returning id
        `;
        if (!claimed) return refuse("The proposal is no longer a draft.");
      } else
        await tx`
          insert into trade_proposals (
            id, customer_id, exchange_account_id, strategy_id,
            strategy_version, source_snapshot_id, instrument, market_kind,
            direction, quantity, entry_price, stop_loss_price,
            take_profit_price, leverage, entry_expires_at, rationale, status,
            decided_at, decided_by, entry_key, entry_attempt, created_at
          )
          values (
            ${proposalId}, ${scope.customerId}, ${scope.exchangeAccountId},
            ${strategy.id}, ${strategy.version}, ${candidate.sourceSnapshotId},
            ${intent.instrument}, ${intent.marketKind}, ${intent.direction},
            ${intent.quantity}::numeric, ${intent.entryPrice}::numeric,
            ${intent.stopLossPrice}::numeric, ${intent.takeProfitPrice}::numeric,
            ${intent.leverage}, ${intent.entryExpiresAt}::timestamptz,
            ${candidate.rationale}, 'authorized', ${now}, 'execution_checks',
            ${candidate.key}, ${attempt}, ${now}
          )
        `;
      await tx`
        insert into budget_reservations
          (customer_id, allocation_id, proposal_id, amount, status)
        values (
          ${scope.customerId}, ${allocation.id}, ${proposalId},
          ${authorization.reservationAmount}::numeric, 'held'
        )
      `;
      const entry: ProtectedEntry = {
        instrument: intent.instrument as TestnetInstrument,
        quantity: intent.quantity,
        price: intent.entryPrice,
        timeInForce: "GTC",
        takeProfitPrice: intent.takeProfitPrice,
        stopLossPrice: intent.stopLossPrice,
        listClientOrderId: strategyEntryClientOrderId(proposalId),
      };
      const saved = await insertOrderIntent(
        tx,
        scope,
        { kind: "protected_entry", entry },
        "strategy",
        { proposalId },
      );
      // Rolls the reservation back too, so nothing is sent.
      if (!saved)
        throw new Error(
          `The client order ID for proposal ${proposalId} was used before.`,
        );
      await audit(tx, scope, proposalId, "budget.reserved", {
        actor: "execution_worker",
        subjectType: "trade_proposal",
        payload: {
          strategyId: strategy.id,
          strategyVersion: proposal.strategyVersion,
          key: candidate.key,
          amount: authorization.reservationAmount,
          allocation: plain(allocation.amount),
          committed: budget.committed,
          reserved: budget.reserved,
        },
      });
      return { status: "saved", proposalId, entry };
    });
  }

  /** The latest portfolio drawdown limit. */
  portfolioLimits(scope: AccountScope): Promise<PortfolioLimitsState> {
    return this.#scoped(scope, async (tx) => ({
      current: (await latestPortfolioLimit(tx, scope)) ?? null,
    }));
  }

  /**
   * Saves a new portfolio drawdown limit as version `baseVersion + 1`, if
   * `baseVersion` is still the latest, and audits it.
   */
  changePortfolioLimits(
    scope: AccountScope,
    maxDailyDrawdownPercent: string,
    baseVersion: number,
  ): Promise<{ saved: boolean; limits: PortfolioLimitsState }> {
    return this.#scoped(scope, async (tx) => {
      await tx`
        select pg_advisory_xact_lock(hashtextextended(${`portfolio-limits:${scope.exchangeAccountId}`}, 0))
      `;
      const previous = await latestPortfolioLimit(tx, scope);
      if ((previous?.version ?? 0) !== baseVersion)
        return { saved: false, limits: { current: previous ?? null } };
      const [row] = await tx<{ id: string }[]>`
        insert into portfolio_risk_limits (
          customer_id, exchange_account_id, version, max_daily_drawdown_percent
        )
        values (
          ${scope.customerId}, ${scope.exchangeAccountId}, ${baseVersion + 1},
          ${maxDailyDrawdownPercent}::numeric
        )
        returning id
      `;
      await audit(tx, scope, row.id, "portfolio_limits.changed", {
        actor: "customer",
        subjectType: "portfolio_risk_limits",
        payload: {
          version: baseVersion + 1,
          maxDailyDrawdownPercent,
          previous: previous?.maxDailyDrawdownPercent ?? null,
        },
      });
      return {
        saved: true,
        limits: { current: (await latestPortfolioLimit(tx, scope)) ?? null },
      };
    });
  }
}

/** Why a strategy's rules open no more entries, for the customer. */
export const ENDED_LABELS: Record<string, string> = {
  expired: "its entries expired",
  schedule_complete: "its DCA schedule ended",
  all_entries_filled: "every entry filled",
  range_stop: "the market reached the range stop",
  above_range: "the market rose above the range",
};

function refused(message: string) {
  return { refused: message };
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** PostgreSQL numeric → plain decimal string. */
function plain(value: string) {
  return new Decimal(value).toFixed();
}

function versionPayload(
  draft: StrategyDraft,
  version: number,
): Record<string, JSONValue> {
  return {
    version,
    name: draft.name,
    allocation: draft.allocation,
    rules: draft.rules as unknown as JSONValue,
    ai: draft.ai,
  };
}

async function insertVersion(
  tx: Transaction,
  scope: AccountScope,
  strategyId: string,
  version: number,
  draft: StrategyDraft,
) {
  await tx`
    insert into strategy_versions (
      customer_id, strategy_id, version, rules, proposal_approval,
      analysis_interval_minutes
    )
    values (
      ${scope.customerId}, ${strategyId}, ${version},
      ${tx.json(draft.rules as unknown as JSONValue)},
      ${draft.ai?.proposalApproval ?? null},
      ${draft.ai?.analysisIntervalMinutes ?? null}
    )
  `;
}

/**
 * Pauses a strategy if `pauseReason` is set, and asks the worker to stop
 * its entries with `exitRequest`, now and on every pass until the customer
 * resumes it. A stronger request replaces a pause; nothing replaces another.
 * Resolves how many entries it stopped now.
 */
async function stopStrategy(
  tx: Transaction,
  scope: AccountScope,
  strategyId: string,
  { pauseReason, exitRequest }: { pauseReason?: string; exitRequest: string },
) {
  await tx`
    update strategies set
      status = case when ${pauseReason ?? null}::text is not null
        and status in ${tx(RUNNING)} then 'paused' else status end,
      pause_reason = case when ${pauseReason ?? null}::text is not null
        and status in ${tx(RUNNING)} then ${pauseReason ?? null} else pause_reason end,
      paused_at = case when ${pauseReason ?? null}::text is not null
        and status in ${tx(RUNNING)} then now() else paused_at end,
      exit_request = case when exit_request is null or exit_request = 'pause'
        then ${exitRequest} else exit_request end,
      updated_at = now()
    where id = ${strategyId}
  `;
  const [{ exit_request: request }] = await tx<{ exit_request: string }[]>`
    select exit_request from strategies where id = ${strategyId}
  `;
  return (await requestStrategyExits(tx, scope, strategyId, request)).length;
}

/**
 * Releases the reservations of entries that ended or were never placed, and
 * marks those of entries that filled as committed. Resolves what the
 * allocation still has reserved for pending entries and committed to open
 * ones, at their entry prices.
 */
async function sweepReservations(
  tx: Transaction,
  strategyId: string,
  allocationId: string,
) {
  await tx`
    update budget_reservations b set status = 'released', released_at = now()
    from trade_proposals p
    join order_intents i on i.proposal_id = p.id
    left join entry_reconciliations r on r.order_intent_id = i.id
    where b.proposal_id = p.id and p.strategy_id = ${strategyId}
      and b.status <> 'released'
      and (i.status in ${tx(NOT_PLACED)} or r.state in ${tx(terminal)})
  `;
  await tx`
    update budget_reservations b set status = 'committed'
    from trade_proposals p
    join order_intents i on i.proposal_id = p.id
    join entry_reconciliations r on r.order_intent_id = i.id
    where b.proposal_id = p.id and p.strategy_id = ${strategyId}
      and b.status = 'held' and r.filled_quantity > 0
  `;
  const [sums] = await tx<{ reserved: string; committed: string }[]>`
    select
      coalesce(sum(amount) filter (where status = 'held'), 0)::text as reserved,
      coalesce(sum(amount) filter (where status = 'committed'), 0)::text as committed
    from budget_reservations
    where allocation_id = ${allocationId} and status <> 'released'
  `;
  return { reserved: plain(sums.reserved), committed: plain(sums.committed) };
}

async function draftVersion(tx: Transaction, proposalId: string) {
  const [row] = await tx<{ strategy_version: number | null }[]>`
    select strategy_version from trade_proposals where id = ${proposalId}
  `;
  return row?.strategy_version ?? 0;
}

async function latestPortfolioLimit(tx: Transaction, scope: AccountScope) {
  const [row] = await tx<
    { version: number; percent: string; created_at: Date }[]
  >`
    select version, max_daily_drawdown_percent::text as percent, created_at
    from portfolio_risk_limits
    where exchange_account_id = ${scope.exchangeAccountId}
    order by version desc
    limit 1
  `;
  return row
    ? {
        version: row.version,
        maxDailyDrawdownPercent: plain(row.percent),
        createdAt: row.created_at.toISOString(),
      }
    : undefined;
}

type EntryRow = {
  id: string;
  strategy_id: string;
  strategy_version: number;
  entry_key: string | null;
  entry_attempt: number | null;
  instrument: string;
  quantity: string;
  entry_price: string;
  stop_loss_price: string;
  take_profit_price: string;
  entry_expires_at: Date;
  status: string;
  created_at: Date;
  intent_id: string | null;
  idempotency_key: string | null;
  intent_status: OrderIntentStatus | null;
  state: EntryState | null;
  filled: string;
  exit_reason: string | null;
};

function selectEntries(
  tx: Transaction,
  scope: AccountScope,
  strategyIds: string[],
) {
  return tx<EntryRow[]>`
    select p.id, p.strategy_id, p.strategy_version, p.entry_key,
      p.entry_attempt, p.instrument, p.quantity::text, p.entry_price::text,
      p.stop_loss_price::text, p.take_profit_price::text, p.entry_expires_at,
      p.status, p.created_at, i.id as intent_id, i.idempotency_key,
      i.status as intent_status, r.state,
      coalesce(r.filled_quantity, 0)::text as filled, r.exit_reason
    from trade_proposals p
    left join order_intents i on i.proposal_id = p.id
    left join entry_reconciliations r on r.order_intent_id = i.id
    where p.strategy_id in ${tx(strategyIds)}
      and p.exchange_account_id = ${scope.exchangeAccountId}
    order by p.created_at, p.id
  `;
}

function toEntry(row: EntryRow): StrategyEntry | undefined {
  const instrument = testnetInstrumentSchema.safeParse(row.instrument);
  if (!instrument.success) return undefined;
  return {
    proposalId: row.id,
    strategyId: row.strategy_id,
    version: row.strategy_version,
    key: row.entry_key,
    attempt: row.entry_attempt,
    instrument: instrument.data,
    quantity: plain(row.quantity),
    entryPrice: plain(row.entry_price),
    stopLossPrice: plain(row.stop_loss_price),
    takeProfitPrice: plain(row.take_profit_price),
    entryExpiresAt: row.entry_expires_at,
    proposalStatus: row.status,
    createdAt: row.created_at,
    orderIntentId: row.intent_id,
    listClientOrderId: row.idempotency_key,
    intentStatus: row.intent_status,
    state: row.state,
    filled: plain(row.filled),
    exitReason: row.exit_reason,
  };
}
