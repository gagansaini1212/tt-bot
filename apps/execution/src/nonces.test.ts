import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import { NonceQueue } from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import { PostgresNonceStore } from "./nonces";

describe("nonces in PostgreSQL", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  async function account(): Promise<AccountScope> {
    const scope = { customerId: randomUUID(), exchangeAccountId: randomUUID() };
    await withCustomerScope(database.app, scope.customerId, async (tx) => {
      await tx`insert into customers (id, display_name) values (${scope.customerId}, 'Test')`;
      await tx`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status)
        values (${scope.exchangeAccountId}, ${scope.customerId},
          'binance-spot-testnet', 'Nonce venue', 'simulation', 'USDT', 'connected')
      `;
    });
    return scope;
  }

  /** A venue that refuses a nonce not above the last, and two requests at once. */
  function venue() {
    let last = BigInt(0);
    let inFlight = 0;
    const accepted: bigint[] = [];
    return {
      accepted,
      async send(nonce: bigint) {
        inFlight++;
        try {
          if (inFlight > 1) throw new Error("two signed requests at once");
          if (nonce <= last) throw new Error("EAPI:Invalid nonce");
          await sleep(Number(nonce % BigInt(4)));
          last = nonce;
          accepted.push(nonce);
        } finally {
          inFlight--;
        }
      },
    };
  }

  test("two worker processes hammering one account send one request at a time, each nonce above the last", async () => {
    const scope = await account();
    const nonceVenue = venue();
    // Each process has its own queue and connections; only PostgreSQL is shared.
    const processes = [0, 1].map(
      () =>
        new NonceQueue({
          store: new PostgresNonceStore(database.app, scope),
          now: () => 1_800_000_000_000,
        }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, index) =>
        processes[index % 2].run((nonce) => nonceVenue.send(nonce)),
      ),
    );
    assert.deepEqual(
      results.filter((result) => result.status === "rejected"),
      [],
    );
    assert.equal(nonceVenue.accepted.length, 60);
    for (let i = 1; i < nonceVenue.accepted.length; i++)
      assert.ok(nonceVenue.accepted[i] > nonceVenue.accepted[i - 1]);
  });

  test("a restarted worker carries on from the saved nonce, even with its clock behind", async () => {
    const scope = await account();
    const first = new NonceQueue({
      store: new PostgresNonceStore(database.app, scope),
      now: () => 2_000,
    });
    assert.equal(await first.run(async (nonce) => nonce), BigInt(2_000_000));
    assert.equal(await first.run(async (nonce) => nonce), BigInt(2_000_001));
    const restarted = new NonceQueue({
      store: new PostgresNonceStore(database.app, scope),
      now: () => 1_000,
    });
    assert.equal(
      await restarted.run(async (nonce) => nonce),
      BigInt(2_000_002),
    );
    // Each account counts its own, and no other customer sees them.
    const other = await account();
    const otherQueue = new NonceQueue({
      store: new PostgresNonceStore(database.app, other),
      now: () => 1_000,
    });
    assert.equal(
      await otherQueue.run(async (nonce) => nonce),
      BigInt(1_000_000),
    );
    const visible = await withCustomerScope(
      database.app,
      other.customerId,
      (tx) => tx`select exchange_account_id from exchange_account_nonces`,
    );
    assert.deepEqual(
      visible.map((row) => row.exchange_account_id),
      [other.exchangeAccountId],
    );
  });

  test("a request that fails still ends its turn", async () => {
    const scope = await account();
    const queue = new NonceQueue({
      store: new PostgresNonceStore(database.app, scope),
      now: () => 3_000,
    });
    await assert.rejects(
      queue.run(async () => {
        throw new Error("timed out");
      }),
      /timed out/,
    );
    assert.equal(await queue.run(async (nonce) => nonce), BigInt(3_000_001));
  });
});
