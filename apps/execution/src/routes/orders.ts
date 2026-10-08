import {
  listClientOrderIdSchema,
  manualCancelRequestSchema,
  manualOrderRequestSchema,
  type BinanceSpotTestnet,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import { handler } from "../http";
import { loadManualTradingConfig, ManualOrderDesk } from "../manual-orders";
import { OrderJournal } from "../order-journal";

/**
 * Dashboard orders: a ticket for the preview, placement, lookup by client ID
 * and cancellation. Every placement is checked again here. Without explicit
 * limits in the environment, orders stay off and these routes say why.
 */
export function orders({
  env,
  now,
  onChange,
}: {
  env: NodeJS.ProcessEnv;
  now: () => number;
  onChange: () => void;
}) {
  const loaded = loadManualTradingConfig(env);
  const journal = new OrderJournal(env.TESTNET_ORDER_JOURNAL_DIR);
  let desk: ManualOrderDesk | undefined;
  // The exchange is the same for every request; the desk keeps its queue.
  const deskFor = (exchange: BinanceSpotTestnet) => {
    if (!loaded.ok) return undefined;
    desk ??= new ManualOrderDesk({
      exchange,
      config: loaded.config,
      journal,
      now: () => new Date(now()),
      onChange,
    });
    return desk;
  };
  const off = loaded.ok ? "" : loaded.message;
  const disabled = { status: "rejected" as const, message: off };
  return {
    ticket: handler({
      query: z.strictObject({}),
      async handle({ exchange }) {
        const desk = deskFor(exchange);
        return desk
          ? { status: "connected", ticket: await desk.ticket() }
          : { status: "connected", disabled: off };
      },
    }),
    place: handler({
      query: z.strictObject({}),
      body: manualOrderRequestSchema,
      async handle({ exchange, body }) {
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk ? await desk.place(body) : disabled,
        };
      },
    }),
    status: handler({
      query: z.strictObject({ listClientOrderId: listClientOrderIdSchema }),
      async handle({ exchange, query }) {
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk ? await desk.status(query.listClientOrderId) : disabled,
        };
      },
    }),
    cancel: handler({
      query: z.strictObject({}),
      body: manualCancelRequestSchema,
      async handle({ exchange, body }) {
        const desk = deskFor(exchange);
        return {
          status: "connected",
          outcome: desk ? await desk.cancel(body) : disabled,
        };
      },
    }),
  };
}
