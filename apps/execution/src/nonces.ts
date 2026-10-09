import { withCustomerScope, type Database } from "@crypto-trading/database";
import type { NonceStore, NonceTurn } from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";

/**
 * An exchange account's nonces in PostgreSQL, for a venue that requires
 * strictly increasing ones (ADR 0009 §6). A turn holds a session advisory
 * lock on the account, so one request at a time is signed and sent for it
 * across every worker process, and its nonce is one more than the last the
 * account used, saved before the request goes, so a restart never reuses
 * one. Each turn reserves a connection until it is released: no transaction
 * stays open while the request waits on the venue.
 *
 * Give it to the account's NonceQueue, which keeps the process's own
 * requests in line before they wait for the lock.
 */
export class PostgresNonceStore implements NonceStore {
  readonly #database: Database;
  readonly #scope: AccountScope;

  constructor(database: Database, scope: AccountScope) {
    this.#database = database;
    this.#scope = scope;
  }

  async next(floor: bigint): Promise<NonceTurn> {
    const key = `venue-nonce:${this.#scope.exchangeAccountId}`;
    const connection = await this.#database.reserve();
    let locked = false;
    try {
      await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      locked = true;
      const [row] = await withCustomerScope(
        this.#database,
        this.#scope.customerId,
        (tx) => tx<{ nonce: string }[]>`
          insert into exchange_account_nonces
            (customer_id, exchange_account_id, last_nonce)
          values (
            ${this.#scope.customerId}, ${this.#scope.exchangeAccountId},
            ${floor.toString()}::bigint
          )
          on conflict (exchange_account_id) do update set
            last_nonce = greatest(
              exchange_account_nonces.last_nonce + 1, excluded.last_nonce
            ),
            updated_at = now()
          returning last_nonce::text as nonce
        `,
      );
      let released = false;
      return {
        nonce: BigInt(row.nonce),
        release: async () => {
          if (released) return;
          released = true;
          await unlock(connection, key);
        },
      };
    } catch (error) {
      if (locked) await unlock(connection, key);
      else connection.release();
      throw error;
    }
  }
}

async function unlock(
  connection: Awaited<ReturnType<Database["reserve"]>>,
  key: string,
) {
  try {
    await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
  } catch {
    // A broken session has released its lock already.
  } finally {
    connection.release();
  }
}
