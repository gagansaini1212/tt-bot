import assert from "node:assert/strict";
import { test } from "node:test";
import { BinanceTestnetError } from "./binance-spot-testnet";
import { ExchangeError } from "./contract";
import { Backoff, VenueClock } from "./venue-limits";
import { binanceSpotTestnetVenue } from "./venue-registry";

/**
 * Two fake venues, each a connector with its own fetch, limits and clock.
 * Both speak Binance Spot's API, which is what the adapters here speak; what
 * matters is that nothing about one reaches the other. Each venue answers
 * every request from `answer`, and counts what it was asked.
 */
function twoVenues() {
  let now = 1_800_000_000_000;
  const venue = (name: string) => {
    const requests: { path: string; key: string | null }[] = [];
    const state = {
      // Answers the next requests, then the venue answers normally again.
      answers: [] as (() => Response)[],
      // The venue's clock, ahead of this machine's.
      ahead: 0,
      timeRequests: 0,
    };
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/time") {
        state.timeRequests++;
        return Response.json({ serverTime: now + state.ahead });
      }
      requests.push({
        path: url.pathname,
        key: new Headers(init?.headers).get("X-MBX-APIKEY"),
      });
      const answer = state.answers.shift();
      if (answer) return answer();
      return url.pathname === "/api/v3/account"
        ? Response.json({ canTrade: true, balances: [] })
        : Response.json({ lastUpdateId: 1, bids: [], asks: [] });
    }) as typeof globalThis.fetch;
    const connector = binanceSpotTestnetVenue({ fetch, now: () => now });
    const account = (key: string) =>
      connector.connect({ kind: "hmac", apiKey: key, secret: `${key}-secret` });
    return { name, connector, account, requests, state };
  };
  return {
    a: venue("a"),
    b: venue("b"),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const rateLimited = (code: number, seconds: number) => () =>
  Response.json(
    { code, msg: "Too much request weight used." },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );

const limitedFor = (seconds: number) => (error: unknown) =>
  error instanceof ExchangeError &&
  error.kind === "rate_limited" &&
  error.retryAfterSeconds === seconds;

test("a venue's rate limit holds back every client of that venue and none of another's", async () => {
  const { a, b, advance } = twoVenues();
  const [a1, a2] = [a.account("a1"), a.account("a2")];
  const b1 = b.account("b1");
  a.state.answers.push(rateLimited(-1003, 30));
  await assert.rejects(a1.getAccount(), limitedFor(30));
  const sent = a.requests.length;
  // The venue counts request weight for the worker as a whole: its other
  // account and its public market data wait too, without sending anything.
  await assert.rejects(a2.getAccount(), limitedFor(30));
  await assert.rejects(
    a.connector.market.getDepth("BTC-USDT", 5),
    limitedFor(30),
  );
  assert.equal(a.requests.length, sent);
  // The other venue never knows.
  assert.equal((await b1.getAccount()).canTrade, true);
  assert.equal(
    (await b.connector.market.getDepth("BTC-USDT", 5)).lastUpdateId,
    1,
  );
  advance(30_001);
  assert.equal((await a2.getAccount()).canTrade, true);
});

test("an account's own order limit holds back only that account", async () => {
  const { a, b } = twoVenues();
  const [a1, a2] = [a.account("a1"), a.account("a2")];
  const b1 = b.account("b1");
  a.state.answers.push(rateLimited(-1015, 10));
  await assert.rejects(a1.getAccount(), limitedFor(10));
  const sent = a.requests.length;
  await assert.rejects(a1.getAccount(), limitedFor(10));
  assert.equal(a.requests.length, sent);
  // The same venue's other account and its public data carry on.
  assert.equal((await a2.getAccount()).canTrade, true);
  assert.equal(
    (await a.connector.market.getDepth("BTC-USDT", 5)).lastUpdateId,
    1,
  );
  assert.equal((await b1.getAccount()).canTrade, true);
  assert.deepEqual(
    a.requests.slice(sent).map((request) => request.key),
    ["a2", null],
  );
});

test("a clock-skew error makes its venue read the time again, and no other venue", async () => {
  const { a, b } = twoVenues();
  const a1 = a.account("a1");
  const b1 = b.account("b1");
  await a1.getAccount();
  await b1.getAccount();
  assert.deepEqual([a.state.timeRequests, b.state.timeRequests], [1, 1]);
  a.state.ahead = 3_000;
  a.state.answers.push(() =>
    Response.json(
      {
        code: -1021,
        msg: "Timestamp for this request is outside of the recvWindow.",
      },
      { status: 400 },
    ),
  );
  // Nothing changed at the venue, and the error says it could not serve it.
  await assert.rejects(
    a1.getAccount(),
    (error: unknown) =>
      error instanceof BinanceTestnetError &&
      error.kind === "unavailable" &&
      error.code === -1021,
  );
  await a1.getAccount();
  await b1.getAccount();
  // Venue A synced again and corrected its offset; venue B did not.
  assert.deepEqual([a.state.timeRequests, b.state.timeRequests], [2, 1]);
  assert.equal(a.connector.limits.clock.offset, 3_000);
  assert.equal(b.connector.limits.clock.offset, 0);
});

test("a backoff only lengthens, and ends when its time passes", () => {
  let now = 0;
  const backoff = new Backoff(() => now);
  assert.equal(backoff.remainingSeconds(), 0);
  backoff.hold(30);
  backoff.hold(5);
  now = 10_500;
  assert.equal(backoff.remainingSeconds(), 20);
  now = 30_000;
  assert.equal(backoff.remainingSeconds(), 0);
});

test("a venue clock shares one read between concurrent callers and reads again when stale", async () => {
  let now = 1_000;
  const clock = new VenueClock(() => now);
  let reads = 0;
  const serverTime = async () => {
    reads++;
    return now + 500;
  };
  await Promise.all([clock.sync(serverTime), clock.sync(serverTime)]);
  assert.equal(reads, 1);
  assert.equal(clock.now(), now + 500);
  now += 30_000;
  await clock.sync(serverTime);
  assert.equal(reads, 1);
  now += 30_000;
  await clock.sync(serverTime);
  assert.equal(reads, 2);
  await assert.rejects(
    clock
      .sync(async () => {
        throw new Error("down");
      })
      .then(() => {
        clock.invalidate();
        return clock.sync(async () => {
          throw new Error("down");
        });
      }),
    /down/,
  );
});
