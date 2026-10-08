import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { DEV_CUSTOMER_ID, DEV_EXCHANGE_ACCOUNT_ID } from "./dev-seed";
import {
  assertRowLevelSecurity,
  createDatabase,
  withCustomerScope,
} from "./index";
import {
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
});
