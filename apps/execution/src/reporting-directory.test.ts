import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import { ExchangeAccountStore } from "./exchange-accounts";
import {
  catalogueMarkets,
  PostgresReportingDirectory,
} from "./reporting-directory";

test("a venue's markets for routes are its trading markets, and unknown without a catalogue", async () => {
  const markets = catalogueMarkets(
    new Map([
      [
        "binance-spot-testnet",
        {
          markets: async () => [
            { instrument: "USDC-USDT", status: "trading" },
            { instrument: "EUR-USDT", status: "halted" },
          ],
        },
      ],
      [
        "broken",
        {
          markets: () => Promise.reject(new Error("unreachable")),
        },
      ],
    ]),
  );
  const binance = await markets("binance-spot-testnet");
  assert.equal(binance?.("USDC-USDT"), true);
  assert.equal(binance?.("EUR-USDT"), false);
  assert.equal(await markets("broken"), undefined);
  assert.equal(await markets("htx"), undefined);
});

describe("PostgresReportingDirectory", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  const directory = () =>
    new PostgresReportingDirectory(
      database.app,
      new ExchangeAccountStore(database.app),
    );

  async function addCustomer(
    accounts: {
      exchange: string;
      label: string;
      currency?: string;
      status?: string;
      mode?: string;
    }[],
  ) {
    const customerId = randomUUID();
    const ids: string[] = [];
    await withCustomerScope(database.app, customerId, async (tx) => {
      await tx`insert into customers (id, display_name) values (${customerId}, 'Test')`;
      for (const [index, account] of accounts.entries()) {
        const [row] = await tx<{ id: string }[]>`
          insert into exchange_accounts
            (customer_id, exchange, label, mode, accounting_currency, status,
              disconnected_at, supported_features, created_at)
          values (${customerId}, ${account.exchange}, ${account.label},
            ${account.mode ?? "simulation"}, ${account.currency ?? "USDT"},
            ${account.status ?? "connected"},
            ${account.status === "disconnected" ? new Date() : null},
            ${account.mode === "live" ? tx.json({ access: "read_only" }) : null},
            now() + ${`${index} seconds`}::interval)
          returning id
        `;
        ids.push(row.id);
      }
    });
    return { customerId, ids };
  }

  test("lists only the customer's own accounts they have not removed, oldest first, with their access", async () => {
    const mine = await addCustomer([
      { exchange: "binance-spot-testnet", label: "Binance Spot Testnet" },
      { exchange: "htx", label: "Savings", mode: "live" },
      // A row that breaks the schema is left out, not trusted.
      { exchange: "binance-spot-testnet", label: "Odd", currency: "usdt" },
      // A removed account is never counted or targeted.
      {
        exchange: "binance-spot-testnet",
        label: "Removed",
        status: "disconnected",
      },
    ]);
    const theirs = await addCustomer([
      { exchange: "binance-spot-testnet", label: "Theirs" },
    ]);

    assert.deepEqual(await directory().accounts(mine.customerId), [
      {
        id: mine.ids[0],
        venue: "binance-spot-testnet",
        venueName: "Binance Spot Testnet",
        label: "Binance Spot Testnet",
        accountingCurrency: "USDT",
        mode: "simulation",
        status: "connected",
        access: "trade",
      },
      {
        id: mine.ids[1],
        venue: "htx",
        venueName: "HTX",
        label: "Savings",
        accountingCurrency: "USDT",
        mode: "live",
        status: "connected",
        access: "read_only",
      },
    ]);
    assert.deepEqual(
      (await directory().accounts(theirs.customerId)).map(({ id }) => id),
      theirs.ids,
    );
  });

  test("keeps the reporting currency per customer, USDT until changed, and audits each change", async () => {
    const reporting = directory();
    const mine = await addCustomer([
      { exchange: "binance-spot-testnet", label: "Main" },
    ]);
    const theirs = await addCustomer([
      { exchange: "binance-spot-testnet", label: "Main" },
    ]);
    assert.equal(await reporting.reportingCurrency(mine.customerId), "USDT");

    await reporting.changeReportingCurrency(mine.customerId, "EUR");
    // Saving the same currency again changes and audits nothing.
    await reporting.changeReportingCurrency(mine.customerId, "EUR");
    assert.equal(await reporting.reportingCurrency(mine.customerId), "EUR");
    assert.equal(await reporting.reportingCurrency(theirs.customerId), "USDT");
    const events = await database.admin<
      { event_type: string; payload: Record<string, string> }[]
    >`
      select event_type, payload from audit_events
      where customer_id = ${mine.customerId}
    `;
    assert.deepEqual(
      [...events],
      [
        {
          event_type: "reporting_currency.changed",
          payload: { previous: "USDT", reportingCurrency: "EUR" },
        },
      ],
    );
  });
});
