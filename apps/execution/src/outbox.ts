import {
  withCustomerScope,
  type Database,
  type JSONValue,
} from "@crypto-trading/database";

export type OutboxJob = {
  id: string;
  topic: string;
  payload: Record<string, JSONValue>;
  attempts: number;
  lastError: string | null;
};

/** How long a claimed job is hidden from other workers while one handles it. */
export const JOB_LEASE_MS = 2 * 60_000;

/**
 * Claims up to `limit` of a customer's due, unfinished jobs on `topic`. A
 * claim leases the job: it is not due again until the lease ends, so two
 * workers never handle it at once, and a worker that dies mid-job leaves it
 * to be retried. Finish each job with `completeJob` or `retryJob`.
 */
export function claimDueJobs(
  database: Database,
  customerId: string,
  topic: string,
  now: Date,
  { limit = 20, leaseMs = JOB_LEASE_MS } = {},
): Promise<OutboxJob[]> {
  return withCustomerScope(database, customerId, async (tx) => {
    const rows = await tx<
      {
        id: string;
        topic: string;
        payload: Record<string, JSONValue>;
        attempts: number;
        last_error: string | null;
      }[]
    >`
      update outbox_jobs set
        available_at = ${new Date(now.getTime() + leaseMs)},
        attempts = attempts + 1
      where id in (
        select id from outbox_jobs
        where topic = ${topic} and completed_at is null and available_at <= ${now}
        order by available_at, id
        limit ${limit}
        for update skip locked
      )
      returning id, topic, payload, attempts, last_error
    `;
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      lastError: row.last_error,
    }));
  });
}

export function completeJob(
  database: Database,
  customerId: string,
  id: string,
) {
  return withCustomerScope(
    database,
    customerId,
    (tx) => tx`
      update outbox_jobs set completed_at = now(), last_error = null
      where id = ${id} and completed_at is null
    `,
  );
}

/** Makes a claimed job due again after `delayMs`, noting why it failed. */
export function retryJob(
  database: Database,
  customerId: string,
  id: string,
  error: string,
  { now, delayMs }: { now: Date; delayMs: number },
) {
  return withCustomerScope(
    database,
    customerId,
    (tx) => tx`
      update outbox_jobs set
        available_at = ${new Date(now.getTime() + delayMs)},
        last_error = ${error}
      where id = ${id} and completed_at is null
    `,
  );
}

/** Waits longer after each failed attempt, up to 15 minutes. */
export function retryDelay(attempts: number) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}
