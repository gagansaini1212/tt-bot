import postgres, { type Sql } from "postgres";

export { migrate, readMigrations, type MigrationResult } from "./migrate";
export { DEV_CUSTOMER_ID, DEV_EXCHANGE_ACCOUNT_ID } from "./dev-seed";

export type Database = Sql<Record<string, never>>;
export type Transaction = postgres.TransactionSql<Record<string, never>>;
/** What `transaction.json()` accepts. */
export type JSONValue = postgres.JSONValue;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Connects lazily: nothing is sent until the first query. The web app and the
 * worker connect with DATABASE_URL, a member of trading_app, so row-level
 * security applies to them. Migrations and the seed use DATABASE_ADMIN_URL.
 */
export function createDatabase(
  connectionString = process.env.DATABASE_URL,
  { max = 10 }: { max?: number } = {},
): Database {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return postgres(connectionString, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

/**
 * Runs `work` in a transaction that sees and changes only `customerId`'s rows.
 * Every read and write of customer data goes through here. Keep the work
 * short, and never wait on an exchange inside it.
 */
export async function withCustomerScope<T>(
  database: Database,
  customerId: string,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(customerId)) throw new Error("Customer IDs are UUIDs.");
  return database.begin(async (transaction) => {
    await transaction`select set_config('app.current_customer_id', ${customerId}, true)`;
    return work(transaction);
  }) as unknown as Promise<T>;
}

/**
 * Every customer's ID, for worker loops that visit each customer's work in
 * turn, such as reconciliation. It reveals IDs only: read each customer's rows
 * with `withCustomerScope`, one short transaction at a time. Requires a member
 * of trading_worker.
 */
export async function listCustomerIds(database: Database): Promise<string[]> {
  const rows = await database<{ id: string }[]>`
    select ids.id from worker_customer_ids() as ids(id)
  `;
  return rows.map((row) => row.id);
}

/**
 * Fails unless row-level security applies to this connection on every table
 * that has it. Superusers, table owners and BYPASSRLS roles skip it, and so
 * would see every customer's rows.
 */
export async function assertRowLevelSecurity(database: Database) {
  const tables = await database<
    { name: string; active: boolean; role: string }[]
  >`
    select c.relname as name, row_security_active(c.oid) as active, current_user as role
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  `;
  if (!tables.length)
    throw new Error(
      "The database has no customer tables yet. Run pnpm db:migrate.",
    );
  if (tables.some((table) => !table.active))
    throw new Error(
      `The database role ${tables[0].role} bypasses row-level security, so it could read every customer's data. Connect as a login role in trading_app or trading_worker instead; see docs/database.md.`,
    );
}
