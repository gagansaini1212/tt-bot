import type { JSONValue, Transaction } from "@crypto-trading/database";
import type {
  Notification,
  NotificationSeverity,
} from "@crypto-trading/exchanges";

/**
 * Outbox topic for delivering notifications elsewhere, such as to webhooks.
 * Every notification the worker raises queues one job with this topic, in
 * the same transaction, whose payload is `{ notificationId }`. A consumer
 * claims due jobs with `claimDueJobs` in outbox.ts, delivers the
 * notification, and completes the job.
 */
export const NOTIFICATION_TOPIC = "notification.created";

/**
 * What the execution worker tells a customer about:
 * - protection_failed (critical): an entry holds quantity no stop loss
 *   protects, and the worker is selling it.
 * - close_failed (critical): the worker could not sell such quantity.
 * - exit_overdue (critical): an entry is past its holding deadline and still
 *   held.
 * - stop_loss_reached (warning): a partly filled entry reached its stop loss,
 *   so the worker is selling what it bought.
 * - handed_over, dust_left, order_missing, stop_limit_failed (warning).
 * - position_closed, holding_deadline_reached, stop_limit_sent, exit_started
 *   (info).
 */
export type NotificationKind =
  | "protection_failed"
  | "close_failed"
  | "exit_overdue"
  | "stop_loss_reached"
  | "handed_over"
  | "dust_left"
  | "order_missing"
  | "stop_limit_failed"
  | "position_closed"
  | "holding_deadline_reached"
  | "stop_limit_sent"
  | "exit_started";

export type NewNotification = {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  data?: Record<string, JSONValue>;
};

/**
 * Saves an in-app notification and queues its delivery, in the caller's
 * customer-scoped transaction. Raise it in the same transaction as the change
 * it reports, so it is raised exactly once.
 */
export async function raiseNotification(
  tx: Transaction,
  customerId: string,
  notification: NewNotification,
) {
  const [row] = await tx<{ id: string }[]>`
    insert into notifications (customer_id, kind, severity, title, body, data)
    values (
      ${customerId}, ${notification.kind}, ${notification.severity},
      ${notification.title}, ${notification.body}, ${tx.json(notification.data ?? {})}
    )
    returning id
  `;
  await tx`
    insert into outbox_jobs (customer_id, topic, deduplication_key, payload)
    values (
      ${customerId}, ${NOTIFICATION_TOPIC}, ${`${NOTIFICATION_TOPIC}:${row.id}`},
      ${tx.json({ notificationId: row.id })}
    )
  `;
  return row.id;
}

/** The customer's latest notifications, newest first. */
export async function recentNotifications(
  tx: Transaction,
  { limit = 10, since }: { limit?: number; since?: Date } = {},
): Promise<Notification[]> {
  const rows = await tx<
    {
      id: string;
      kind: string;
      severity: NotificationSeverity;
      title: string;
      body: string;
      created_at: Date;
      read_at: Date | null;
    }[]
  >`
    select id, kind, severity, title, body, created_at, read_at
    from notifications
    where created_at >= coalesce(${since ?? null}::timestamptz, '-infinity')
    order by created_at desc, id
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  }));
}
