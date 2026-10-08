import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { verifyPassword } from "better-auth/crypto";
import {
  DEV_CUSTOMER_ID,
  DEV_EXCHANGE_ACCOUNT_ID,
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_ID,
  DEV_LOGIN_PASSWORD,
} from "./dev-seed";
import {
  assertRowLevelSecurity,
  createDatabase,
  withCustomerScope,
} from "./index";
import {
  allowDevelopmentSignIn,
  createDevelopmentLogin,
  seedDevelopment,
  verifyAppConnection,
} from "./seed";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "./testing";

describe("development seed", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  test("creates the dev customer and testnet account once, with stable IDs", async () => {
    await assert.rejects(
      verifyAppConnection(database.appUrl),
      /cannot see the dev exchange account/,
    );
    await seedDevelopment(database.admin);
    await withCustomerScope(
      database.app,
      DEV_CUSTOMER_ID,
      (transaction) =>
        transaction`update exchange_accounts set label = 'Renamed'`,
    );
    await seedDevelopment(database.admin);

    const customers =
      await database.admin`select id, display_name from customers`;
    assert.deepEqual(
      [...customers],
      [{ id: DEV_CUSTOMER_ID, display_name: "Development customer" }],
    );
    const accounts = await database.admin`
      select id, customer_id, exchange, label, mode, accounting_currency, status
      from exchange_accounts
    `;
    assert.deepEqual(
      [...accounts],
      [
        {
          id: DEV_EXCHANGE_ACCOUNT_ID,
          customer_id: DEV_CUSTOMER_ID,
          exchange: "binance-spot-testnet",
          // A second run leaves existing rows as they are.
          label: "Renamed",
          mode: "simulation",
          accounting_currency: "USDT",
          status: "connected",
        },
      ],
    );
    await assert.rejects(
      verifyAppConnection(database.appUrl),
      /permission denied for table auth_users/,
    );
    await allowDevelopmentSignIn(database.admin, database.appUrl);
    await verifyAppConnection(database.appUrl);
    await assert.rejects(
      verifyAppConnection(database.adminUrl),
      /bypasses row-level security/,
    );
  });

  test("creates DATABASE_URL's login role once, subject to row-level security", async () => {
    const role = `ct_test_${randomBytes(6).toString("hex")}`;
    const url = new URL(database.adminUrl);
    url.username = role;
    url.password = 'it\'s "quoted"';
    try {
      assert.equal(
        await createDevelopmentLogin(database.admin, url.toString()),
        role,
      );
      assert.equal(
        await createDevelopmentLogin(database.admin, url.toString()),
        undefined,
      );
      const login = createDatabase(url.toString(), { max: 1 });
      try {
        await assertRowLevelSecurity(login);
      } finally {
        await login.end();
      }
      url.password = "";
      await assert.rejects(
        createDevelopmentLogin(database.admin, url.toString()),
        /user name and password/,
      );
    } finally {
      await database.admin.unsafe(`drop role if exists ${role}`);
    }
  });

  test("creates the dev login for the dev customer once", async () => {
    await seedDevelopment(database.admin);
    const logins = await database.admin`
      select id, customer_id, email, email_verified from auth_users
    `;
    assert.deepEqual(
      [...logins],
      [
        {
          id: DEV_LOGIN_ID,
          customer_id: DEV_CUSTOMER_ID,
          email: DEV_LOGIN_EMAIL,
          email_verified: true,
        },
      ],
    );
    const [account] = await database.admin<{ password: string }[]>`
      select password from auth_accounts
      where user_id = ${DEV_LOGIN_ID} and account_id = ${DEV_LOGIN_ID}
        and provider_id = 'credential'
    `;
    assert.ok(
      await verifyPassword({
        hash: account.password,
        password: DEV_LOGIN_PASSWORD,
      }),
    );

    // A second run leaves a changed password as it is.
    await database.admin`
      update auth_accounts set password = 'changed' where user_id = ${DEV_LOGIN_ID}
    `;
    await seedDevelopment(database.admin);
    const accounts = await database.admin`
      select password from auth_accounts where user_id = ${DEV_LOGIN_ID}
    `;
    assert.deepEqual([...accounts], [{ password: "changed" }]);
  });

  test("lets DATABASE_URL's login role use the sign-in tables once", async () => {
    const role = `ct_test_${randomBytes(6).toString("hex")}`;
    const url = new URL(database.adminUrl);
    url.username = role;
    url.password = "login";
    try {
      await createDevelopmentLogin(database.admin, url.toString());
      const login = createDatabase(url.toString(), { max: 1 });
      try {
        await assert.rejects(
          login`select from auth_sessions`,
          /permission denied/,
        );
        assert.equal(
          await allowDevelopmentSignIn(database.admin, url.toString()),
          true,
        );
        assert.equal(
          await allowDevelopmentSignIn(database.admin, url.toString()),
          false,
        );
        await login`select from auth_sessions`;
      } finally {
        await login.end();
      }
    } finally {
      await database.admin.unsafe(`drop role if exists ${role}`);
    }
  });
});
