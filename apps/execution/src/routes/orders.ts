import {
  listClientOrderIdSchema,
  manualCancelRequestSchema,
  manualOrderRequestSchema,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import { handler } from "../http";
import { loadManualTradingConfig, ManualOrderDesk } from "../manual-orders";
import type { OrderIntentStore } from "../order-intents";

/**
 * Dashboard orders: a ticket for the preview, placement, lookup by client ID
 * and cancellation. Every placement is checked again here. Without explicit
 * limits in the environment, orders stay off and these routes say why.
 */
export function orders({
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
  // The exchange is the same for every request; the desk keeps its queue.
  const deskFor = (exchange: BinanceSpotTestnet) => {
    if (!loaded.ok) return undefined;
    desk ??= new ManualOrderDesk({
      exchange,
      config: loaded.config,
      intents,
      now: () => new Date(now()),
      onChange,
    });
    return desk;
  };
  const disabledMessage = loaded.ok ? "" : loaded.message;
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
