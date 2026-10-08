// Browser-safe: what the execution worker's loop reports to the dashboard.
import { z } from "zod";
import {
  listClientOrderIdSchema,
  positiveDecimal,
  testnetInstrumentSchema,
} from "./order-rules";

const decimal = z.string().regex(/^\d+(\.\d+)?$/);

/**
 * Why the worker is selling an entry's quantity:
 * - protection_failed: it held quantity no stop loss protected, such as a
 *   filled entry whose exits Binance dropped, or a partly filled entry that
 *   was cancelled.
 * - stop_loss: a partly filled entry's market reached its stop loss. Binance
 *   places exits only once an entry fills completely, so the worker sells.
 * - take_profit: the take profit partly filled and Binance cancelled the
 *   stop loss, so the worker sells the rest.
 * - holding_deadline: the entry reached its holding deadline.
 * Other reasons come from callers of the worker's exit request, such as a
 * strategy's close all.
 */
export const exitReasonSchema = z.string().regex(/^[a-z_]{1,40}$/);

/** A protected entry that holds quantity the worker is selling, or must. */
export const entryAlertSchema = z.object({
  listClientOrderId: listClientOrderIdSchema,
  instrument: testnetInstrumentSchema,
  state: z.enum(["unprotected", "exiting", "protected", "partly_filled"]),
  heldQuantity: decimal,
  exitReason: exitReasonSchema.nullable(),
  detail: z.string().max(500),
  // The worker gave up selling it automatically. The customer must act.
  closeBlocked: z.boolean(),
  // Set when the entry is past its holding deadline and still held.
  overdueSince: z.iso.datetime().nullable(),
  since: z.iso.datetime(),
});
export type EntryAlert = z.infer<typeof entryAlertSchema>;

/** A stop-limit entry the worker holds until its stop price trades. */
export const stopTriggerSchema = z.object({
  listClientOrderId: listClientOrderIdSchema,
  instrument: testnetInstrumentSchema,
  stopPrice: positiveDecimal,
  price: positiveDecimal,
  quantity: positiveDecimal,
  takeProfitPrice: positiveDecimal,
  stopLossPrice: positiveDecimal,
  createdAt: z.iso.datetime(),
});
export type StopTrigger = z.infer<typeof stopTriggerSchema>;

export const notificationSeveritySchema = z.enum([
  "info",
  "warning",
  "critical",
]);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/** An in-app notification, newest first. */
export const notificationSchema = z.object({
  id: z.uuid(),
  kind: z.string().max(60),
  severity: notificationSeveritySchema,
  title: z.string().max(200),
  body: z.string().max(1000),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const executionStateSchema = z.object({
  // When the worker's loop last finished checking this customer's orders,
  // or null if it has not since it started.
  checkedAt: z.iso.datetime().nullable(),
  alerts: z.array(entryAlertSchema),
  triggers: z.array(stopTriggerSchema),
  notifications: z.array(notificationSchema),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

export const triggerCancelRequestSchema = z.strictObject({
  listClientOrderId: listClientOrderIdSchema,
});
export type TriggerCancelRequest = z.infer<typeof triggerCancelRequestSchema>;
