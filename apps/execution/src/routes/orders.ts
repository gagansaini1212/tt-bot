import {
  listClientOrderIdSchema,
  manualCancelRequestSchema,
  manualOrderRequestSchema,
  triggerCancelRequestSchema,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import { handler } from "../http";
import {
  loadManualTradingConfig,
  ManualOrderDesk,
  RiskLimitsNotSet,
  serializer,
  type Serializer,
} from "../manual-orders";
import type { OrderIntentStore } from "../order-intents";
import type { RiskLimitStore } from "../risk-limits";
import type { TradeProposalStore } from "../trade-proposals";

/**
 * The worker's dashboard order desks, or none while dashboard orders are
 * off. There is a desk per Binance client, which changes when an account's
 * keys do. The routes and the execution loop share them, and they share one
 * queue, so placements, approved proposals and cancels run one at a time.
 */
export function deskProvider({
  env,
  now,
  onChange,
  intents,
  proposals,
  risk,
  exclusive = serializer(),
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
  exclusive?: Serializer;
}) {
  const loaded = loadManualTradingConfig(env);
  const desks = new WeakMap<BinanceSpotTestnet, ManualOrderDesk>();
  return {
    disabledMessage: loaded.ok ? "" : loaded.message,
    deskFor(exchange: BinanceSpotTestnet) {
      if (!loaded.ok) return undefined;
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
          exclusive,
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
  const disabled = { status: "rejected" as const, message: disabledMessage };
  return {
    ticket: handler({
      query: z.strictObject({}),
      async handle({ exchange, account }) {
        const desk = deskFor(exchange);
        if (!desk) return { status: "connected", disabled: disabledMessage };
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
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk ? await desk.place(account, body) : disabled,
        };
      },
    }),
    status: handler({
      query: z.strictObject({ listClientOrderId: listClientOrderIdSchema }),
      async handle({ exchange, query, account }) {
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk
            ? await desk.status(account, query.listClientOrderId)
            : disabled,
        };
      },
    }),
    cancelTrigger: handler({
      query: z.strictObject({}),
      body: triggerCancelRequestSchema,
      async handle({ exchange, body, account }) {
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk
            ? await desk.cancelTrigger(account, body.listClientOrderId)
            : disabled,
        };
      },
    }),
    cancel: handler({
      query: z.strictObject({}),
      body: manualCancelRequestSchema,
      async handle({ exchange, body, account }) {
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk ? await desk.cancel(account, body) : disabled,
        };
      },
    }),
  };
}
