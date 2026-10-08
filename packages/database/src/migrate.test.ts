import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createDatabase } from "./index";
import { migrate, readMigrations } from "./migrate";
import { createEmptyDatabase, databaseTestsSkipped } from "./testing";

async function migrationsIn(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const [name, sql] of Object.entries(files))
    await writeFile(join(directory, name), sql);
  return directory;
}

test("migration names must start with a UTC timestamp", async () => {
  const names = (await readMigrations()).map(({ name }) => name);
  assert.equal(names[0], "0001_initial.sql");
  assert.deepEqual(names, [...names].sort());
  for (const name of [
    "0002_next.sql",
    "2026100812000_short.sql",
    "20261008120000-dash.sql",
    "20261008120000_Upper.sql",
  ]) {
    const directory = await migrationsIn({ [name]: "select 1;" });
    await assert.rejects(readMigrations(directory), /not a migration name/);
    await rm(directory, { recursive: true });
  }
});

describe("migrations", { skip: databaseTestsSkipped }, () => {
  test("apply in name order, once each, and are recorded", async () => {
    const database = await createEmptyDatabase();
    try {
      const all = (await readMigrations()).map(({ name }) => name);
      const first = await migrate(database.admin);
      assert.deepEqual(first, { applied: all, unknown: [] });
      const recorded = await database.admin<
        { name: string; checksum: string }[]
      >`select name, checksum from schema_migrations order by name`;
      assert.deepEqual(
        recorded.map(({ name }) => name),
        all,
      );
      assert.ok(
        recorded.every(({ checksum }) => /^[0-9a-f]{64}$/.test(checksum)),
      );
      assert.deepEqual(await migrate(database.admin), {
        applied: [],
        unknown: [],
      });
    } finally {
      await database.drop();
    }
  });

  test("a failing migration leaves nothing behind and stops the run", async () => {
    const database = await createEmptyDatabase();
    const directory = await migrationsIn({
      "20260101000000_first.sql": "create table first (id int);",
      "20260101000001_broken.sql":
        "create table second (id int);\nselect 1 / 0;",
      "20260101000002_third.sql": "create table third (id int);",
    });
    try {
      await assert.rejects(
        migrate(database.admin, directory),
        /division by zero/,
      );
      const tables = await database.admin<{ name: string }[]>`
        select table_name as name from information_schema.tables
        where table_schema = 'public' order by table_name
      `;
      assert.deepEqual(
        tables.map(({ name }) => name),
        ["first", "schema_migrations"],
      );
      const recorded = await database.admin`select name from schema_migrations`;
      assert.deepEqual(
        recorded.map(({ name }) => name),
        ["20260101000000_first.sql"],
      );

      await writeFile(
        join(directory, "20260101000001_broken.sql"),
        "create table second (id int);",
      );
      assert.deepEqual((await migrate(database.admin, directory)).applied, [
        "20260101000001_broken.sql",
        "20260101000002_third.sql",
      ]);
    } finally {
      await database.drop();
      await rm(directory, { recursive: true });
    }
  });

  test("refuses a migration edited after it was applied", async () => {
    const database = await createEmptyDatabase();
    const directory = await migrationsIn({
      "20260101000000_first.sql": "create table first (id int);",
    });
    try {
      await migrate(database.admin, directory);
      await writeFile(
        join(directory, "20260101000000_first.sql"),
        "create table first (id bigint);",
      );
      await assert.rejects(
        migrate(database.admin, directory),
        /20260101000000_first\.sql changed after it was applied/,
      );
    } finally {
      await database.drop();
      await rm(directory, { recursive: true });
    }
  });

  test("concurrent runs apply each migration exactly once", async () => {
    const database = await createEmptyDatabase();
    const other = createDatabase(database.adminUrl, { max: 1 });
    try {
      const runs = await Promise.all([
        migrate(database.admin),
        migrate(other),
        migrate(database.admin),
      ]);
      const applied = runs.flatMap((run) => run.applied).sort();
      assert.deepEqual(
        applied,
        (await readMigrations()).map(({ name }) => name),
      );
    } finally {
      await other.end();
      await database.drop();
    }
  });

  test("adopts a database the old psql script set up", async () => {
    const database = await createEmptyDatabase();
    try {
      const initial = await readFile(
        new URL("../migrations/0001_initial.sql", import.meta.url),
        "utf8",
      );
      await database.admin.unsafe(initial);
      const { applied } = await migrate(database.admin);
      assert.ok(applied.length > 0);
      assert.ok(!applied.includes("0001_initial.sql"));
      const [adopted] = await database.admin`
        select from schema_migrations where name = '0001_initial.sql'
      `;
      assert.ok(adopted);
    } finally {
      await database.drop();
    }
  });

  test("reports applied migrations this checkout does not have", async () => {
    const database = await createEmptyDatabase();
    try {
      await migrate(database.admin);
      await database.admin`
        insert into schema_migrations (name, checksum)
        values ('20990101000000_other_branch.sql', 'x')
      `;
      assert.deepEqual(await migrate(database.admin), {
        applied: [],
        unknown: ["20990101000000_other_branch.sql"],
      });
    } finally {
      await database.drop();
    }
  });
});
