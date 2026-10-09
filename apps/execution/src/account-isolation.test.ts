// Exchange accounts on separate venues, side by side in one execution loop
// (ADR 0009 §5, issue #22): a venue that is rate limited, out of sync or
// slow for one account never pauses, delays or slows another's pass, and an
// account whose venue cannot serve it sends no entries while its exits keep
// trying.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { withCustomerScope } from "@crypto-trading/database";
import {
  createTestDatabase,
  databaseTestsSkipped,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import {
  BinanceTestnetError,
  type AccountReader,
  type ManualOrderRequest,
} from "@crypto-trading/exchanges";
import type { AccountScope } from "./accounts";
import { ExecutionLoop, type PassClients } from "./execution-loop";
import { FakeBinance } from "./fixtures/fake-binance";
import { loadManualTradingConfig, ManualOrderDesk } from "./manual-orders";
import { PostgresOrderIntents } from "./order-intents";
import { PostgresRiskLimits } from "./risk-limits";
import { PostgresTradeProposals } from "./trade-proposals";

const config = (() => {
  const loaded = loadManualTradingConfig({
    TESTNET_MANUAL_INSTRUMENTS: "BTC-USDT,ETH-USDT",
    TESTNET_MANUAL_ALLOCATION_USDT: "300",
  });
  assert.ok(loaded.ok);
  return loaded.config;
})();

const stopLimit = (id: string): ManualOrderRequest => ({
  type: "stop_limit",
  instrument: "BTC-USDT",
  quantity: "0.001",
  stopPrice: "61000",
  price: "61100",
  takeProfitPrice: "64000",
  stopLossPrice: "59000",
  listClientOrderId: id,
});

/**
 * A fake venue for one account. While `failing` is set, every request fails
 * as the venue would then; while `holding` is set, reads wait until it is
 * released.
 */
class FakeVenue {
  readonly fake: FakeBinance;
  failing?: () => Error;
  #held?: { promise: Promise<void>; release: () => void };
  calls = 0;

  constructor() {
    this.fake = new FakeBinance();
  }

  hold() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.#held = { promise, release };
  }

  release() {
    this.#held?.release();
    this.#held = undefined;
  }

  /** The client the loop and the desk use: the fake behind the switches. */
  get client(): FakeBinance {
    return new Proxy(this.fake, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          this.calls++;
          await this.#held?.promise;
          if (this.failing) throw this.failing();
          return value.apply(target, args);
        };
      },
    });
  }
}

const rateLimited = () => new BinanceTestnetError("rate_limited", -1003, 30);
const clockSkew = () => new BinanceTestnetError("unavailable", -1021);

describe("accounts on separate venues", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  /** A customer with two testnet accounts, each on its own fake venue. */
  async function world() {
    const customerId = randomUUID();
    const scopes = [randomUUID(), randomUUID()].map((exchangeAccountId) => ({
      customerId,
      exchangeAccountId,
    }));
    await withCustomerScope(database.app, customerId, async (tx) => {
      await tx`insert into customers (id, display_name) values (${customerId}, 'Test')`;
      for (const [index, scope] of scopes.entries())
        await tx`
          insert into exchange_accounts
            (id, customer_id, exchange, label, mode, accounting_currency, status)
          values (${scope.exchangeAccountId}, ${customerId},
            'binance-spot-testnet', ${`Testnet ${index + 1}`}, 'simulation',
            'USDT', 'connected')
        `;
    });
    const intents = new PostgresOrderIntents(database.app);
    const proposals = new PostgresTradeProposals(database.app);
    const risk = new PostgresRiskLimits(database.app);
    const venues = scopes.map(() => new FakeVenue());
    const desks = venues.map(
      (venue) =>
        new ManualOrderDesk({
          exchange: venue.client,
          config,
          intents,
          proposals,
          risk,
        }),
    );
    for (const scope of scopes)
      await risk.change(
        scope,
        {
          maxOrderNotional: "100",
          maxDailyRisk: "1000",
          defaultStopLossPercent: "2",
        },
        0,
      );
    let listed = scopes;
    const loop = new ExecutionLoop({
      database: database.app,
      accounts: async (id) => (id === customerId ? listed : []),
      clients: async (scope): Promise<PassClients> => {
        const index = scopes.findIndex(
          (entry) => entry.exchangeAccountId === scope.exchangeAccountId,
        );
        return { exchange: venues[index].client, desk: desks[index] };
      },
      intents,
      log: () => {},
    });
    const [a, b] = scopes;
    return {
      a,
      b,
      venues,
      loop,
      place: (scope: (typeof scopes)[number], request: ManualOrderRequest) =>
        desks[scopes.indexOf(scope)].place(scope, request),
      list: (only: typeof scopes) => {
        listed = only;
      },
      // BTC trades at the stop-limit entries' stop price on both venues.
      stopTrades: () => {
        for (const venue of venues) venue.fake.setPrice("BTC-USDT", "61000");
      },
    };
  }

  const intentStatus = async (id: string) =>
    (
      await database.admin<{ status: string }[]>`
        select status from order_intents where idempotency_key = ${id}
      `
    )[0]?.status;
  const accountStatus = async (scope: AccountScope) =>
    (
      await database.admin<{ status: string }[]>`
        select status from exchange_accounts where id = ${scope.exchangeAccountId}
      `
    )[0]?.status;
  const notifications = async (scope: AccountScope) =>
    (
      await database.admin<
        { kind: string; data: { exchangeAccountId?: string } }[]
      >`
        select kind, data from notifications
        where customer_id = ${scope.customerId}
        order by created_at, id
      `
    )
      .filter((row) => row.kind.startsWith("account_"))
      .map(
        (row) =>
          `${row.kind}:${row.data.exchangeAccountId === scope.exchangeAccountId ? "this" : "other"}`,
      );

  for (const [problem, failure] of [
    ["a rate limit", rateLimited],
    ["clock skew", clockSkew],
  ] as const)
    test(`${problem} on one account's venue never stops another's entries, and that account's entries wait until it is reconciled`, async () => {
      const w = await world();
      await w.place(w.a, stopLimit(`ct_iso_a_${failure.name}`));
      await w.place(w.b, stopLimit(`ct_iso_b_${failure.name}`));
      w.stopTrades();
      w.venues[0].failing = failure;

      await w.loop.runPass();
      // B's stop traded and its entry went out; A's waits, unsent.
      assert.equal(w.venues[1].fake.count("placeProtectedEntry"), 1);
      assert.equal(
        await intentStatus(`ct_iso_b_${failure.name}`),
        "acknowledged",
      );
      assert.equal(await intentStatus(`ct_iso_a_${failure.name}`), "pending");
      assert.equal(w.venues[0].fake.count("placeProtectedEntry"), 0);
      assert.equal(await accountStatus(w.a), "unavailable");
      assert.equal(await accountStatus(w.b), "connected");

      // Still failing: no second notification, and nothing sent.
      await w.loop.runPass();
      assert.deepEqual(await notifications(w.a), ["account_unavailable:this"]);
      assert.equal(await intentStatus(`ct_iso_a_${failure.name}`), "pending");

      // The venue answers again. The pass that finds it reconciles the
      // account and sends no entry; the next one does.
      w.venues[0].failing = undefined;
      await w.loop.runPass();
      assert.equal(await accountStatus(w.a), "connected");
      assert.equal(await intentStatus(`ct_iso_a_${failure.name}`), "pending");
      await w.loop.runPass();
      assert.equal(
        await intentStatus(`ct_iso_a_${failure.name}`),
        "acknowledged",
      );
      assert.deepEqual(await notifications(w.a), [
        "account_unavailable:this",
        "account_recovered:this",
      ]);
    });

  test("a held stop-limit entry whose send the venue cannot serve stays held, and goes out later", async () => {
    const w = await world();
    await w.place(w.a, stopLimit("ct_iso_held"));
    w.stopTrades();
    // The venue answers reads but limits the order itself.
    w.venues[0].fake.failNext(
      "placeProtectedEntry",
      new BinanceTestnetError("rate_limited", -1015, 10),
    );
    await w.loop.runPass();
    assert.equal(await intentStatus("ct_iso_held"), "pending");
    await w.loop.runPass();
    assert.equal(await intentStatus("ct_iso_held"), "acknowledged");
    assert.equal(w.venues[0].fake.count("placeProtectedEntry"), 2);
  });

  test("a slow venue holds up only its own account's pass", async () => {
    const w = await world();
    await w.place(w.a, stopLimit("ct_iso_slow_a"));
    await w.place(w.b, stopLimit("ct_iso_slow_b"));
    w.stopTrades();
    w.venues[0].hold();
    const pass = w.loop.runPass();
    // B's entry goes out while A's venue has not answered at all.
    const deadline = Date.now() + 5_000;
    while (
      (await intentStatus("ct_iso_slow_b")) !== "acknowledged" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await intentStatus("ct_iso_slow_b"), "acknowledged");
    assert.equal(await intentStatus("ct_iso_slow_a"), "pending");
    // A pass started meanwhile joins A's instead of checking it twice.
    const again = w.loop.runPass();
    w.venues[0].release();
    await Promise.all([pass, again]);
    assert.equal(await intentStatus("ct_iso_slow_a"), "acknowledged");
    assert.equal(w.venues[0].fake.count("placeProtectedEntry"), 1);
  });

  test("each account's pass settles its own unknown outcomes only", async () => {
    const w = await world();
    const intents = new PostgresOrderIntents(database.app);
    const order = (id: string) => ({
      kind: "limit_order" as const,
      order: {
        instrument: "BTC-USDT" as const,
        side: "BUY" as const,
        quantity: "0.001",
        price: "50000",
        clientOrderId: id,
      },
    });
    const past = new Date(Date.now() - 5 * 60_000);
    assert.ok(
      await intents.record(w.a, order("ct_iso_unknown_a"), "cli", past),
    );
    assert.ok(
      await intents.record(w.b, order("ct_iso_unknown_b"), "cli", past),
    );
    await database.admin`
      update outbox_jobs set available_at = now() - interval '1 minute'
      where customer_id = ${w.a.customerId}
    `;
    // Only B is served now: A's job is left for A's own pass.
    w.list([w.b]);
    await w.loop.runPass();
    assert.equal(await intentStatus("ct_iso_unknown_b"), "rejected");
    assert.equal(await intentStatus("ct_iso_unknown_a"), "submitting");
    const [job] = await database.admin<{ attempts: number }[]>`
      select j.attempts from outbox_jobs j
      join order_intents i on i.id::text = j.payload ->> 'orderIntentId'
      where i.idempotency_key = 'ct_iso_unknown_a'
    `;
    assert.equal(job.attempts, 0);
    w.list([w.a, w.b]);
    await w.loop.runPass();
    assert.equal(await intentStatus("ct_iso_unknown_a"), "rejected");
  });

  test("a read-only account is only monitored: its balances are read, and nothing is ever sent", async () => {
    const w = await world();
    // A held entry on it, as data could hold, is never sent.
    await w.place(w.a, stopLimit("ct_iso_read_only"));
    w.stopTrades();
    let reads = 0;
    let down = false;
    const reader = {
      venue: "binance-spot-testnet",
      async getAccount() {
        reads++;
        if (down) throw new BinanceTestnetError("unavailable");
        return { canTrade: false, balances: [] };
      },
    } as unknown as AccountReader;
    let now = Date.now();
    const loop = new ExecutionLoop({
      database: database.app,
      accounts: async (id) => (id === w.a.customerId ? [w.a] : []),
      clients: async () => ({ exchange: reader, readOnly: true }),
      intents: new PostgresOrderIntents(database.app),
      now: () => new Date(now),
      log: () => {},
    });
    await loop.runPass();
    await loop.runPass();
    // Once a minute is enough to know its venue still serves it.
    assert.equal(reads, 1);
    down = true;
    now += 61_000;
    await loop.runPass();
    assert.equal(await accountStatus(w.a), "unavailable");
    down = false;
    await loop.runPass();
    assert.equal(await accountStatus(w.a), "connected");
    assert.equal(reads, 3);
    assert.equal(await intentStatus("ct_iso_read_only"), "pending");
    assert.equal(w.venues[0].fake.count("placeProtectedEntry"), 0);
    assert.deepEqual(await notifications(w.a), [
      "account_unavailable:this",
      "account_recovered:this",
    ]);
  });
});
