import type { Database } from "@crypto-trading/database";
import type { NonceStore, NonceTurn } from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";

/**
 * An exchange account's nonces in PostgreSQL, for a venue that requires
 * strictly increasing ones (ADR 0009 §6). A turn holds a session advisory
 * lock on the account, so one request at a time is signed and sent for it
 * across every worker process, and its nonce is one more than the last the
 * account used, saved before the request goes, so a restart never reuses
 * one. Each turn reserves one connection until it is released, and needs no
 * other: no transaction stays open while the request waits on the venue.
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
      const nonce = await this.#issue(connection, floor);
      let released = false;
      return {
        nonce,
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

  /**
   * Saves and returns the account's next nonce, in a short transaction in
   * the customer's scope on the turn's own session, so a turn never waits
   * for a second connection from the pool.
   */
  async #issue(connection: ReservedConnection, floor: bigint) {
    const { customerId, exchangeAccountId } = this.#scope;
    await connection.unsafe("begin");
    try {
      await connection`select set_config('app.current_customer_id', ${customerId}, true)`;
      const [row] = await connection<{ nonce: string }[]>`
        insert into exchange_account_nonces
          (customer_id, exchange_account_id, last_nonce)
        values (${customerId}, ${exchangeAccountId}, ${floor.toString()}::bigint)
        on conflict (exchange_account_id) do update set
          last_nonce = greatest(
            exchange_account_nonces.last_nonce + 1, excluded.last_nonce
          ),
          updated_at = now()
        returning last_nonce::text as nonce
      `;
      await connection.unsafe("commit");
      return BigInt(row.nonce);
    } catch (error) {
      await connection.unsafe("rollback").catch(() => {});
      throw error;
    }
  }
}

type ReservedConnection = Awaited<ReturnType<Database["reserve"]>>;

async function unlock(connection: ReservedConnection, key: string) {
  try {
    await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
  } catch {
    // A broken session has released its lock already.
  } finally {
    connection.release();
  }
}
