import "server-only";
import {
  manualOrderOutcomeSchema,
  manualOrderTicketSchema,
  type ManualCancelRequest,
  type ManualOrderOutcome,
  type ManualOrderRequest,
  type ManualOrderTicket,
} from "@crypto-trading/exchanges/manual-order";
import { z } from "zod";
import { callWorkerForCustomer, type WorkerFailure } from "./worker-client";

export type OrderTicketState =
  | { status: "ready"; ticket: ManualOrderTicket }
  | { status: "unavailable"; message: string };

const outcomeResponse = z.object({ outcome: manualOrderOutcomeSchema });

export async function getOrderTicket(): Promise<OrderTicketState> {
  const result = await callWorkerForCustomer({
    path: "/orders/ticket",
    schema: z.union([
      z.object({ ticket: manualOrderTicketSchema }),
      // The worker turns dashboard orders off until their limits are set.
      z.object({ disabled: z.string().max(500) }),
    ]),
  });
  if (result.status !== "connected")
    return { status: "unavailable", message: result.message };
  return "ticket" in result.data
    ? { status: "ready", ticket: result.data.ticket }
    : { status: "unavailable", message: result.data.disabled };
}

/**
 * A write's outcome when the worker did not confirm it. A missing token, an
 * invalid URL, no signed-in customer, a worker that could not act for this
 * customer or a refused body mean the order never reached Binance. After any
 * other failure it may have.
 */
function writeFailure(
  failure: WorkerFailure,
  listClientOrderId?: string,
): ManualOrderOutcome {
  const sent = ![
    "missing_token",
    "invalid_url",
    "signed_out",
    "worker_not_configured",
    "no_exchange_account",
    "database_unavailable",
    "invalid_request",
  ].includes(failure.reason);
  return sent
    ? {
        status: "unknown",
        listClientOrderId,
        message: listClientOrderId
          ? "The execution worker did not confirm the order, so it may or may not have been placed. Check its status before placing another order."
          : "The execution worker did not confirm the request. Refresh to see the order's current state.",
      }
    : { status: "rejected", message: failure.message };
}

export async function submitOrder(
  request: ManualOrderRequest,
): Promise<ManualOrderOutcome> {
  const result = await callWorkerForCustomer({
    method: "POST",
    path: "/orders",
    body: request,
    schema: outcomeResponse,
  });
  return result.status === "connected"
    ? result.data.outcome
    : writeFailure(result, request.listClientOrderId);
}

export async function getOrderStatus(
  listClientOrderId: string,
): Promise<ManualOrderOutcome> {
  const result = await callWorkerForCustomer({
    path: "/orders/status",
    query: { listClientOrderId },
    schema: outcomeResponse,
  });
  return result.status === "connected"
    ? result.data.outcome
    : {
        status: "unknown",
        listClientOrderId,
        message: `${result.message} The order's status is still unknown.`,
      };
}

export async function cancelOrder(
  request: ManualCancelRequest,
): Promise<ManualOrderOutcome> {
  const result = await callWorkerForCustomer({
    method: "POST",
    path: "/orders/cancel",
    body: request,
    schema: outcomeResponse,
  });
  return result.status === "connected"
    ? result.data.outcome
    : writeFailure(result);
}
