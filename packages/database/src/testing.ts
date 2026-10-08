// Integration-test helpers. Each test database is a fresh database on the
// server TEST_DATABASE_URL names, dropped afterwards. That URL needs a role
// that can create databases and roles, such as the postgres superuser.
import { randomBytes } from "node:crypto";
import { createDatabase, type Database } from "./index";
import { migrate } from "./migrate";

export { seedDevelopment } from "./seed";

/** A `skip` option for database tests: false, or why they are skipped. */
export const databaseTestsSkipped: false | string = process.env
  .TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set. Point it at a PostgreSQL superuser, such as postgresql://trading:trading@localhost:5432/postgres, to run the database tests (docs/database.md).";

export type TestDatabase = {
  /** The database's owner, as DATABASE_ADMIN_URL would be. */
  adminUrl: string;
  admin: Database;
  drop(): Promise<void>;
};

export type MigratedTestDatabase = TestDatabase & {
  /** A login role in trading_worker, as DATABASE_URL would be. */
  appUrl: string;
  app: Database;
};

function server() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to run database tests.");
  return url;
}

function urlFor(
  base: string,
  changes: Partial<Record<"database" | "user" | "password", string>>,
) {
  const url = new URL(base);
  if (changes.database) url.pathname = `/${changes.database}`;
  if (changes.user) url.username = changes.user;
  if (changes.password) url.password = changes.password;
  return url.toString();
}

/** A new, empty database. */
export async function createEmptyDatabase(): Promise<TestDatabase> {
  const name = `ct_test_${randomBytes(6).toString("hex")}`;
  const root = createDatabase(server(), { max: 1 });
  await root.unsafe(`create database ${name}`);
  const adminUrl = urlFor(server(), { database: name });
  const admin = createDatabase(adminUrl, { max: 2 });
  return {
    adminUrl,
    admin,
    drop: async () => {
      await admin.end();
      await root.unsafe(`drop database ${name} with (force)`);
      await root.end();
    },
  };
}

/** A new database with every migration applied and its own app login role. */
export async function createTestDatabase(): Promise<MigratedTestDatabase> {
  const database = await createEmptyDatabase();
  try {
    await migrate(database.admin);
    const role = `ct_test_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(16).toString("hex");
    await database.admin.unsafe(
      `create role ${role} login password '${password}' in role trading_worker`,
    );
    const appUrl = urlFor(database.adminUrl, { user: role, password });
    const app = createDatabase(appUrl, { max: 4 });
    return {
      ...database,
      appUrl,
      app,
      drop: async () => {
        await app.end();
        await database.drop();
        const root = createDatabase(server(), { max: 1 });
        await root.unsafe(`drop role if exists ${role}`);
        await root.end();
      },
    };
  } catch (error) {
    await database.drop();
    throw error;
  }
}
