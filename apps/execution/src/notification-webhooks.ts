import {
  withCustomerScope,
  type Database,
  type Transaction,
} from "@crypto-trading/database";
import {
  MAX_NOTIFICATIONS,
  parseWebhookUrl,
  type Notification,
  type WebhookChange,
  type WebhookKind,
  type WebhookStatus,
  type WebhookTest,
} from "@crypto-trading/exchanges";
import { z } from "zod";
import { recentNotifications } from "./notifications";
import { completeJob, retryDelay, retryJob, type OutboxJob } from "./outbox";
import { MASTER_KEY_VARIABLE, type SecretBox } from "./secret-box";

/**
 * Outbox topic for delivering one notification to one webhook. A trigger on
 * `notifications` queues a job per webhook whenever a notification is
 * written (migration 20261008170300_notification_webhooks).
 */
export const WEBHOOK_TOPIC = "notification.webhook";

/**
 * What one attempt achieved:
 * - completed: delivered, or nothing is left to deliver because the webhook
 *   or notification is gone (`note` says which).
 * - retry: worth trying again later, at `retryAfterMs` at the earliest if
 *   the destination asked for that.
 * - failed: the destination refused it for good, such as a deleted webhook.
 *
 * Errors are safe to store and log: they never include the webhook URL.
 */
export type JobOutcome =
  | { status: "completed"; note?: string }
  | { status: "retry"; error: string; retryAfterMs?: number }
  | { status: "failed"; error: string };

const jobPayloadSchema = z.object({
  notificationId: z.uuid(),
  webhookId: z.uuid(),
});

type Message = { severity: string; title: string; body: string };
type Posted =
  | { ok: true }
  | { ok: false; retry: boolean; error: string; retryAfterMs?: number };

const DISCORD_MAX = 2000;
const TELEGRAM_MAX = 4096;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

function truncate(text: string, length: number) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

/** The text a webhook posts for a notification. */
export function webhookText(kind: WebhookKind, message: Message) {
  const severity =
    message.severity.charAt(0).toUpperCase() + message.severity.slice(1);
  const text =
    kind === "discord"
      ? `**${severity}: ${message.title}**\n${message.body}`
      : `${severity}: ${message.title}\n${message.body}`;
  return truncate(text, kind === "discord" ? DISCORD_MAX : TELEGRAM_MAX);
}

/** The request that posts `message` to a validated webhook URL. */
export function webhookRequest(
  kind: WebhookKind,
  url: string,
  message: Message,
): { url: string; body: object } {
  const text = webhookText(kind, message);
  if (kind === "discord")
    // Mentions in the text never ping anyone.
    return { url, body: { content: text, allowed_mentions: { parse: [] } } };
  const parsed = new URL(url);
  const chat = parsed.searchParams.get("chat_id")!;
  const thread = parsed.searchParams.get("message_thread_id");
  return {
    url: `${parsed.origin}${parsed.pathname}`,
    body: {
      // Telegram takes a numeric ID or "@channel". IDs beyond 2^53 stay
      // strings, which it also accepts, so none loses digits.
      chat_id: Number.isSafeInteger(Number(chat)) ? Number(chat) : chat,
      ...(thread ? { message_thread_id: Number(thread) } : {}),
      text,
      link_preview_options: { is_disabled: true },
    },
  };
}

// The associated data binding a sealed URL to its webhook.
function context(customerId: string, webhookId: string) {
  return ["notification_webhooks", customerId, webhookId, "url"];
}

type WebhookRow = {
  id: string;
  kind: WebhookKind;
  encrypted_url: Buffer;
  url_last4: string;
  updated_at: Date;
};

/**
 * A customer's Discord or Telegram webhook, its delivery jobs and their
 * notification history. The URL is sealed with the master key and never
 * logged, returned or stored in the clear.
 */
export class NotificationWebhooks {
  readonly #database: Database;
  readonly #box: SecretBox | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor({
    database,
    box,
    fetch: fetcher = fetch,
    timeoutMs = 10_000,
  }: {
    database: Database;
    box: SecretBox | undefined;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#database = database;
    this.#box = box;
    this.#fetch = fetcher;
    this.#timeoutMs = timeoutMs;
  }

  #scoped<T>(customerId: string, work: (tx: Transaction) => Promise<T>) {
    return withCustomerScope(this.#database, customerId, work);
  }

  async status(customerId: string): Promise<WebhookStatus> {
    const [row] = await this.#scoped(
      customerId,
      (tx) => tx<WebhookRow[]>`
        select id, kind, url_last4, updated_at from notification_webhooks
      `,
    );
    return {
      webhook: row
        ? {
            kind: row.kind,
            last4: row.url_last4,
            updatedAt: row.updated_at.toISOString(),
          }
        : null,
      canSave: this.#box !== undefined,
    };
  }

  /** Validates and saves the customer's webhook, replacing any other. */
  async save(customerId: string, value: string): Promise<WebhookChange> {
    const parsed = parseWebhookUrl(value);
    if (!parsed.ok)
      return {
        result: "invalid",
        message: parsed.message,
        status: await this.status(customerId),
      };
    const box = this.#box;
    if (!box)
      return {
        result: "unavailable",
        message: `The execution worker cannot save webhooks until ${MASTER_KEY_VARIABLE} is set.`,
        status: await this.status(customerId),
      };
    await this.#scoped(customerId, async (tx) => {
      // The URL is sealed for this webhook's ID, so take the ID first.
      const [existing] = await tx<{ id: string }[]>`
        select id from notification_webhooks for update
      `;
      const [{ id }] = existing
        ? [existing]
        : await tx<{ id: string }[]>`select gen_random_uuid() as id`;
      const sealed = box.seal(parsed.url, context(customerId, id));
      await tx`
        insert into notification_webhooks
          (id, customer_id, kind, encrypted_url, url_last4)
        values (${id}, ${customerId}, ${parsed.kind}, ${sealed}, ${parsed.last4})
        on conflict (customer_id) do update set
          kind = excluded.kind,
          encrypted_url = excluded.encrypted_url,
          url_last4 = excluded.url_last4,
          updated_at = now()
      `;
      await audit(tx, customerId, id, "notification_webhook.saved", {
        kind: parsed.kind,
        last4: parsed.last4,
      });
    });
    return {
      result: "saved",
      message:
        "Saved. New alerts will be posted there. Send a test to check it.",
      status: await this.status(customerId),
    };
  }

  async remove(customerId: string): Promise<WebhookChange> {
    await this.#scoped(customerId, async (tx) => {
      const [row] = await tx<{ id: string; kind: string }[]>`
        delete from notification_webhooks returning id, kind
      `;
      if (row)
        await audit(tx, customerId, row.id, "notification_webhook.removed", {
          kind: row.kind,
        });
    });
    return {
      result: "removed",
      message: "Removed. Alerts stay in the history here.",
      status: await this.status(customerId),
    };
  }

  /** Posts a test message to the saved webhook now, outside the outbox. */
  async sendTest(customerId: string): Promise<WebhookTest> {
    const [row] = await this.#scoped(
      customerId,
      (tx) => tx<WebhookRow[]>`
        select id, kind, encrypted_url from notification_webhooks
      `,
    );
    if (!row) return { result: "failed", message: "Save a webhook URL first." };
    const url = this.#open(customerId, row);
    if (!url)
      return {
        result: "failed",
        message: `The saved webhook cannot be opened. Check ${MASTER_KEY_VARIABLE} in the execution worker, or save the URL again.`,
      };
    const posted = await this.#post(row.kind, url, {
      severity: "info",
      title: "Test alert",
      body: "Crypto Trading Agent alerts will arrive here. Testnet only: no real funds are involved.",
    });
    return posted.ok
      ? { result: "delivered", message: `Delivered to ${label(row.kind)}.` }
      : { result: "failed", message: posted.error };
  }

  /**
   * The handler for the customer's WEBHOOK_TOPIC jobs: one delivery attempt.
   * The execution loop claims the jobs and settles each with
   * `settleDelivery`.
   */
  async deliver(customerId: string, job: OutboxJob): Promise<JobOutcome> {
    const payload = jobPayloadSchema.safeParse(job.payload);
    if (job.topic !== WEBHOOK_TOPIC || !payload.success)
      return { status: "failed", error: "The job is not a webhook delivery." };
    const { notificationId, webhookId } = payload.data;
    const { webhook, notification } = await this.#scoped(
      customerId,
      async (tx) => {
        const [webhook] = await tx<WebhookRow[]>`
          select id, kind, encrypted_url from notification_webhooks
          where id = ${webhookId}
        `;
        const [notification] = await tx<Message[]>`
          select severity, title, body from notifications
          where id = ${notificationId}
        `;
        return { webhook, notification };
      },
    );
    if (!webhook)
      return { status: "completed", note: "The webhook was removed." };
    if (!notification)
      return { status: "completed", note: "The notification is gone." };
    const url = this.#open(customerId, webhook);
    // The master key may come back, so this is worth retrying.
    if (!url)
      return {
        status: "retry",
        error: `The webhook URL cannot be opened. Check ${MASTER_KEY_VARIABLE}.`,
      };
    const posted = await this.#post(webhook.kind, url, notification);
    if (posted.ok) return { status: "completed" };
    if (!posted.retry) return { status: "failed", error: posted.error };
    return posted.retryAfterMs === undefined
      ? { status: "retry", error: posted.error }
      : {
          status: "retry",
          error: posted.error,
          retryAfterMs: posted.retryAfterMs,
        };
  }

  #open(customerId: string, row: Pick<WebhookRow, "id" | "encrypted_url">) {
    try {
      return this.#box?.open(row.encrypted_url, context(customerId, row.id));
    } catch {
      return undefined;
    }
  }

  async #post(
    kind: WebhookKind,
    url: string,
    message: Message,
  ): Promise<Posted> {
    const request = webhookRequest(kind, url, message);
    const name = label(kind);
    let response: Response;
    try {
      response = await this.#fetch(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Transport errors can name the URL, so they are never passed on.
      return {
        ok: false,
        retry: true,
        error: `${name} could not be reached.`,
      };
    }
    if (response.ok) return { ok: true };
    const retryAfterMs = await retryAfter(response);
    const status = response.status;
    const retry = status === 408 || status === 429 || status >= 500;
    return {
      ok: false,
      retry,
      retryAfterMs,
      error:
        status === 429
          ? `${name} is limiting requests (HTTP 429).`
          : retry
            ? `${name} is unavailable (HTTP ${status}).`
            : status === 401 || status === 403 || status === 404
              ? `${name} refused the webhook (HTTP ${status}). It may have been deleted, or its token or chat is wrong. Save a new URL.`
              : `${name} refused the message (HTTP ${status}).`,
    };
  }
}

function label(kind: WebhookKind) {
  return kind === "discord" ? "Discord" : "Telegram";
}

// Discord sends Retry-After in seconds; Telegram sends parameters.retry_after.
async function retryAfter(response: Response) {
  let seconds = Number(response.headers.get("retry-after"));
  if (!(seconds > 0)) {
    const body = await response
      .json()
      .catch(() => undefined)
      .then(
        (value) =>
          z
            .object({ parameters: z.object({ retry_after: z.number() }) })
            .safeParse(value).data,
      );
    seconds = body?.parameters.retry_after ?? NaN;
  }
  return seconds > 0
    ? Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS)
    : undefined;
}

function audit(
  tx: Transaction,
  customerId: string,
  subjectId: string,
  eventType: string,
  payload: Record<string, string>,
) {
  return tx`
    insert into audit_events
      (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
    values (
      ${customerId}, 'customer', ${customerId}, ${eventType},
      'notification_webhook', ${subjectId}, ${tx.json(payload)}
    )
  `;
}

/** The customer's latest in-app notifications, newest first. */
export function notificationHistory(
  database: Database,
  customerId: string,
): Promise<Notification[]> {
  return withCustomerScope(database, customerId, (tx) =>
    recentNotifications(tx, { limit: MAX_NOTIFICATIONS }),
  );
}

/** Marks every unread notification of the customer read. */
export async function markNotificationsRead(
  database: Database,
  customerId: string,
) {
  await withCustomerScope(
    database,
    customerId,
    (tx) => tx`update notifications set read_at = now() where read_at is null`,
  );
}

/** Attempts before a delivery is given up. */
export const MAX_WEBHOOK_ATTEMPTS = 8;

/**
 * Records a delivery attempt's outcome on its claimed job. A retry waits
 * with the outbox's backoff, and never sooner than the destination asked.
 * After MAX_WEBHOOK_ATTEMPTS, or a refusal for good, the job is completed
 * with its last error and audited as failed.
 */
export async function settleDelivery(
  database: Database,
  customerId: string,
  job: OutboxJob,
  outcome: JobOutcome,
  now: Date,
) {
  if (outcome.status === "completed")
    return completeJob(database, customerId, job.id);
  if (outcome.status === "retry" && job.attempts < MAX_WEBHOOK_ATTEMPTS)
    return retryJob(database, customerId, job.id, outcome.error, {
      now,
      delayMs: Math.max(retryDelay(job.attempts), outcome.retryAfterMs ?? 0),
    });
  const error =
    outcome.status === "retry"
      ? `Gave up after ${job.attempts} attempts. ${outcome.error}`
      : outcome.error;
  await withCustomerScope(database, customerId, async (tx) => {
    const [given] = await tx`
      update outbox_jobs set completed_at = now(), last_error = ${error}
      where id = ${job.id} and completed_at is null
      returning id
    `;
    if (given)
      await tx`
        insert into audit_events
          (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
        values (
          ${customerId}, 'execution_worker', 'execution-worker',
          'notification_webhook.delivery_failed', 'outbox_job', ${job.id},
          ${tx.json({ ...job.payload, attempts: job.attempts, error })}
        )
      `;
  });
}
