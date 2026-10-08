import { hashPassword } from "better-auth/crypto";
import {
  DEV_CUSTOMER_ID,
  DEV_EXCHANGE_ACCOUNT_ID,
  DEV_USER_EMAIL,
  DEV_USER_ID,
  DEV_USER_PASSWORD,
} from "./dev-seed";
import {
  assertRowLevelSecurity,
  createDatabase,
  listCustomerIds,
  withCustomerScope,
  type Database,
} from "./index";

/**
 * Creates the dev customer, their Binance Spot Testnet exchange account in
 * simulation mode, and their login (DEV_USER_EMAIL, DEV_USER_PASSWORD). Rows
 * that already exist are left as they are, so running it again changes
 * nothing, and a changed password stays changed.
 */
export async function seedDevelopment(database: Database) {
  // Better Auth's own hash, so its email sign-in accepts the password.
  const passwordHash = await hashPassword(DEV_USER_PASSWORD);
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
    // The sign-in tables have no customer scope; see the migration.
    await transaction`
      insert into auth_users (id, customer_id, name, email, email_verified)
      values (
        ${DEV_USER_ID}, ${DEV_CUSTOMER_ID}, 'Development customer',
        ${DEV_USER_EMAIL}, true
      )
      on conflict (id) do nothing
    `;
    // Better Auth's email sign-in reads the password from the login's
    // "credential" account, whose account ID is the login's ID.
    await transaction`
      insert into auth_accounts (user_id, account_id, provider_id, password)
      select ${DEV_USER_ID}, ${DEV_USER_ID}, 'credential', ${passwordHash}
      where not exists (
        select from auth_accounts
        where user_id = ${DEV_USER_ID} and provider_id = 'credential'
      )
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
 * Lets the login role that `connectionString` names use the sign-in tables,
 * unless it already can. Locally the web app and the worker share
 * DATABASE_URL, and the web app signs customers in. Deployments give the web
 * app its own login in trading_auth (and trading_app), and the worker one in
 * trading_worker only. Returns true if it granted access.
 */
export async function allowDevelopmentSignIn(
  admin: Database,
  connectionString: string,
): Promise<boolean> {
  const user = decodeURIComponent(new URL(connectionString).username);
  const [{ member }] = await admin<{ member: boolean }[]>`
    select pg_has_role(${user}, 'trading_auth', 'member') as member
  `;
  if (member) return false;
  const [{ statement }] = await admin<{ statement: string }[]>`
    select format('grant trading_auth to %I', ${user}::text) as statement
  `;
  await admin.unsafe(statement);
  return true;
}

/**
 * Proves the app's connection works as the apps need: row-level security
 * applies, the dev customer's rows are visible in their scope, the worker can
 * list customers, and the web app can find the dev login.
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
    const logins = await app`
      select customer_id from auth_users where id = ${DEV_USER_ID}
    `;
    if (logins.length !== 1)
      throw new Error(
        "DATABASE_URL cannot see the dev login. Run pnpm db:seed again.",
      );
  } finally {
    await app.end();
  }
}
