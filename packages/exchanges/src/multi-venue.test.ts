// Binance Spot Testnet and HTX registered side by side in one worker, as
// issue #29 checks: a rate limit or clock-skew error on one venue never
// pauses, delays or slows the other (ADR 0009 §5, ADR 0010).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ExchangeError } from "./contract.js";
import { FakeHtx } from "./fixtures/fake-htx.js";
import { CredentialsError } from "./signing.js";
import {
  binanceSpotTestnetVenue,
  canTrade,
  htxVenue,
  VenueRegistry,
} from "./venue-registry.js";

function sideBySide() {
  let now = Date.UTC(2026, 9, 9, 1, 0, 0);
  const clock = () => now;
  // Binance answers its account and depth, and its time from its own clock.
  const binance = {
    ahead: 0,
    timeRequests: 0,
    sent: 0,
    answers: [] as (() => Response)[],
  };
  const binanceFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://testnet.binance.vision");
    if (url.pathname === "/api/v3/time") {
      binance.timeRequests++;
      return Response.json({ serverTime: now + binance.ahead });
    }
    binance.sent++;
    const answer = binance.answers.shift();
    if (answer) return answer();
    return url.pathname === "/api/v3/account"
      ? Response.json({ canTrade: true, balances: [] })
      : Response.json({ lastUpdateId: 1, bids: [], asks: [] });
  }) as typeof fetch;
  const htx = new FakeHtx({ now: clock });
  const registry = new VenueRegistry([
    binanceSpotTestnetVenue({ fetch: binanceFetch, now: clock }),
    htxVenue({ fetch: htx.fetch, now: clock }),
  ]);
  const binanceAccount = registry.connect("binance-spot-testnet", {
    kind: "hmac",
    apiKey: "binance-key",
    secret: "binance-secret",
  });
  const htxAccount = registry.connect("htx", {
    kind: "hmac",
    apiKey: htx.apiKey,
    secret: htx.apiSecret,
  });
  const timeRequests = () =>
    htx.requests.filter((request) => request.path === "/v1/common/timestamp")
      .length;
  return {
    registry,
    binance,
    binanceAccount,
    binanceMarket: registry.get("binance-spot-testnet")!.market,
    htx,
    htxAccount,
    htxMarket: registry.get("htx")!.market,
    timeRequests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const kind = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExchangeError, String(error));
    return error.kind;
  }
  return "served";
};

test("the registry serves HTX beside Binance Spot Testnet", () => {
  const { registry, binanceAccount, htxAccount } = sideBySide();
  assert.deepEqual(registry.venues, ["binance-spot-testnet", "htx"]);
  assert.equal(canTrade(binanceAccount), true);
  assert.equal(canTrade(htxAccount), true);
  assert.equal("placeProtectedEntry" in htxAccount, true);
  assert.notEqual(
    registry.get("htx")!.limits,
    registry.get("binance-spot-testnet")!.limits,
  );
  // HTX takes an HMAC Access Key and Secret Key, and no passphrase.
  for (const credentials of [
    { kind: "ed25519", apiKey: "key", privateKey: "pem" },
    { kind: "hmac", apiKey: "key", secret: "secret", passphrase: "phrase" },
  ] as const)
    assert.throws(() => registry.connect("htx", credentials), CredentialsError);
});

test("an HTX rate limit holds back HTX, never Binance, and a Binance one never HTX", async () => {
  const s = sideBySide();
  // HTX answers HTTP 429 without a Retry-After: the whole venue waits its
  // 10-second fallback.
  s.htx.failNext("/market/trade", () => new Response("", { status: 429 }));
  assert.equal(
    await kind(s.htxMarket.getLastPrice("BTC-USDT")),
    "rate_limited",
  );
  const sent = s.htx.requests.length;
  assert.equal(await kind(s.htxAccount.getAccount()), "rate_limited");
  assert.equal(await kind(s.htxMarket.getDepth("BTC-USDT")), "rate_limited");
  assert.equal(s.htx.requests.length, sent);
  // Binance answers as if nothing happened.
  assert.equal(await kind(s.binanceAccount.getAccount()), "served");
  assert.equal(await kind(s.binanceMarket.getDepth("BTC-USDT")), "served");
  s.advance(10_001);
  assert.equal(await kind(s.htxAccount.getAccount()), "served");

  // Binance limits its request weight: Binance waits, HTX does not.
  s.binance.answers.push(
    () =>
      new Response(JSON.stringify({ code: -1003, msg: "Too much weight." }), {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
  );
  assert.equal(await kind(s.binanceAccount.getAccount()), "rate_limited");
  const binanceSent = s.binance.sent;
  assert.equal(await kind(s.binanceAccount.getAccount()), "rate_limited");
  assert.equal(s.binance.sent, binanceSent);
  assert.equal(await kind(s.htxAccount.getAccount()), "served");
  assert.equal(await kind(s.htxMarket.getLastPrice("BTC-USDT")), "served");
});

test("HTX's per-user rate limit holds back only that HTX account's signed requests", async () => {
  const s = sideBySide();
  const other = s.registry.connect("htx", {
    kind: "hmac",
    apiKey: s.htx.apiKey,
    secret: s.htx.apiSecret,
  });
  s.htx.failNext(
    "/v1/account/accounts",
    () => new Response(`{"code":1006,"message":"Exceed rate limit"}`),
  );
  assert.equal(await kind(s.htxAccount.getAccount()), "rate_limited");
  assert.equal(await kind(s.htxAccount.getAccount()), "rate_limited");
  // The venue's public data and another HTX account still go, as does Binance.
  assert.equal(await kind(s.htxAccount.getLastPrice("BTC-USDT")), "served");
  assert.equal(await kind(other.getAccount()), "served");
  assert.equal(await kind(s.binanceAccount.getAccount()), "served");
});

test("each venue keeps its own clock: a skew on one is corrected there only", async () => {
  const s = sideBySide();
  s.binance.ahead = 2_000;
  await s.binanceAccount.getAccount();
  await s.htxAccount.getAccount();
  assert.equal(s.binance.timeRequests, 1);
  assert.equal(s.timeRequests(), 1);
  assert.equal(
    s.registry.get("binance-spot-testnet")!.limits.clock.offset,
    2_000,
  );
  assert.equal(s.registry.get("htx")!.limits.clock.offset, 0);

  // Binance says the timestamp is outside its window: Binance reads its
  // time again before its next signed request, HTX does not.
  s.binance.answers.push(() =>
    Response.json(
      {
        code: -1021,
        msg: "Timestamp for this request is outside of the recvWindow.",
      },
      { status: 400 },
    ),
  );
  assert.equal(await kind(s.binanceAccount.getAccount()), "unavailable");
  assert.equal(await kind(s.htxAccount.getAccount()), "served");
  assert.equal(await kind(s.binanceAccount.getAccount()), "served");
  assert.equal(s.binance.timeRequests, 2);
  assert.equal(s.timeRequests(), 1);

  // HTX's clock jumps: HTX reads its time again, Binance does not.
  const htxClock = s.htx.now;
  s.htx.now = () => htxClock() + 600_000;
  assert.equal(await kind(s.htxAccount.getAccount()), "served");
  assert.equal(s.timeRequests(), 2);
  assert.equal(s.registry.get("htx")!.limits.clock.offset, 600_000);
  assert.equal(await kind(s.binanceAccount.getAccount()), "served");
  assert.equal(s.binance.timeRequests, 2);
  // A minute later HTX cannot say its time: HTX is unavailable, Binance is
  // served.
  s.advance(60_000);
  s.htx.now = () => htxClock() + 1_200_000;
  s.htx.failNext(
    "/v1/common/timestamp",
    () => new Response("", { status: 503 }),
  );
  assert.equal(await kind(s.htxAccount.getAccount()), "unavailable");
  assert.equal(await kind(s.binanceAccount.getAccount()), "served");
});
