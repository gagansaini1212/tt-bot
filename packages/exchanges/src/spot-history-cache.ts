import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Instrument } from "@crypto-trading/domain";
import { z } from "zod";
import {
  BinanceSpotHistory,
  type HistoricalSymbolFilters,
} from "./binance-spot-history";
import { klineSchema, type Kline } from "./contract";
import { marketRulesSchema } from "./market-catalogue";
import { binanceVenueSymbols } from "./venues";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const filtersSchema = z.object({
  rules: marketRulesSchema,
  maxStopOrders: z.int().positive(),
});

const utcDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Keeps downloaded history on disk, one file per market and UTC day, so a
 * backtest downloads each day once. Only a day that has ended with all 24
 * hourly candles is kept: its candles are final. Filters are kept for the UTC
 * day they were read on. The files are plain JSON under `directory`.
 */
export class SpotHistoryCache {
  readonly directory: string;
  readonly #source: Pick<BinanceSpotHistory, "getKlines" | "getSymbolFilters">;
  readonly #now: () => number;

  constructor(
    options: {
      source?: Pick<BinanceSpotHistory, "getKlines" | "getSymbolFilters">;
      directory?: string;
      now?: () => number;
    } = {},
  ) {
    // Runtime data, not part of the build: bundlers need not trace it.
    this.directory = resolve(
      /*turbopackIgnore: true*/ options.directory ??
        process.env.MARKET_HISTORY_CACHE_DIR ??
        ".market-history",
    );
    this.#source = options.source ?? new BinanceSpotHistory();
    this.#now = options.now ?? Date.now;
  }

  #path(instrument: Instrument, kind: "1h" | "filters", day: number) {
    return resolve(
      this.directory,
      binanceVenueSymbols.toVenueSymbol(instrument),
      kind,
      `${utcDate(day)}.json`,
    );
  }

  async #read<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Missing or unreadable: download it again.
      return undefined;
    }
  }

  // Best effort: a backtest still runs if the cache cannot be written.
  async #write(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, path);
    } catch {
      return;
    }
  }

  /**
   * Closed hourly candles that open from `start` until before `end`, oldest
   * first. Days missing from the cache are downloaded together, in one run
   * of requests per gap.
   */
  async hourlyKlines(
    instrument: Instrument,
    start: number,
    end: number,
  ): Promise<Kline[]> {
    const now = this.#now();
    const days: number[] = [];
    for (
      let day = Math.floor(start / DAY_MS) * DAY_MS;
      day < end;
      day += DAY_MS
    )
      days.push(day);
    const byDay = new Map<number, Kline[]>();
    for (const day of days) {
      const cached = await this.#read(
        this.#path(instrument, "1h", day),
        z.array(klineSchema).refine((klines) => isWholeDay(klines, day)),
      );
      if (cached) byDay.set(day, cached);
    }

    let gapStart: number | undefined;
    for (const day of [...days, undefined]) {
      const missing = day !== undefined && !byDay.has(day);
      if (missing) gapStart ??= day;
      if (missing || gapStart === undefined) continue;
      const gapEnd = day ?? days[days.length - 1] + DAY_MS;
      const klines = await this.#source.getKlines(
        instrument,
        "1h",
        gapStart,
        gapEnd,
      );
      for (let from = gapStart; from < gapEnd; from += DAY_MS) {
        const dayKlines = klines.filter(
          (kline) => kline.openTime >= from && kline.openTime < from + DAY_MS,
        );
        byDay.set(from, dayKlines);
        if (from + DAY_MS <= now && isWholeDay(dayKlines, from))
          await this.#write(this.#path(instrument, "1h", from), dayKlines);
      }
      gapStart = undefined;
    }

    return days
      .flatMap((day) => byDay.get(day) ?? [])
      .filter(
        (kline) =>
          kline.openTime >= start &&
          kline.openTime < end &&
          kline.closeTime < now,
      );
  }

  /** The market's filters, read at most once a UTC day. */
  async symbolFilters(
    instrument: Instrument,
  ): Promise<HistoricalSymbolFilters> {
    const path = this.#path(instrument, "filters", this.#now());
    const cached = await this.#read(path, filtersSchema);
    if (cached && cached.rules.instrument === instrument) return cached;
    const filters = await this.#source.getSymbolFilters(instrument);
    await this.#write(path, filters);
    return filters;
  }
}

/** All 24 hourly candles of the day starting at `day`, in order. */
function isWholeDay(klines: readonly Kline[], day: number) {
  return (
    klines.length === 24 &&
    klines.every((kline, hour) => kline.openTime === day + hour * HOUR_MS)
  );
}
