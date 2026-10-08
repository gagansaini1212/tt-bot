import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { withCustomerScope, type Transaction } from "./index";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "./testing";

describe("schema", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  test("each protected entry has its own holding deadline, and a position can hold several", async () => {
    const customerId = randomUUID();
    const accountId = randomUUID();
    const strategyId = randomUUID();
    const positionId = randomUUID();
    const entry = async (tx: Transaction) => {
      const [intent] = await tx<{ id: string }[]>`
        insert into order_intents
          (customer_id, exchange_account_id, idempotency_key, status, manual_order)
        values (${customerId}, ${accountId}, ${`ct_${randomUUID().slice(0, 8)}`},
          'acknowledged', '{}')
        returning id
      `;
      return intent.id;
    };
    const deadline = (tx: Transaction, intentId: string) => tx`
      insert into holding_deadlines
        (customer_id, position_ownership_id, order_intent_id, deadline_at, status)
      values (${customerId}, ${positionId}, ${intentId}, now() + interval '1 day', 'pending')
    `;
    await withCustomerScope(database.app, customerId, async (tx) => {
      await tx`insert into customers (id, display_name) values (${customerId}, 'Test')`;
      await tx`
        insert into exchange_accounts
          (id, customer_id, exchange, label, mode, accounting_currency, status)
        values (${accountId}, ${customerId}, 'binance-spot-testnet', 'Testnet',
          'simulation', 'USDT', 'connected')
      `;
      await tx`
        insert into strategies
          (id, customer_id, exchange_account_id, name, status, current_version)
        values (${strategyId}, ${customerId}, ${accountId}, 'DCA', 'simulation', 1)
      `;
      await tx`
        insert into strategy_versions (customer_id, strategy_id, version, rules)
        values (${customerId}, ${strategyId}, 1, '{}')
      `;
      await tx`
        insert into position_ownership
          (id, customer_id, exchange_account_id, strategy_id, strategy_version,
            instrument, status, first_fill_at)
        values (${positionId}, ${customerId}, ${accountId}, ${strategyId}, 1,
          'BTC-USDT', 'open', now())
      `;
      await deadline(tx, await entry(tx));
      await deadline(tx, await entry(tx));
    });
    const [{ count }] = await database.admin<{ count: string }[]>`
      select count(*) from holding_deadlines where position_ownership_id = ${positionId}
    `;
    assert.equal(count, "2");

    await assert.rejects(
      withCustomerScope(database.app, customerId, async (tx) => {
        const intentId = await entry(tx);
        await deadline(tx, intentId);
        await deadline(tx, intentId);
      }),
      /holding_deadlines_order_intent_id_key/,
    );
  });
});
