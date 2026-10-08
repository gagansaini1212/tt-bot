// Before PostgreSQL, order intents were JSON files in .testnet-orders/, one
// per client order ID. Their IDs must stay used, so the worker will not place
// orders while that directory has intents in it; `pnpm exchange
// import-journal` copies them into the database.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  limitOrderSchema,
  protectedEntrySchema,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import {
  clientOrderIdOf,
  type ManualOrder,
  type OrderIntentStore,
} from "./order-intents";

const recordSchema = z.union([
  // The dashboard's.
  z.object({
    entry: protectedEntrySchema,
    status: z.string(),
    createdAt: z.iso.datetime().optional(),
  }),
  // The CLI's.
  z.object({
    order: limitOrderSchema,
    status: z.string(),
    createdAt: z.iso.datetime().optional(),
  }),
]);

export function journalDirectory(env: NodeJS.ProcessEnv) {
  return resolve(env.TESTNET_ORDER_JOURNAL_DIR ?? ".testnet-orders");
}

async function journalFiles(directory: string) {
  try {
    return (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Throws while the old journal holds intents. */
export async function assertNoJournal(env: NodeJS.ProcessEnv) {
  const directory = journalDirectory(env);
  const files = await journalFiles(directory);
  if (files.length)
    throw new Error(
      `Order intents now live in PostgreSQL, but ${directory} still holds ${files.length}. Run pnpm exchange import-journal to copy them into the database, then delete that directory.`,
    );
}

/**
 * Copies every intent in the journal into `intents` for `scope`'s customer,
 * keeping its outcome: an unconfirmed submission stays unknown. Intents already
 * in the database are skipped, so it can run again. Every file is read before
 * anything is written.
 */
export async function importJournal(
  env: NodeJS.ProcessEnv,
  intents: OrderIntentStore,
  scope: AccountScope,
) {
  const directory = journalDirectory(env);
  const records = await Promise.all(
    (await journalFiles(directory)).map(async (file) => {
      const path = join(directory, file);
      let parsed: z.infer<typeof recordSchema>;
      try {
        parsed = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        throw new Error(
          `${path} is not an order intent. Nothing was imported.`,
        );
      }
      const order: ManualOrder =
        "entry" in parsed
          ? { kind: "protected_entry", entry: parsed.entry }
          : { kind: "limit_order", order: parsed.order };
      if (`${clientOrderIdOf(order)}.json` !== file)
        throw new Error(
          `${path} holds another order's intent. Nothing was imported.`,
        );
      // The CLI dropped createdAt once Binance acknowledged an order.
      const createdAt = parsed.createdAt
        ? new Date(parsed.createdAt)
        : (await stat(path)).mtime;
      return { order, status: parsed.status, createdAt };
    }),
  );
  let imported = 0;
  for (const { order, status, createdAt } of records) {
    if (!(await intents.record(scope, order, "journal_import", createdAt)))
      continue;
    imported++;
    await intents.settle(
      scope,
      clientOrderIdOf(order),
      status === "acknowledged" || status === "rejected"
        ? { status }
        : {
            status: "unknown",
            reason:
              "Imported from the order journal without a confirmed outcome.",
          },
    );
  }
  return { directory, found: records.length, imported };
}
