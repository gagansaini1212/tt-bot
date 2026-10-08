import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, mock, test } from "node:test";
import { withCustomerScope, type Database } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import {
  markNotificationsRead,
  MAX_WEBHOOK_ATTEMPTS,
  notificationHistory,
  NotificationWebhooks,
  settleDelivery,
  WEBHOOK_TOPIC,
  webhookRequest,
  webhookText,
} from "./notification-webhooks";
import { SecretBox } from "./secret-box";
import { claimDueJobs } from "./outbox";

const discordToken =
  "Zx9_yW8-vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8bA7zY6xW5vU4tS3rQ2pO1nM0lKa1b2";
const discord = `https://discord.com/api/webhooks/123456789012345678/${discordToken}`;
const telegramToken = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";
const telegram = `https://api.telegram.org/bot${telegramToken}/sendMessage?chat_id=-1001234567890&message_thread_id=7`;
const secrets = new RegExp(`${discordToken}|${telegramToken}`);
// Jobs are due by PostgreSQL's clock and claimed by this one, which may be a
// little behind it, as on CI.
const soon = () => new Date(Date.now() + 5_000);

test("Discord posts never ping anyone, and long alerts are cut to fit", () => {
  const request = webhookRequest("discord", discord, {
    severity: "critical",
    title: "Protection failed",
    body: "@everyone " + "x".repeat(3000),
  });
  assert.equal(request.url, discord);
  const body = request.body as { content: string; allowed_mentions: unknown };
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.content.length, 2000);
  assert.match(body.content, /^\*\*Critical: Protection failed\*\*\n@everyone/);
});

test("Telegram posts send the chat in the body to the bare method URL", () => {
  const request = webhookRequest("telegram", telegram, {
    severity: "warning",
    title: "Order unknown",
    body: "Check it.",
  });
  assert.equal(
    request.url,
    `https://api.telegram.org/bot${telegramToken}/sendMessage`,
  );
  assert.deepEqual(request.body, {
    chat_id: -1001234567890,
    message_thread_id: 7,
    text: "Warning: Order unknown\nCheck it.",
    link_preview_options: { is_disabled: true },
  });
  assert.equal(
    (
      webhookRequest(
        "telegram",
        telegram.replace("-1001234567890", "@alerts_channel"),
        { severity: "info", title: "t", body: "b" },
      ).body as { chat_id: unknown }
    ).chat_id,
    "@alerts_channel",
  );
  // Beyond 2^53 a number would lose digits, so the ID stays a string.
  assert.equal(
    (
      webhookRequest(
        "telegram",
        telegram.replace("-1001234567890", "12345678901234567890"),
        { severity: "info", title: "t", body: "b" },
      ).body as { chat_id: unknown }
    ).chat_id,
    "12345678901234567890",
  );
  assert.equal(
    webhookText("telegram", {
      severity: "info",
      title: "t",
      body: "x".repeat(5000),
    }).length,
    4096,
  );
});

describe("webhooks in PostgreSQL", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  const box = new SecretBox(randomBytes(32));

  async function customer() {
    const customerId = randomUUID();
    await withCustomerScope(
      database.app,
      customerId,
      (tx) =>
        tx`insert into customers (id, display_name) values (${customerId}, 'Test')`,
    );
    return customerId;
  }
  // As the execution worker raises an alert: in the customer's scope.
  async function notify(customerId: string, title = "Exits missing") {
    const [row] = await withCustomerScope(
      database.app,
      customerId,
      (tx) => tx<{ id: string }[]>`
        insert into notifications (customer_id, kind, severity, title, body)
        values (${customerId}, 'protection_failed', 'critical', ${title}, 'Sell it now.')
        returning id
      `,
    );
    return row.id;
  }
  const jobs = (db: Database, customerId: string) =>
    db<
      {
        id: string;
        deduplication_key: string;
        payload: { notificationId: string; webhookId: string };
        attempts: number;
        completed_at: Date | null;
        available_at: Date;
        last_error: string | null;
      }[]
    >`
      select * from outbox_jobs
      where customer_id = ${customerId} and topic = ${WEBHOOK_TOPIC}
      order by available_at
    `;
  function responder(respond: (url: string, body: unknown) => Response) {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      return respond(url, body);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  test("a webhook URL is validated, sealed at rest and shown only by its last four characters", async () => {
    const customerId = await customer();
    const webhooks = new NotificationWebhooks({ database: database.app, box });
    const refused = await webhooks.save(customerId, "https://example.com/hook");
    assert.equal(refused.result, "invalid");
    assert.equal(refused.status.webhook, null);
    const locked = new NotificationWebhooks({
      database: database.app,
      box: undefined,
    });
    assert.equal(
      (await locked.save(customerId, discord)).result,
      "unavailable",
    );
    assert.equal((await locked.status(customerId)).canSave, false);

    const saved = await webhooks.save(customerId, discord);
    assert.equal(saved.result, "saved");
    assert.deepEqual(
      { ...saved.status.webhook, updatedAt: undefined },
      { kind: "discord", last4: "a1b2", updatedAt: undefined },
    );
    assert.equal(
      (await webhooks.save(customerId, telegram)).status.webhook?.kind,
      "telegram",
    );
    const rows =
      await database.admin`select * from notification_webhooks where customer_id = ${customerId}`;
    assert.equal(rows.length, 1);
    const events =
      await database.admin`select payload from audit_events where customer_id = ${customerId}`;
    for (const value of [rows, events])
      assert.doesNotMatch(
        JSON.stringify(value) +
          (rows[0].encrypted_url as Buffer).toString("latin1"),
        secrets,
      );
    assert.doesNotMatch(JSON.stringify(saved), secrets);
  });

  test("each new notification queues one delivery per webhook, in the writer's transaction", async () => {
    const customerId = await customer();
    const other = await customer();
    const before = await notify(customerId);
    assert.equal((await jobs(database.admin, customerId)).length, 0);
    const webhooks = new NotificationWebhooks({ database: database.app, box });
    await webhooks.save(customerId, discord);
    assert.ok((await webhooks.status(customerId)).webhook);
    const notificationId = await notify(customerId);
    await notify(other);
    const queued = await jobs(database.admin, customerId);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].payload.notificationId, notificationId);
    assert.notEqual(queued[0].payload.notificationId, before);
    assert.equal(queued[0].completed_at, null);
    assert.equal((await jobs(database.admin, other)).length, 0);
  });

  test("an alert is saved even when its webhook delivery cannot be queued", async () => {
    const customerId = await customer();
    await new NotificationWebhooks({ database: database.app, box }).save(
      customerId,
      discord,
    );
    await database.admin`revoke insert on outbox_jobs from trading_app`;
    try {
      const id = await notify(customerId, "Saved anyway");
      const [saved] =
        await database.admin`select title from notifications where id = ${id}`;
      assert.equal(saved.title, "Saved anyway");
      assert.equal((await jobs(database.admin, customerId)).length, 0);
    } finally {
      await database.admin`grant insert on outbox_jobs to trading_app`;
    }
  });

  test("delivery completes, retries or fails by the destination's answer, never naming the URL", async () => {
    const customerId = await customer();
    let answer: () => Response = () => new Response(null, { status: 204 });
    const { calls, fetch } = responder(() => answer());
    const webhooks = new NotificationWebhooks({
      database: database.app,
      box,
      fetch,
    });
    await webhooks.save(customerId, discord);
    await notify(customerId);
    const [job] = await claimDueJobs(
      database.app,
      customerId,
      WEBHOOK_TOPIC,
      soon(),
    );
    assert.equal(job.attempts, 1);
    // Claimed: another worker does not take it while it is being delivered.
    assert.deepEqual(
      await claimDueJobs(database.app, customerId, WEBHOOK_TOPIC, soon()),
      [],
    );

    assert.deepEqual(await webhooks.deliver(customerId, job), {
      status: "completed",
    });
    assert.equal(calls[0].url, discord);
    assert.match(
      (calls[0].body as { content: string }).content,
      /Exits missing/,
    );

    answer = () =>
      new Response(null, { status: 429, headers: { "Retry-After": "120" } });
    const limited = await webhooks.deliver(customerId, job);
    assert.deepEqual(limited, {
      status: "retry",
      error: "Discord is limiting requests (HTTP 429).",
      retryAfterMs: 120_000,
    });
    answer = () =>
      Response.json(
        { ok: false, parameters: { retry_after: 3 } },
        { status: 429 },
      );
    const flooded = await webhooks.deliver(customerId, job);
    assert.equal(flooded.status === "retry" && flooded.retryAfterMs, 3_000);
    answer = () => new Response("nope", { status: 503 });
    assert.equal((await webhooks.deliver(customerId, job)).status, "retry");
    answer = () => {
      throw new TypeError(`fetch failed: ${discord}`);
    };
    const unreachable = await webhooks.deliver(customerId, job);
    assert.deepEqual(unreachable, {
      status: "retry",
      error: "Discord could not be reached.",
    });
    answer = () => new Response(null, { status: 404 });
    const gone = await webhooks.deliver(customerId, job);
    assert.equal(gone.status, "failed");
    assert.doesNotMatch(JSON.stringify([limited, unreachable, gone]), secrets);

    await webhooks.remove(customerId);
    assert.deepEqual(await webhooks.deliver(customerId, job), {
      status: "completed",
      note: "The webhook was removed.",
    });
  });

  test("a failed delivery waits with backoff, and is given up after the last attempt", async () => {
    const customerId = await customer();
    let status = 500;
    const { fetch } = responder(
      () =>
        new Response(null, {
          status,
          headers: status === 429 ? { "Retry-After": "120" } : {},
        }),
    );
    const webhooks = new NotificationWebhooks({
      database: database.app,
      box,
      fetch,
    });
    await webhooks.save(customerId, telegram);
    await notify(customerId);
    const attempt = async () => {
      const now = new Date();
      const [claimed] = await claimDueJobs(
        database.app,
        customerId,
        WEBHOOK_TOPIC,
        soon(),
      );
      if (!claimed) return undefined;
      const outcome = await webhooks.deliver(customerId, claimed);
      await settleDelivery(database.app, customerId, claimed, outcome, now);
      return outcome;
    };
    assert.equal((await attempt())?.status, "retry");
    let [job] = await jobs(database.admin, customerId);
    assert.equal(job.attempts, 1);
    assert.equal(job.completed_at, null);
    assert.equal(job.last_error, "Telegram is unavailable (HTTP 500).");
    // Due again in about 30 seconds, not before.
    const wait = job.available_at.getTime() - Date.now();
    assert.ok(wait > 20_000 && wait <= 31_000, String(wait));
    assert.equal(await attempt(), undefined);

    // A destination that asks for longer is not tried sooner.
    await database.admin`update outbox_jobs set available_at = now() - interval '1 minute' where id = ${job.id}`;
    status = 429;
    await attempt();
    [job] = await jobs(database.admin, customerId);
    // Attempt 2 would back off a minute; Telegram asked for two.
    assert.ok(job.available_at.getTime() - Date.now() > 115_000);

    // The last attempt fails too: given up, completed and audited.
    status = 500;
    await database.admin`
      update outbox_jobs set attempts = ${MAX_WEBHOOK_ATTEMPTS - 1}, available_at = now() - interval '1 minute'
      where id = ${job.id}
    `;
    await attempt();
    [job] = await jobs(database.admin, customerId);
    assert.ok(job.completed_at);
    assert.match(
      job.last_error ?? "",
      new RegExp(`^Gave up after ${MAX_WEBHOOK_ATTEMPTS} attempts`),
    );
    const [audit] = await database.admin<{ payload: unknown }[]>`
      select payload from audit_events
      where customer_id = ${customerId} and event_type = 'notification_webhook.delivery_failed'
    `;
    assert.ok(audit);
    // Stored errors never carry the URL.
    assert.doesNotMatch(JSON.stringify([job, audit]), secrets);
  });

  test("a test message goes straight to the saved webhook", async () => {
    const customerId = await customer();
    let status = 204;
    const { calls, fetch } = responder(() => new Response(null, { status }));
    const webhooks = new NotificationWebhooks({
      database: database.app,
      box,
      fetch,
    });
    assert.deepEqual(await webhooks.sendTest(customerId), {
      result: "failed",
      message: "Save a webhook URL first.",
    });
    await webhooks.save(customerId, discord);
    assert.equal((await webhooks.sendTest(customerId)).result, "delivered");
    assert.match((calls[0].body as { content: string }).content, /Test alert/);
    status = 401;
    const refused = await webhooks.sendTest(customerId);
    assert.equal(refused.result, "failed");
    assert.match(refused.message, /refused the webhook \(HTTP 401\)/);
    // Nothing went through the outbox.
    assert.equal((await jobs(database.admin, customerId)).length, 0);
  });

  test("history lists the customer's own notifications, newest first, and marks them read", async () => {
    const customerId = await customer();
    const other = await customer();
    await notify(customerId, "First");
    await notify(customerId, "Second");
    await notify(other, "Theirs");
    const history = await notificationHistory(database.app, customerId);
    assert.deepEqual(
      history.map((entry) => entry.title),
      ["Second", "First"],
    );
    assert.equal(history[0].severity, "critical");
    assert.equal(history[0].readAt, null);
    await markNotificationsRead(database.app, customerId);
    assert.ok(
      (await notificationHistory(database.app, customerId)).every(
        (entry) => entry.readAt,
      ),
    );
    assert.equal(
      (await notificationHistory(database.app, other))[0].readAt,
      null,
    );
  });
});
