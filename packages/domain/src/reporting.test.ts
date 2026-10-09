import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Decimal from "decimal.js";

import type { Instrument } from "./instruments";
import {
  combineAccounts,
  conversionRoute,
  convertAmount,
  DEFAULT_REPORTING_CURRENCY,
  drawdownAcrossAccounts,
  reportingCurrencyOptions,
  unitPrice,
  valueAccount,
  VALUATION_FRESHNESS_MS,
  type MarketPrice,
  type PriceSource,
} from "./reporting";

const now = new Date("2026-10-09T12:00:00.000Z");
const fresh = now.getTime() - 5_000;

/** A venue's prices from `[instrument, price, open?]`, all observed `at`. */
function venue(
  markets: [Instrument, string, string?][],
  at = fresh,
): PriceSource {
  const prices = new Map<Instrument, MarketPrice>(
    markets.map(([instrument, price, openPrice]) => [
      instrument,
      { price, openPrice, observedAt: at },
    ]),
  );
  return (instrument) => prices.get(instrument);
}

describe("conversionRoute", () => {
  const prices = venue([
    ["BTC-USDT", "60000"],
    ["USDT-TRY", "40"],
    ["USDC-USDT", "1.0005"],
    ["EUR-USDT", "1.1"],
    ["EUR-USDC", "1.0995"],
    ["ABC-USDC", "2"],
    ["XYZ-BTC", "0.001"],
    ["BTC-EUR", "55000"],
  ]);
  const legs = (from: string, to: string) =>
    conversionRoute(from, to, prices)?.legs.map(
      (leg) => `${leg.side === "base" ? "×" : "÷"} ${leg.instrument}`,
    );

  it("needs no market when the amount is already in the currency", () => {
    assert.deepEqual(legs("USDT", "USDT"), []);
  });

  it("uses one market between the two currencies, in either direction", () => {
    assert.deepEqual(legs("BTC", "USDT"), ["× BTC-USDT"]);
    assert.deepEqual(legs("TRY", "USDT"), ["÷ USDT-TRY"]);
    assert.deepEqual(legs("USDT", "USDC"), ["÷ USDC-USDT"]);
    // A direct market wins over a route through USDT.
    assert.deepEqual(legs("EUR", "USDC"), ["× EUR-USDC"]);
  });

  it("goes through USDT, then USDC, and no further", () => {
    assert.deepEqual(legs("TRY", "USDC"), ["÷ USDT-TRY", "÷ USDC-USDT"]);
    assert.deepEqual(legs("ABC", "USDT"), ["× ABC-USDC", "× USDC-USDT"]);
    // XYZ trades only against BTC, and BTC is not a bridge.
    assert.equal(legs("XYZ", "USDT"), undefined);
    // Nor are three markets used: TRY → USDT → BTC → EUR is too long.
    assert.equal(legs("XYZ", "EUR"), undefined);
  });

  it("never treats stablecoins or fiat as equal", () => {
    const noBridge = venue([["BTC-USDT", "60000"]]);
    assert.equal(conversionRoute("USDC", "USDT", noBridge), undefined);
    assert.equal(conversionRoute("USD", "USDT", noBridge), undefined);
  });

  it("tries USDT before USDC when both bridges exist", () => {
    const both = venue([
      ["ABC-USDT", "2"],
      ["ABC-USDC", "2.1"],
      ["EUR-USDT", "1.1"],
      ["EUR-USDC", "1.09"],
    ]);
    assert.deepEqual(
      conversionRoute("ABC", "EUR", both)?.legs.map((leg) => leg.instrument),
      ["ABC-USDT", "EUR-USDT"],
    );
  });

  it("takes the first market that exists, even when it has no usable price", () => {
    const zero = venue([
      ["BTC-USDT", "0"],
      ["BTC-USDC", "59900"],
      ["USDC-USDT", "1"],
    ]);
    // The listed BTC-USDT market decides the route...
    assert.deepEqual(
      conversionRoute("BTC", "USDT", zero)?.legs.map((leg) => leg.instrument),
      ["BTC-USDT"],
    );
    // ...so the conversion is missing, not taken through USDC.
    assert.deepEqual(convertAmount("1", "BTC", "USDT", zero, now), {
      status: "missing",
      reason: "no_price",
      from: "BTC",
      to: "USDT",
    });
  });
});

describe("convertAmount", () => {
  it("converts exactly, recording the route's prices and times", () => {
    const prices = venue([
      ["USDT-TRY", "40", "39.5"],
      ["USDC-USDT", "0.9998", "1.0001"],
    ]);
    const result = convertAmount("1000", "TRY", "USDC", prices, now);

    assert.equal(result.status, "converted");
    if (result.status !== "converted") return;
    // 1000 ÷ 40 ÷ 0.9998, cut at 100 significant digits, never a float.
    assert.equal(result.value.slice(0, 22), "25.0050010002000400080");
    assert.equal(result.value.replace(/\D/g, "").length, 100);
    assert.ok(
      new Decimal(result.value)
        .times("0.9998")
        .times(40)
        .minus(1000)
        .abs()
        .lessThan("1e-95"),
    );
    // At the open: 1000 ÷ 39.5 ÷ 1.0001.
    assert.equal(result.valueAtOpen?.slice(0, 12), "25.313924303");
    assert.deepEqual(
      result.route.legs.map(({ instrument, price, observedAt }) => ({
        instrument,
        price,
        observedAt,
      })),
      [
        { instrument: "USDT-TRY", price: "40", observedAt: fresh },
        { instrument: "USDC-USDT", price: "0.9998", observedAt: fresh },
      ],
    );
  });

  it("reports a missing route, never zero", () => {
    assert.deepEqual(
      convertAmount("3", "XYZ", "USDT", venue([["XYZ-BTC", "1"]]), now),
      { status: "missing", reason: "no_route", from: "XYZ", to: "USDT" },
    );
  });

  it("reports a stale price since it was observed, at the threshold's edge", () => {
    const at = (age: number) =>
      convertAmount(
        "1",
        "BTC",
        "USDT",
        venue([["BTC-USDT", "60000"]], now.getTime() - age),
        now,
      );
    assert.equal(at(VALUATION_FRESHNESS_MS).status, "converted");
    const stale = at(VALUATION_FRESHNESS_MS + 1);
    assert.equal(stale.status, "stale");
    if (stale.status === "stale")
      assert.equal(stale.since, now.getTime() - VALUATION_FRESHNESS_MS - 1);
  });

  it("is stale when any price on a two-market route is old", () => {
    const old = now.getTime() - 120_000;
    const prices: PriceSource = (instrument) =>
      instrument === "USDT-TRY"
        ? { price: "40", observedAt: fresh }
        : instrument === "USDC-USDT"
          ? { price: "1", observedAt: old }
          : undefined;
    const result = convertAmount("40", "TRY", "USDC", prices, now);
    assert.equal(result.status, "stale");
    if (result.status === "stale") assert.equal(result.since, old);
  });

  it("converts signed amounts, such as a loss", () => {
    const result = convertAmount(
      "-12.5",
      "USDT",
      "EUR",
      venue([["EUR-USDT", "1.25"]]),
      now,
    );
    assert.equal(result.status === "converted" && result.value, "-10");
  });
});

describe("valueAccount", () => {
  const prices = venue([
    ["BTC-USDT", "60000", "50000"],
    ["ETH-USDT", "3000"],
    ["XYZ-BTC", "0.5", "0.5"],
  ]);

  it("totals converted holdings and names those left out", () => {
    const valuation = valueAccount(
      [
        { asset: "USDT", quantity: "100" },
        { asset: "BTC", quantity: "0.01" },
        { asset: "ETH", quantity: "1" },
        { asset: "XYZ", quantity: "7" },
        { asset: "QQQ", quantity: "0" },
      ],
      "USDT",
      prices,
      now,
    );

    assert.equal(valuation.total, "3700");
    // BTC rose 100 USDT; ETH has no open price; USDT does not change.
    assert.equal(valuation.change, "100");
    assert.equal(valuation.changeBase, "600");
    assert.equal(valuation.converted, 3);
    // ETH counts in the total, but not in the 24h change, and says so.
    assert.equal(valuation.withoutOpen, 1);
    // A zero balance is never "left out".
    assert.deepEqual(valuation.unconverted, [
      { asset: "XYZ", quantity: "7", status: "missing", reason: "no_route" },
    ]);
  });
});

describe("unitPrice", () => {
  it("prices one unit along a route, now and at the open", () => {
    const route = conversionRoute(
      "TRY",
      "USDC",
      venue([
        ["USDT-TRY", "40", "50"],
        ["USDC-USDT", "1.25", "1"],
      ]),
    )!;
    assert.deepEqual(unitPrice(route), { price: "0.02", openPrice: "0.02" });
    assert.deepEqual(
      unitPrice(
        conversionRoute("BTC", "USDT", venue([["BTC-USDT", "60000"]]))!,
      ),
      { price: "60000", openPrice: null },
    );
  });
});

describe("combineAccounts", () => {
  const binance = {
    exchangeAccountId: "10000000-0000-4000-8000-0000000000a1",
    label: "Binance Spot Testnet · Main",
  };
  const htx = {
    exchangeAccountId: "10000000-0000-4000-8000-0000000000a2",
    label: "HTX · Savings",
  };

  it("adds every account's value in the reporting currency", () => {
    const valued = (
      total: string,
      change: string,
      changeBase: string,
      withoutOpen = 0,
    ) => ({
      currency: "USDT",
      holdings: [],
      total,
      change,
      changeBase,
      converted: 1,
      withoutOpen,
      unconverted: [],
    });
    const combined = combineAccounts("USDT", [
      { ...binance, status: "valued", valuation: valued("1000", "10", "990") },
      {
        ...htx,
        status: "valued",
        valuation: valued("500.5", "-20", "520.5", 2),
      },
    ]);

    assert.equal(combined.total, "1500.5");
    assert.equal(combined.change, "-10");
    // −10 on 1510.5 at the open.
    assert.equal(
      new Decimal(combined.changePercent!).toDecimalPlaces(6).toFixed(),
      "-0.662032",
    );
    assert.equal(combined.complete, true);
    assert.equal(combined.counted, 2);
    // Two holdings count in the total but not in the 24h change.
    assert.equal(combined.withoutOpen, 2);
  });

  it("leaves out an unavailable account and stale holdings, and says so", () => {
    const stale = now.getTime() - 300_000;
    const valuation = valueAccount(
      [
        { asset: "USDT", quantity: "250" },
        { asset: "ETH", quantity: "1" },
      ],
      "USDT",
      venue([["ETH-USDT", "3000"]], stale),
      now,
    );
    const combined = combineAccounts("USDT", [
      { ...binance, status: "valued", valuation },
      {
        ...htx,
        status: "unavailable",
        reason: "HTX is unreachable.",
        lastKnown: { total: "800", at: stale },
      },
    ]);

    // The last known 800 is shown apart, never counted.
    assert.equal(combined.total, "250");
    assert.equal(combined.complete, false);
    assert.deepEqual(combined.leftOutAccounts, [
      {
        ...htx,
        reason: "HTX is unreachable.",
        lastKnown: { total: "800", at: stale },
      },
    ]);
    assert.deepEqual(combined.unconverted, [
      {
        ...binance,
        asset: "ETH",
        quantity: "1",
        status: "stale",
        since: stale,
      },
    ]);
  });

  it("refuses to add figures in another currency", () => {
    assert.throws(() =>
      combineAccounts("USDT", [
        {
          ...binance,
          status: "valued",
          valuation: valueAccount([], "EUR", venue([]), now),
        },
      ]),
    );
  });
});

describe("drawdownAcrossAccounts", () => {
  const usdtVenue = venue([["EUR-USDT", "1.25"]]);

  it("shows the customer's strategies together in the reporting currency", () => {
    const result = drawdownAcrossAccounts(
      "EUR",
      [
        {
          exchangeAccountId: "a1",
          label: "Binance · Main",
          accountingCurrency: "USDT",
          prices: usdtVenue,
          today: { pnl: "-25", allocation: "1000" },
        },
        {
          exchangeAccountId: "a2",
          label: "Binance · Second",
          accountingCurrency: "USDT",
          prices: usdtVenue,
          today: { pnl: "5", allocation: "250" },
        },
      ],
      now,
    );

    // −20 USDT on 1250 USDT, or −16 EUR on 1000 EUR: 1.6%.
    assert.equal(result.pnl, "-16");
    assert.equal(result.allocation, "1000");
    assert.equal(result.drawdownPercent, "1.6");
    assert.equal(result.complete, true);
  });

  it("names accounts it cannot measure or convert, rather than guessing", () => {
    const result = drawdownAcrossAccounts(
      "EUR",
      [
        {
          exchangeAccountId: "a1",
          label: "Binance · Main",
          accountingCurrency: "USDT",
          prices: usdtVenue,
          unmeasured: "A fee in BNB cannot be valued.",
        },
        {
          exchangeAccountId: "a2",
          label: "Binance · Second",
          accountingCurrency: "USDT",
          prices: venue([]),
          today: { pnl: "-5", allocation: "250" },
        },
      ],
      now,
    );

    assert.equal(result.counted, 0);
    assert.equal(result.drawdownPercent, "0");
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.leftOut.map((entry) => entry.reason),
      [
        "A fee in BNB cannot be valued.",
        "Its venue has no market to convert USDT to EUR.",
      ],
    );
  });
});

describe("reportingCurrencyOptions", () => {
  const binanceLists = (instrument: Instrument) =>
    ["USDC-USDT", "EUR-USDT", "USDT-USD", "BTC-USDT"].includes(instrument);

  it("offers a currency only where every account has a route to it", () => {
    const options = reportingCurrencyOptions([
      {
        label: "Binance · Main",
        accountingCurrency: "USDT",
        lists: binanceLists,
      },
      // A venue whose markets the worker cannot read.
      { label: "HTX · Savings", accountingCurrency: "USDT" },
    ]);

    assert.deepEqual(
      options.map(({ currency, available, unavailableFor }) => [
        currency,
        available,
        unavailableFor,
      ]),
      [
        ["USDT", true, []],
        ["USDC", false, ["HTX · Savings"]],
        ["USD", false, ["HTX · Savings"]],
        ["EUR", false, ["HTX · Savings"]],
        ["GBP", false, ["Binance · Main", "HTX · Savings"]],
      ],
    );
  });

  it("offers only the default without an account", () => {
    assert.deepEqual(
      reportingCurrencyOptions([])
        .filter((option) => option.available)
        .map((option) => option.currency),
      [DEFAULT_REPORTING_CURRENCY],
    );
  });
});
