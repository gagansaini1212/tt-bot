import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { DEV_CUSTOMER_ID, DEV_LOGIN_ID } from "./dev-seed";
import { createDatabase, type Database } from "./index";
import { seedDevelopment } from "./seed";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "./testing";

const SIGN_IN_TABLES = [
  "auth_users",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
];

describe("sign-in tables", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  let role: string;
  let web: Database;

  before(async () => {
    database = await createTestDatabase();
    await seedDevelopment(database.admin);
    // A login like the web app's in a deployment: sign-in only.
    role = `ct_test_${randomBytes(6).toString("hex")}`;
    await database.admin.unsafe(
      `create role ${role} login password 'web' in role trading_auth`,
    );
    const url = new URL(database.adminUrl);
    url.username = role;
    url.password = "web";
    web = createDatabase(url.toString(), { max: 1 });
  });
  after(async () => {
    await web?.end();
    await database?.admin.unsafe(`drop role if exists ${role}`);
    await database?.drop();
  });

  test("are closed to the roles that handle trading data", async () => {
    for (const table of SIGN_IN_TABLES)
      for (const owner of ["trading_app", "trading_worker"]) {
        const [{ allowed }] = await database.admin<{ allowed: boolean }[]>`
          select has_table_privilege(${owner}, ${table},
            'select, insert, update, delete, references') as allowed
        `;
        assert.equal(allowed, false, `${owner} can use ${table}`);
      }
  });

  test("give trading_auth no trading data", async () => {
    await assert.rejects(web`select from customers`, /permission denied/);
    await assert.rejects(
      web`select from exchange_accounts`,
      /permission denied/,
    );
  });

  test("never let a login change which customer it acts for", async () => {
    const [login] = await web<{ customer_id: string }[]>`
      select customer_id from auth_users where id = ${DEV_LOGIN_ID}
    `;
    assert.equal(login.customer_id, DEV_CUSTOMER_ID);
    await web`update auth_users set name = 'Renamed' where id = ${DEV_LOGIN_ID}`;
    await assert.rejects(
      web`update auth_users set customer_id = ${DEV_CUSTOMER_ID} where id = ${DEV_LOGIN_ID}`,
      /permission denied/,
    );
    await assert.rejects(
      web`
        insert into auth_users (customer_id, name, email)
        values (${DEV_CUSTOMER_ID}, 'Intruder', 'intruder@example.com')
      `,
      /permission denied/,
    );
    await web`update auth_accounts set password = password where user_id = ${DEV_LOGIN_ID}`;
    await assert.rejects(
      web`update auth_accounts set user_id = ${DEV_LOGIN_ID}`,
      /permission denied/,
    );
  });
});
