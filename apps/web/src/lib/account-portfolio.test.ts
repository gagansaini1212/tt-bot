import assert from "node:assert/strict";
import { afterEach, before, beforeEach, mock, test } from "node:test";
import { signInForTesting } from "./current-customer.testing";
import type * as AccountPortfolio from "./account-portfolio";
import type * as AssistantContext from "./assistant-context";

let getAccountPortfolio: typeof AccountPortfolio.getAccountPortfolio;
let getDrawdownAcrossAccounts: typeof AccountPortfolio.getDrawdownAcrossAccounts;
let saveReportingCurrency: typeof AccountPortfolio.saveReportingCurrency;
let assistantAccounts: typeof AssistantContext.assistantAccounts;

before(async () => {
  signInForTesting();
  ({ getAccountPortfolio, getDrawdownAcrossAccounts, saveReportingCurrency } =
    await import("./account-portfolio"));
  ({ assistantAccounts } = await import("./assistant-context"));
});

beforeEach(() => {
  process.env.EXECUTION_API_TOKEN = "web-test-token-at-least-32-characters";
  delete process.env.EXECUTION_API_URL;
});
afterEach(() => mock.restoreAll());

const served = {
  id: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a02",
  venue: "binance-spot-testnet",
  venueName: "Binance Spot Testnet",
  label: "Binance Spot Testnet",
  accountingCurrency: "USDT",
  mode: "simulation",
  status: "connected",
  access: "trade",
  served: true,
};
const htx = {
  ...served,
  id: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a0a",
  venue: "htx",
  venueName: "htx",
  label: "Savings",
  access: "read_only",
  served: false,
};
const second = {
  ...served,
  id: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a0b",
  label: "Second",
  served: false,
};
const options = [
  { currency: "USDT", available: true, unavailableFor: [] },
  { currency: "EUR", available: true, unavailableFor: [] },
];

const ticker = (
  symbol: string,
  lastPrice: string,
  openPrice: string,
  age = 1_000,
) => ({
  symbol,
  lastPrice,
  openPrice,
  highPrice: lastPrice,
  lowPrice: lastPrice,
  priceChange: "0",
  priceChangePercent: "0",
  volume: "1",
  quoteVolume: "1",
  openTime: Date.now() - age - 86_400_000,
  closeTime: Date.now() - age,
});

/** Answers like the worker, from `routes` by path; 503 for anything else. */
function mockWorker(routes: Record<string, unknown>) {
  return mock.method(globalThis, "fetch", async (input: string | URL) => {
    const { pathname } = new URL(String(input));
    if (!(pathname in routes))
      return Response.json({ status: "unavailable" }, { status: 503 });
    return Response.json({
      status: "connected",
      ...(routes[pathname] as object),
    });
  });
}

const snapshot = (balances: { asset: string; free: string }[]) => ({
  snapshot: {
    venue: "binance-spot-testnet",
    capturedAt: new Date().toISOString(),
    canTrade: true,
    balances: balances.map((balance) => ({ ...balance, locked: "0" })),
    orders: [],
    fills: [],
  },
});

test("totals every account in the reporting currency, and names the accounts and holdings it leaves out", async () => {
  mockWorker({
    "/portfolio": {
      portfolio: {
        reportingCurrency: "USDT",
        options,
        accounts: [served, htx, second],
      },
    },
    "/snapshot": snapshot([
      { asset: "USDT", free: "100" },
      { asset: "BTC", free: "0.01" },
      { asset: "XYZ", free: "5" },
      { asset: "ETH", free: "1" },
    ]),
    "/market/tickers": {
      tickers: [
        ticker("BTCUSDT", "60000", "50000"),
        // Last traded two minutes ago.
        ticker("ETHUSDT", "3000", "3000", 120_000),
      ],
    },
  });
  const { portfolio, overview } = await getAccountPortfolio();
  assert.equal(overview.status, "connected");
  if (overview.status !== "connected") return;
  const { combined } = overview.overview;

  assert.equal(combined.currency, "USDT");
  assert.equal(combined.total, "700");
  assert.equal(combined.change, "100");
  assert.equal(combined.complete, false);
  assert.equal(combined.counted, 1);
  assert.deepEqual(
    combined.leftOutAccounts.map(({ label, reason }) => [label, reason]),
    [
      ["htx · Savings", "The execution worker does not read this account."],
      [
        "Binance Spot Testnet · Second",
        "The execution worker does not read this account.",
      ],
    ],
  );
  assert.deepEqual(
    combined.unconverted.map(({ asset, status }) => [asset, status]),
    [
      ["XYZ", "missing"],
      ["ETH", "stale"],
    ],
  );
  assert.equal(portfolio.status, "connected");
  if (portfolio.status === "connected")
    assert.equal(portfolio.portfolio.currency, "USDT");
});

test("values in the customer's reporting currency with the account's own venue prices", async () => {
  mockWorker({
    "/portfolio": {
      portfolio: { reportingCurrency: "EUR", options, accounts: [served] },
    },
    "/snapshot": snapshot([{ asset: "USDT", free: "112.5" }]),
    "/market/tickers": { tickers: [ticker("EURUSDT", "1.125", "1.125")] },
  });
  const { overview } = await getAccountPortfolio();
  assert.equal(overview.status, "connected");
  if (overview.status !== "connected") return;
  assert.equal(overview.overview.combined.total, "100");
  assert.equal(overview.overview.combined.complete, true);
});

test("an account whose prices are unavailable is not counted, and says why", async () => {
  mockWorker({
    "/portfolio": {
      portfolio: { reportingCurrency: "USDT", options, accounts: [served] },
    },
    "/snapshot": snapshot([{ asset: "USDT", free: "10" }]),
  });
  const { overview } = await getAccountPortfolio();
  assert.equal(overview.status, "connected");
  if (overview.status !== "connected") return;
  const { combined } = overview.overview;
  assert.equal(combined.counted, 0);
  assert.equal(combined.complete, false);
  assert.match(combined.leftOutAccounts[0].reason, /execution worker/);
});

test("without the account list, totals are unavailable, and the assistant cannot name the account", async () => {
  mockWorker({
    "/snapshot": snapshot([{ asset: "USDT", free: "10" }]),
    "/market/tickers": { tickers: [] },
  });
  const { account, portfolio, overview } = await getAccountPortfolio();
  assert.equal(overview.status, "unavailable");
  // The Accounts page still values the account, in the default currency.
  assert.equal(portfolio.status, "connected");
  if (portfolio.status === "connected")
    assert.equal(portfolio.portfolio.total, "10");
  const [context] = assistantAccounts(account, overview);
  assert.equal(context.exchangeAccountId, null);
  assert.equal(context.canTrade, false);
});

test("the assistant sees each account labelled, with its own snapshot or why it has none", async () => {
  mockWorker({
    "/portfolio": {
      portfolio: {
        reportingCurrency: "USDT",
        options,
        accounts: [served, htx, second],
      },
    },
    "/snapshot": snapshot([{ asset: "USDT", free: "10" }]),
    "/market/tickers": { tickers: [] },
  });
  const { account, overview } = await getAccountPortfolio();
  const contexts = assistantAccounts(account, overview);

  assert.deepEqual(
    contexts.map(({ exchangeAccountId, venue, label, readOnly, canTrade }) => [
      exchangeAccountId,
      venue,
      label,
      readOnly,
      canTrade,
    ]),
    [
      [served.id, "Binance Spot Testnet", "Binance Spot Testnet", false, true],
      [htx.id, "htx", "Savings", true, false],
      [second.id, "Binance Spot Testnet", "Second", false, false],
    ],
  );
  const [main, , other] = contexts as {
    snapshot: {
      snapshotId: string;
      dataKind: string;
      account: { exchangeAccountId: string };
    } | null;
    noSnapshot?: string;
  }[];
  assert.equal(main.snapshot?.account.exchangeAccountId, served.id);
  assert.equal(main.snapshot?.dataKind, "Binance Spot Testnet, virtual funds");
  assert.match(main.snapshot?.snapshotId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(other.snapshot, null);
  assert.match(other.noSnapshot ?? "", /does not read this account/);
});

test("an account's snapshot for the assistant includes its accounting currency's balance", async () => {
  mockWorker({
    "/portfolio": {
      portfolio: {
        reportingCurrency: "USDT",
        options,
        accounts: [{ ...served, accountingCurrency: "EUR" }],
      },
    },
    "/snapshot": snapshot([
      { asset: "EUR", free: "250" },
      { asset: "XRP", free: "9" },
    ]),
    "/market/tickers": { tickers: [] },
  });
  const { account, overview } = await getAccountPortfolio();
  const [context] = assistantAccounts(account, overview) as {
    snapshot: { balances: { asset: string }[] } | null;
  }[];
  assert.deepEqual(
    context.snapshot?.balances.map(({ asset }) => asset),
    ["EUR"],
  );
});

test("the drawdown across accounts converts each account's result, and is left out when it would repeat one account's", async () => {
  const today = Promise.resolve({ pnl: "-25", allocation: "1000" });
  mockWorker({
    "/portfolio": {
      portfolio: {
        reportingCurrency: "USDT",
        options,
        accounts: [served, htx],
      },
    },
  });
  // One trading account, already in USDT: the Strategies page shows it.
  assert.equal(await getDrawdownAcrossAccounts(today), undefined);

  mock.restoreAll();
  mockWorker({
    "/portfolio": {
      portfolio: {
        reportingCurrency: "EUR",
        options,
        accounts: [served, htx, second],
      },
    },
    "/market/tickers": { tickers: [ticker("EURUSDT", "1.25", "1.25")] },
  });
  const across = await getDrawdownAcrossAccounts(today);
  assert.equal(across?.status, "connected");
  if (across?.status !== "connected") return;
  // The read-only account runs no strategies, so only two are trading.
  assert.equal(across.accounts, 2);
  assert.equal(across.drawdown.pnl, "-20");
  assert.equal(across.drawdown.allocation, "800");
  assert.equal(across.drawdown.drawdownPercent, "2.5");
  assert.equal(across.drawdown.complete, false);
  assert.deepEqual(
    across.drawdown.leftOut.map(({ label }) => label),
    ["Binance Spot Testnet · Second"],
  );
});

test("changing the reporting currency says what the worker did", async () => {
  const fetch = mockWorker({
    "/settings/reporting-currency": {
      change: {
        result: "refused",
        message: "GBP is not offered.",
        reportingCurrency: "USDT",
      },
    },
  });
  assert.deepEqual(await saveReportingCurrency({ reportingCurrency: "GBP" }), {
    result: "refused",
    message: "GBP is not offered.",
  });
  const init = fetch.mock.calls[0].arguments[1] as RequestInit;
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(String(init.body)), { reportingCurrency: "GBP" });

  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const unknown = await saveReportingCurrency({ reportingCurrency: "EUR" });
  assert.equal(unknown.result, "unconfirmed");
});

test("every account the worker serves counts with its own snapshot, and one its venue cannot serve is named", async () => {
  const third = {
    ...second,
    id: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a0c",
    label: "Third",
    served: true,
  };
  const servedSecond = { ...second, served: true };
  const balances: Record<string, { asset: string; free: string }[]> = {
    [served.id]: [{ asset: "USDT", free: "100" }],
    [servedSecond.id]: [{ asset: "USDT", free: "250" }],
  };
  const fetch = mock.method(
    globalThis,
    "fetch",
    async (input: string | URL, init: RequestInit = {}) => {
      const { pathname } = new URL(String(input));
      const account = (init.headers as Record<string, string>)[
        "X-Exchange-Account-Id"
      ];
      if (pathname === "/portfolio")
        return Response.json({
          status: "connected",
          portfolio: {
            reportingCurrency: "USDT",
            options,
            accounts: [served, servedSecond, third],
          },
        });
      if (pathname === "/market/tickers")
        return Response.json({ status: "connected", tickers: [] });
      if (pathname === "/snapshot" && balances[account])
        return Response.json({
          status: "connected",
          ...snapshot(balances[account]),
        });
      // The third account's venue cannot serve it now.
      return Response.json({ status: "unavailable" }, { status: 503 });
    },
  );
  const { overview } = await getAccountPortfolio();
  assert.equal(overview.status, "connected");
  if (overview.status !== "connected") return;
  const { combined } = overview.overview;
  assert.equal(combined.total, "350");
  assert.equal(combined.counted, 2);
  assert.equal(combined.complete, false);
  assert.deepEqual(
    combined.leftOutAccounts.map(({ label }) => label),
    ["Binance Spot Testnet · Third"],
  );
  // Each account's snapshot was read for it, once.
  const snapshots = fetch.mock.calls
    .filter(
      (call) => new URL(String(call.arguments[0])).pathname === "/snapshot",
    )
    .map(
      (call) =>
        (call.arguments[1]?.headers as Record<string, string>)[
          "X-Exchange-Account-Id"
        ],
    );
  assert.deepEqual(
    snapshots.sort(),
    [served.id, servedSecond.id, third.id].sort(),
  );
  // The assistant sees each account with its own balances, never another's.
  const contexts = assistantAccounts(
    { status: "unavailable", message: "unused" },
    overview,
  ) as {
    exchangeAccountId: string;
    snapshot: { balances: { free: string }[] } | null;
  }[];
  assert.deepEqual(
    contexts.map((context) => [
      context.exchangeAccountId,
      context.snapshot?.balances[0]?.free ?? null,
    ]),
    [
      [served.id, "100"],
      [servedSecond.id, "250"],
      [third.id, null],
    ],
  );
});
