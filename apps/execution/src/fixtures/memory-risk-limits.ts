import Decimal from "decimal.js";
import {
  protectedLegIds,
  type ManualRiskLimits,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "../accounts";
import {
  manualOrderRisk,
  type RiskLimitStore,
  type RiskLimitsChangeResult,
  type RiskLimitsVersion,
} from "../risk-limits";
import type { MemoryOrderIntents } from "./memory-order-intents";

/** Limits that let the order tests' orders through. */
export const TEST_RISK_LIMITS: ManualRiskLimits = {
  maxOrderNotional: "100",
  maxDailyRisk: "1000",
  defaultStopLossPercent: "2",
};

const ENDED_UNFILLED = new Set([
  "CANCELED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
  "REJECTED",
]);

/**
 * An in-memory RiskLimitStore for tests of the worker's order logic.
 * risk-limits.test.ts proves the PostgreSQL store behaves the same way. With
 * `limits`, every account starts at version 1 with them; with `intents`,
 * daily risk is measured from that store's entries.
 */
export class MemoryRiskLimits implements RiskLimitStore {
  readonly #versions = new Map<string, RiskLimitsVersion[]>();
  readonly #initial?: ManualRiskLimits;
  readonly #intents?: MemoryOrderIntents;

  constructor({
    limits,
    intents,
  }: { limits?: ManualRiskLimits; intents?: MemoryOrderIntents } = {}) {
    this.#initial = limits;
    this.#intents = intents;
  }

  #list(scope: AccountScope) {
    let list = this.#versions.get(scope.exchangeAccountId);
    if (!list) {
      list = this.#initial
        ? [{ ...this.#initial, version: 1, createdAt: new Date(0) }]
        : [];
      this.#versions.set(scope.exchangeAccountId, list);
    }
    return list;
  }

  async current(scope: AccountScope) {
    return this.#list(scope).at(-1);
  }

  async change(
    scope: AccountScope,
    limits: ManualRiskLimits,
    baseVersion: number,
  ): Promise<RiskLimitsChangeResult> {
    const list = this.#list(scope);
    const current = list.at(-1);
    if ((current?.version ?? 0) !== baseVersion)
      return { status: "conflict", current };
    const saved = {
      ...limits,
      version: baseVersion + 1,
      createdAt: new Date(),
    };
    list.push(saved);
    return { status: "saved", limits: saved };
  }

  async dailyRiskUsed(scope: AccountScope, since: Date, excluding?: string) {
    let used = new Decimal(0);
    for (const intent of this.#intents?.intents.values() ?? []) {
      if (
        intent.scope.exchangeAccountId !== scope.exchangeAccountId ||
        intent.createdAt < since ||
        intent.status === "rejected" ||
        intent.status === "cancelled" ||
        intent.clientOrderId === excluding
      )
        continue;
      const sent = this.#intents?.orders.get(
        intent.order.kind === "protected_entry"
          ? protectedLegIds(intent.clientOrderId).entry
          : intent.clientOrderId,
      );
      if (
        sent &&
        ENDED_UNFILLED.has(sent.status) &&
        new Decimal(sent.executedQty).isZero()
      )
        continue;
      used = used.plus(manualOrderRisk(intent.order));
    }
    return used.toFixed();
  }
}
