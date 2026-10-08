import {
  listClientOrderIdSchema,
  manualCancelRequestSchema,
  manualOrderRequestSchema,
  triggerCancelRequestSchema,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import { handler } from "../http";
import { loadManualTradingConfig, ManualOrderDesk } from "../manual-orders";
import type { OrderIntentStore } from "../order-intents";

/**
 * The worker's one dashboard order desk, or undefined while dashboard orders
 * are off. The exchange is the same for every caller, so the desk and its
 * queue are shared by the routes and the execution loop.
 */
export function deskProvider({
  env,
  now,
  onChange,
  intents,
}: {
  env: NodeJS.ProcessEnv;
  now: () => number;
  onChange: () => void;
  intents: OrderIntentStore;
}) {
  const loaded = loadManualTradingConfig(env);
  let desk: ManualOrderDesk | undefined;
  return {
    disabledMessage: loaded.ok ? "" : loaded.message,
    deskFor(exchange: BinanceSpotTestnet) {
      if (!loaded.ok) return undefined;
      desk ??= new ManualOrderDesk({
        exchange,
        config: loaded.config,
        intents,
        now: () => new Date(now()),
        onChange,
      });
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
        return desk
          ? { status: "connected", ticket: await desk.ticket(account) }
          : { status: "connected", disabled: disabledMessage };
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
