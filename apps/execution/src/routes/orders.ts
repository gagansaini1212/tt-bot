import {
  canTrade,
  listClientOrderIdSchema,
  manualCancelRequestSchema,
  manualOrderRequestSchema,
  triggerCancelRequestSchema,
  venueFor,
  type AccountAdapter,
  type TradingAdapter,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import type { AccountScope } from "../accounts";
import { handler } from "../http";
import {
  accountQueues,
  loadManualTradingConfig,
  ManualOrderDesk,
  RiskLimitsNotSet,
  type AccountQueues,
} from "../manual-orders";
import type { OrderIntentStore } from "../order-intents";
import type { RiskLimitStore } from "../risk-limits";
import type { TradeProposalStore } from "../trade-proposals";

/**
 * The worker's dashboard order desks, or none while dashboard orders are
 * off or the account is read only. There is a desk per account's client,
 * which changes when the account's keys do. The routes and the execution
 * loop share them, and each account's desks share its queue, so its
 * placements, approved proposals and cancels run one at a time, and never
 * wait for another account's.
 */
export function deskProvider({
  env,
  now,
  onChange,
  intents,
  proposals,
  risk,
  exclusive = accountQueues(),
}: {
  env: NodeJS.ProcessEnv;
  now: () => number;
  onChange: () => void;
  intents: OrderIntentStore;
  proposals?: TradeProposalStore;
  risk: Pick<
    RiskLimitStore,
    "current" | "dailyRiskUsed" | "allowedInstruments"
  >;
  // Shared with the strategy runner, so its placements wait for these.
  exclusive?: AccountQueues;
}) {
  const loaded = loadManualTradingConfig(env);
  const desks = new WeakMap<TradingAdapter, ManualOrderDesk>();
  return {
    /** Why `deskFor` has no desk for `exchange`. */
    disabledMessage(exchange: AccountAdapter) {
      if (!canTrade(exchange))
        return `${venueFor(exchange.venue).name} is read only here, so it takes no orders (ADR 0009).`;
      return loaded.ok ? "" : loaded.message;
    },
    deskFor(exchange: AccountAdapter, account: AccountScope) {
      if (!loaded.ok || !canTrade(exchange)) return undefined;
      let desk = desks.get(exchange);
      if (!desk) {
        desk = new ManualOrderDesk({
          exchange,
          config: loaded.config,
          intents,
          proposals,
          risk,
          now: () => new Date(now()),
          onChange,
          exclusive: exclusive(account),
        });
        desks.set(exchange, desk);
      }
      return desk;
    },
  };
}

/**
 * Dashboard orders: a ticket for the preview, placement, lookup by client ID
 * and cancellation, including of stop-limit entries the worker holds. Every
 * placement is checked again here. Without explicit limits in the
 * environment, orders stay off and these routes say why.
 */
export function orders({
  deskFor,
  disabledMessage,
}: ReturnType<typeof deskProvider>) {
  const disabled = (exchange: AccountAdapter) => ({
    status: "rejected" as const,
    message: disabledMessage(exchange),
  });
  return {
    ticket: handler({
      query: z.strictObject({}),
      async handle({ exchange, account }) {
        const desk = deskFor(exchange, account);
        if (!desk)
          return { status: "connected", disabled: disabledMessage(exchange) };
        try {
          return { status: "connected", ticket: await desk.ticket(account) };
        } catch (error) {
          if (error instanceof RiskLimitsNotSet)
            return { status: "connected", disabled: error.message };
          throw error;
        }
      },
    }),
    place: handler({
      query: z.strictObject({}),
      body: manualOrderRequestSchema,
      async handle({ exchange, body, account }) {
        const desk = deskFor(exchange, account);
        return {
          status: "connected",
          outcome: desk ? await desk.place(account, body) : disabled(exchange),
        };
      },
    }),
    status: handler({
      query: z.strictObject({ listClientOrderId: listClientOrderIdSchema }),
      async handle({ exchange, query, account }) {
        const desk = deskFor(exchange, account);
        return {
          status: "connected",
          outcome: desk
            ? await desk.status(account, query.listClientOrderId)
            : disabled(exchange),
        };
      },
    }),
    cancelTrigger: handler({
      query: z.strictObject({}),
      body: triggerCancelRequestSchema,
      async handle({ exchange, body, account }) {
        const desk = deskFor(exchange, account);
        return {
          status: "connected",
          outcome: desk
            ? await desk.cancelTrigger(account, body.listClientOrderId)
            : disabled(exchange),
        };
      },
    }),
    cancel: handler({
      query: z.strictObject({}),
      body: manualCancelRequestSchema,
      async handle({ exchange, body, account }) {
        const desk = deskFor(exchange, account);
        return {
          status: "connected",
          outcome: desk ? await desk.cancel(account, body) : disabled(exchange),
        };
      },
    }),
  };
}
