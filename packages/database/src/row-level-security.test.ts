import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  assertRowLevelSecurity,
  createDatabase,
  listCustomerIds,
  withCustomerScope,
  type Database,
} from "./index";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "./testing";

// Tables trading_app may use without row-level security. Add one only with a
// reason, such as a table that holds no customer data.
const SHARED_TABLES: string[] = [];

async function addCustomer(app: Database) {
  const customerId = randomUUID();
  const accountId = randomUUID();
  await withCustomerScope(app, customerId, async (transaction) => {
    await transaction`insert into customers (id, display_name) values (${customerId}, 'Test customer')`;
    await transaction`
      insert into exchange_accounts
        (id, customer_id, exchange, label, mode, accounting_currency, status)
      values (${accountId}, ${customerId}, 'binance-spot-testnet', 'Testnet',
        'simulation', 'USDT', 'connected')
    `;
    const [intent] = await transaction<{ id: string }[]>`
      insert into order_intents
        (customer_id, exchange_account_id, idempotency_key, status, manual_order)
      values (${customerId}, ${accountId}, ${`ct_${randomBytes(8).toString("hex")}`},
        'submitting', ${transaction.json({ kind: "test" })})
      returning id
    `;
    await transaction`
      insert into outbox_jobs (customer_id, topic, deduplication_key, payload)
      values (${customerId}, 'test', ${`test:${intent.id}`}, '{}')
    `;
    await transaction`
      insert into audit_events
        (customer_id, actor_type, actor_id, event_type, subject_type, subject_id, payload)
      values (${customerId}, 'customer', ${customerId}, 'test', 'order_intent', ${intent.id}, '{}')
    `;
  });
  return { customerId, accountId };
}

describe("row-level security", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  let first: Awaited<ReturnType<typeof addCustomer>>;
  let second: Awaited<ReturnType<typeof addCustomer>>;

  before(async () => {
    database = await createTestDatabase();
    first = await addCustomer(database.app);
    second = await addCustomer(database.app);
  });
  after(() => database?.drop());

  test("applies to the app's role but not to the schema owner", async () => {
    await assertRowLevelSecurity(database.app);
    await assert.rejects(
      assertRowLevelSecurity(database.admin),
      /bypasses row-level security/,
    );
  });

  test("a customer reads only their own rows", async () => {
    const tables = [
      "exchange_accounts",
      "order_intents",
      "outbox_jobs",
      "audit_events",
    ];
    for (const { customerId } of [first, second]) {
      const seen = await withCustomerScope(
        database.app,
        customerId,
        async (transaction) => {
          const customers = await transaction<
            { id: string }[]
          >`select id from customers`;
          const owners = await Promise.all(
            tables.map(
              (table) =>
                transaction<{ owner: string }[]>`
                select distinct customer_id as owner from ${transaction(table)}
              `,
            ),
          );
          return {
            customers: customers.map(({ id }) => id),
            owners: owners.map((rows) => rows.map(({ owner }) => owner)),
          };
        },
      );
      assert.deepEqual(seen.customers, [customerId]);
      for (const [index, owners] of seen.owners.entries())
        assert.deepEqual(owners, [customerId], tables[index]);
    }
  });

  test("a customer cannot change or add another customer's rows", async () => {
    await withCustomerScope(
      database.app,
      first.customerId,
      async (transaction) => {
        const updated = await transaction`
        update exchange_accounts set label = 'Taken over'
        where id = ${second.accountId}
      `;
        assert.equal(updated.count, 0);
      },
    );
    await assert.rejects(
      withCustomerScope(
        database.app,
        first.customerId,
        (transaction) =>
          transaction`
          insert into outbox_jobs (customer_id, topic, deduplication_key, payload)
          values (${second.customerId}, 'test', ${randomUUID()}, '{}')
        `,
      ),
      /row-level security/,
    );
    const [label] = await database.admin<{ label: string }[]>`
      select label from exchange_accounts where id = ${second.accountId}
    `;
    assert.equal(label.label, "Testnet");
  });

  test("without a customer scope, no customer rows are visible", async () => {
    const [{ count }] = await database.app<{ count: string }[]>`
      select count(*) from customers
    `;
    assert.equal(count, "0");
    await assert.rejects(
      withCustomerScope(database.app, "not-a-uuid", async () => {}),
      /UUIDs/,
    );
  });

  test("the audit trail is append-only", async () => {
    await assert.rejects(
      withCustomerScope(
        database.app,
        first.customerId,
        (transaction) =>
          transaction`update audit_events set event_type = 'edited'`,
      ),
      /permission denied/,
    );
  });

  test("every table the app can use has row-level security", async () => {
    const tables = await database.admin<
      { name: string; secured: boolean; policies: number }[]
    >`
      select c.relname as name, c.relrowsecurity as secured,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and has_table_privilege('trading_app', c.oid, 'select, insert, update, delete')
    `;
    assert.ok(tables.length >= 14);
    for (const table of tables)
      if (!SHARED_TABLES.includes(table.name))
        assert.ok(
          table.secured && table.policies > 0,
          `${table.name} needs row-level security and a customer policy`,
        );
    assert.ok(!tables.some(({ name }) => name === "schema_migrations"));
  });

  test("only the worker's role can list customers, and only their IDs", async () => {
    const ids = await listCustomerIds(database.app);
    assert.ok(
      ids.includes(first.customerId) && ids.includes(second.customerId),
    );

    const role = `ct_test_${randomBytes(6).toString("hex")}`;
    await database.admin.unsafe(
      `create role ${role} login password 'web' in role trading_app`,
    );
    const url = new URL(database.adminUrl);
    url.username = role;
    url.password = "web";
    const web = createDatabase(url.toString(), { max: 1 });
    try {
      await assertRowLevelSecurity(web);
      await assert.rejects(listCustomerIds(web), /permission denied/);
    } finally {
      await web.end();
      await database.admin.unsafe(`drop role ${role}`);
    }
  });
});
