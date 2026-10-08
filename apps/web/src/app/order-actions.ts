"use server";

import { refresh } from "next/cache";
import {
  manualCancelRequestSchema,
  manualOrderRequestSchema,
  type ManualOrderOutcome,
} from "@crypto-trading/exchanges/manual-order";
import { listClientOrderIdSchema } from "@crypto-trading/exchanges/order-rules";

import { isLocalRequest } from "@/lib/local-request";
import {
  cancelOrder,
  cancelTrigger,
  getOrderStatus,
  getOrderTicket,
  submitOrder,
  type OrderTicketState,
} from "@/lib/orders";

// These actions trade on the connected testnet account, so they refuse any
// request that is not from this machine. The worker re-checks every order.
const REFUSED = "Orders can only be placed from the dashboard on this machine.";

export async function loadOrderTicket(): Promise<OrderTicketState> {
  if (!(await isLocalRequest()))
    return { status: "unavailable", message: REFUSED };
  return getOrderTicket();
}

export async function placeOrder(input: unknown): Promise<ManualOrderOutcome> {
  if (!(await isLocalRequest()))
    return { status: "rejected", message: REFUSED };
  const request = manualOrderRequestSchema.safeParse(input);
  if (!request.success)
    return {
      status: "invalid",
      message:
        "The order is incomplete or invalid. Enter a quantity, a stop loss and a take profit.",
    };
  const outcome = await submitOrder(request.data);
  refresh();
  return outcome;
}

export async function checkOrderStatus(
  input: unknown,
): Promise<ManualOrderOutcome> {
  if (!(await isLocalRequest()))
    return { status: "rejected", message: REFUSED };
  const id = listClientOrderIdSchema.safeParse(input);
  if (!id.success)
    return { status: "invalid", message: "The order ID is invalid." };
  const outcome = await getOrderStatus(id.data);
  refresh();
  return outcome;
}

export async function cancelOpenOrder(
  input: unknown,
): Promise<ManualOrderOutcome> {
  if (!(await isLocalRequest()))
    return { status: "rejected", message: REFUSED };
  const request = manualCancelRequestSchema.safeParse(input);
  if (!request.success)
    return { status: "invalid", message: "The cancel request is invalid." };
  const outcome = await cancelOrder(request.data);
  refresh();
  return outcome;
}

export async function cancelStopLimit(
  input: unknown,
): Promise<ManualOrderOutcome> {
  if (!(await isLocalRequest()))
    return { status: "rejected", message: REFUSED };
  const id = listClientOrderIdSchema.safeParse(input);
  if (!id.success)
    return { status: "invalid", message: "The order ID is invalid." };
  const outcome = await cancelTrigger(id.data);
  refresh();
  return outcome;
}
