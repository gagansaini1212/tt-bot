import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HistoricalSymbolFilters } from "./binance-spot-history.js";
import type { KlineInterval, Kline } from "./contract.js";
import { SpotHistoryCache } from "./spot-history-cache.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-09-01T00:00:00Z
const SEPT_1 = Date.UTC(2026, 8, 1);

const directories: string[] = [];
after(() =>
  Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  ),
);

function kline(openTime: number): Kline {
  return {
    openTime,
    open: "100",
    high: "101",
    low: "99",
    close: "100.5",
    volume: "1",
    closeTime: openTime + HOUR - 1,
    quoteVolume: "100",
    trades: 1,
  };
}

const filters: HistoricalSymbolFilters = {
  rules: {
    instrument: "BTC-USDT",
    venueSymbol: "BTCUSDT",
    status: "trading",
    protectedEntryAllowed: true,
    minPrice: "0.01",
    maxPrice: "1000000",
    tickSize: "0.01",
    minQty: "0.00001",
    maxQty: "9000",
    stepSize: "0.00001",
    minNotional: "5",
    maxNotional: "9000000",
  },
  maxStopOrders: 5,
};

async function setup(now: number) {
  const directory = await mkdtemp(join(tmpdir(), "ct-history-"));
  directories.push(directory);
  const requests: [number, number][] = [];
  const source = {
    async getKlines(
      _instrument: string,
      _interval: KlineInterval,
      start: number,
      end: number,
    ) {
      requests.push([start, end]);
      const klines: Kline[] = [];
      // Binance has candles up to the current hour, the last still open.
      for (let time = start; time < end && time <= now; time += HOUR)
        klines.push(kline(time));
      return klines;
    },
    filterReads: 0,
    async getSymbolFilters() {
      this.filterReads++;
      return filters;
    },
  };
  const cache = new SpotHistoryCache({
    source,
    directory,
    now: () => now,
  });
  return { cache, source, requests, directory };
}

test("downloads missing days once and keeps the ended ones", async () => {
  // Midday on 3 September.
  const now = SEPT_1 + 2 * DAY + 12 * HOUR + 5 * 60_000;
  const { cache, requests, directory } = await setup(now);
  const klines = await cache.hourlyKlines("BTC-USDT", SEPT_1, SEPT_1 + 3 * DAY);
  // Two whole days and the 12 hours of 3 September that have closed.
  assert.equal(klines.length, 48 + 12);
  assert.equal(klines.at(-1)!.openTime, SEPT_1 + 2 * DAY + 11 * HOUR);
  assert.deepEqual(requests, [[SEPT_1, SEPT_1 + 3 * DAY]]);
  assert.deepEqual(await readdir(join(directory, "BTCUSDT", "1h")), [
    "2026-09-01.json",
    "2026-09-02.json",
  ]);

  // Again: the ended days come from disk, and only today is downloaded.
  const again = await cache.hourlyKlines("BTC-USDT", SEPT_1, SEPT_1 + 3 * DAY);
  assert.deepEqual(again, klines);
  assert.deepEqual(requests.at(-1), [SEPT_1 + 2 * DAY, SEPT_1 + 3 * DAY]);
  assert.equal(requests.length, 2);
});

test("downloads each gap between cached days in one run", async () => {
  const now = SEPT_1 + 10 * DAY;
  const { cache, requests } = await setup(now);
  await cache.hourlyKlines("ETH-USDT", SEPT_1 + 2 * DAY, SEPT_1 + 3 * DAY);
  await cache.hourlyKlines("ETH-USDT", SEPT_1 + 5 * DAY, SEPT_1 + 6 * DAY);
  requests.length = 0;
  const klines = await cache.hourlyKlines(
    "ETH-USDT",
    SEPT_1 + 6 * HOUR,
    SEPT_1 + 7 * DAY,
  );
  assert.equal(klines.length, 7 * 24 - 6);
  assert.equal(klines[0].openTime, SEPT_1 + 6 * HOUR);
  assert.deepEqual(requests, [
    [SEPT_1, SEPT_1 + 2 * DAY],
    [SEPT_1 + 3 * DAY, SEPT_1 + 5 * DAY],
    [SEPT_1 + 6 * DAY, SEPT_1 + 7 * DAY],
  ]);
});

test("downloads a damaged or incomplete day again", async () => {
  const { cache, requests, directory } = await setup(SEPT_1 + 5 * DAY);
  await cache.hourlyKlines("BTC-USDT", SEPT_1, SEPT_1 + DAY);
  const path = join(directory, "BTCUSDT", "1h", "2026-09-01.json");
  await writeFile(path, "{not json");
  await cache.hourlyKlines("BTC-USDT", SEPT_1, SEPT_1 + DAY);
  await writeFile(path, JSON.stringify([kline(SEPT_1)]));
  const klines = await cache.hourlyKlines("BTC-USDT", SEPT_1, SEPT_1 + DAY);
  assert.equal(klines.length, 24);
  assert.equal(requests.length, 3);
});

test("reads a market's filters once a UTC day", async () => {
  const { cache, source } = await setup(SEPT_1 + 5 * DAY);
  assert.deepEqual(await cache.symbolFilters("BTC-USDT"), filters);
  assert.deepEqual(await cache.symbolFilters("BTC-USDT"), filters);
  assert.equal(source.filterReads, 1);
});
