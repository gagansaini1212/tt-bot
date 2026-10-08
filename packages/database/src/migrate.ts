import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, Transaction } from "./index";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
// A UTC timestamp keeps names from colliding across branches. 0001_initial
// predates the convention and sorts before every timestamp.
const NAME = /^(0001_initial|\d{14}_[a-z0-9_]+)\.sql$/;
// Serializes concurrent runs against the same database.
const LOCK = "crypto-trading-agent:migrations";

export type Migration = { name: string; sql: string; checksum: string };

export type MigrationResult = {
  /** Migrations this run applied, in order. */
  applied: string[];
  /** Recorded as applied but missing here, such as another branch's. */
  unknown: string[];
};

export async function readMigrations(
  directory = MIGRATIONS,
): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const invalid = files.find((file) => !NAME.test(file));
  if (invalid)
    throw new Error(
      `${invalid} is not a migration name. Use YYYYMMDDHHMMSS_description.sql with a UTC timestamp.`,
    );
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      return { name, sql, checksum };
    }),
  );
}

/**
 * Applies every migration not yet recorded in schema_migrations, in name
 * order, each in its own transaction with its record. Running it again
 * applies nothing. A migration edited after it was applied is an error.
 */
export async function migrate(
  database: Database,
  directory = MIGRATIONS,
): Promise<MigrationResult> {
  const migrations = await readMigrations(directory);
  await locked(database, async (transaction) => {
    await transaction`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `;
    await adoptPsqlSchema(transaction, migrations);
  });
  const applied: string[] = [];
  for (const migration of migrations) {
    const ran = await locked(database, async (transaction) => {
      const [recorded] = await transaction<{ checksum: string }[]>`
        select checksum from schema_migrations where name = ${migration.name}
      `;
      if (recorded) {
        if (recorded.checksum !== migration.checksum)
          throw new Error(
            `${migration.name} changed after it was applied. Add a new migration instead of editing this one.`,
          );
        return false;
      }
      await transaction.unsafe(migration.sql);
      await transaction`
        insert into schema_migrations (name, checksum)
        values (${migration.name}, ${migration.checksum})
      `;
      return true;
    });
    if (ran) applied.push(migration.name);
  }
  const known = new Set(migrations.map((migration) => migration.name));
  const recorded = await database<{ name: string }[]>`
    select name from schema_migrations order by name
  `;
  return {
    applied,
    unknown: recorded
      .map(({ name }) => name)
      .filter((name) => !known.has(name)),
  };
}

function locked<T>(
  database: Database,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return database.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext(${LOCK}))`;
    return work(transaction);
  }) as unknown as Promise<T>;
}

/**
 * The old `db:migrate` piped 0001_initial.sql through psql and kept no record.
 * If that ran to the end (its last statement adds outbox_jobs' policy), record
 * it as applied rather than failing on tables that already exist.
 */
async function adoptPsqlSchema(
  transaction: Transaction,
  migrations: Migration[],
) {
  const initial = migrations.find(({ name }) => name === "0001_initial.sql");
  if (!initial) return;
  const [state] = await transaction<{ tracked: boolean; complete: boolean }[]>`
    select
      exists (select from schema_migrations) as tracked,
      exists (
        select from pg_policies
        where schemaname = 'public'
          and tablename = 'outbox_jobs'
          and policyname = 'customer_isolation'
      ) as complete
  `;
  if (!state.tracked && state.complete)
    await transaction`
      insert into schema_migrations (name, checksum)
      values (${initial.name}, ${initial.checksum})
    `;
}
