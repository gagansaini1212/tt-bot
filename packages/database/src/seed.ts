import { DEV_CUSTOMER_ID, DEV_EXCHANGE_ACCOUNT_ID } from "./dev-seed";
import {
  assertRowLevelSecurity,
  createDatabase,
  listCustomerIds,
  withCustomerScope,
  type Database,
} from "./index";

/**
 * Creates the dev customer and their Binance Spot Testnet exchange account in
 * simulation mode. Rows that already exist are left as they are, so running
 * it again changes nothing.
 */
export async function seedDevelopment(database: Database) {
  await withCustomerScope(database, DEV_CUSTOMER_ID, async (transaction) => {
    await transaction`
      insert into customers (id, display_name)
      values (${DEV_CUSTOMER_ID}, 'Development customer')
      on conflict (id) do nothing
    `;
    await transaction`
      insert into exchange_accounts
        (id, customer_id, exchange, label, mode, accounting_currency, status)
      values (
        ${DEV_EXCHANGE_ACCOUNT_ID}, ${DEV_CUSTOMER_ID}, 'binance-spot-testnet',
        'Binance Spot Testnet', 'simulation', 'USDT', 'connected'
      )
      on conflict (id) do nothing
    `;
  });
}

/**
 * Creates the login role that `connectionString` names, as a member of
 * trading_worker, unless a role with that name exists. Local development only:
 * deployments provision their own login roles. Returns the role's name if it
 * was created.
 */
export async function createDevelopmentLogin(
  admin: Database,
  connectionString: string,
): Promise<string | undefined> {
  const url = new URL(connectionString);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!user || !password)
    throw new Error("DATABASE_URL must include a user name and password.");
  const [existing] = await admin`select from pg_roles where rolname = ${user}`;
  if (existing) return undefined;
  // Utility statements take no parameters, so Postgres quotes them itself.
  const [{ statement }] = await admin<{ statement: string }[]>`
    select format(
      'create role %I login password %L in role trading_worker',
      ${user}::text,
      ${password}::text
    ) as statement
  `;
  await admin.unsafe(statement);
  return user;
}

/**
 * Proves the app's connection works as the apps need: row-level security
 * applies, the dev customer's rows are visible in their scope, and the worker
 * can list customers.
 */
export async function verifyAppConnection(connectionString: string) {
  const app = createDatabase(connectionString, { max: 1 });
  try {
    await assertRowLevelSecurity(app);
    const accounts = await withCustomerScope(
      app,
      DEV_CUSTOMER_ID,
      (transaction) =>
        transaction`select id from exchange_accounts where id = ${DEV_EXCHANGE_ACCOUNT_ID}`,
    );
    if (accounts.length !== 1)
      throw new Error(
        "DATABASE_URL cannot see the dev exchange account. Run pnpm db:seed again.",
      );
    await listCustomerIds(app);
  } finally {
    await app.end();
  }
}
