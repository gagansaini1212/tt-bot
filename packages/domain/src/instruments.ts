import { z } from "zod";

// An asset code as a venue's catalogue normalizes it: capitals and digits,
// or letters of scripts without case, which some venues list. Never
// lowercase, separators, or anything that needs escaping.
const ASSET = "[\\p{Lu}\\p{Lo}\\p{Nd}]{1,20}";
const INSTRUMENT_PATTERN = new RegExp(`^(${ASSET})-(${ASSET})$`, "u");
const ASSET_PATTERN = new RegExp(`^${ASSET}$`, "u");

const INVALID =
  "Name the instrument as BASE-QUOTE, such as BTC-USDT: two asset codes in capitals, joined by a hyphen.";

/**
 * An instrument, named by its market in BASE-QUOTE form, such as BTC-USDT or
 * ETH-BTC, whatever the venue calls it. Each venue's adapter translates it to
 * and from the venue's own symbol (BTCUSDT on Binance). A valid name says
 * nothing about whether a venue lists it or a customer may trade it: the
 * venue's market catalogue and the customer's allowed instruments decide.
 */
export const instrumentSchema = z
  .templateLiteral([z.string(), "-", z.string()], { error: INVALID })
  .check(z.regex(INSTRUMENT_PATTERN, { error: INVALID }));
export type Instrument = z.infer<typeof instrumentSchema>;

/** Whether `value` names an instrument in BASE-QUOTE form. */
export function isInstrument(value: unknown): value is Instrument {
  return typeof value === "string" && INSTRUMENT_PATTERN.test(value);
}

/** BTC-USDT → { base: "BTC", quote: "USDT" } */
export function instrumentAssets(instrument: Instrument) {
  const match = INSTRUMENT_PATTERN.exec(instrument);
  if (!match) throw new Error(INVALID);
  return { base: match[1], quote: match[2] };
}

/** The instrument trading `base` against `quote`, or undefined if either is not a valid asset code. */
export function instrumentFor(
  base: string,
  quote: string,
): Instrument | undefined {
  return ASSET_PATTERN.test(base) && ASSET_PATTERN.test(quote)
    ? `${base}-${quote}`
    : undefined;
}

/** BTC-USDT → "BTC/USDT", as the dashboard shows a market. */
export function instrumentLabel(instrument: Instrument) {
  const { base, quote } = instrumentAssets(instrument);
  return `${base}/${quote}`;
}

/**
 * What an exchange account may trade until its customer changes it. The
 * account's allowed instruments narrow what its venue lists; a strategy's
 * rules and an execution policy narrow them again.
 */
export const DEFAULT_ALLOWED_INSTRUMENTS: readonly Instrument[] = [
  "BTC-USDT",
  "ETH-USDT",
];

/**
 * The most instruments an exchange account may allow. The worker reads each
 * one's open orders and fills for every snapshot, within the venue's request
 * weight.
 */
export const MAX_ALLOWED_INSTRUMENTS = 10;

/** A list of allowed instruments: at least one, each once. */
export const allowedInstrumentsSchema = z
  .array(instrumentSchema)
  .min(1)
  .max(MAX_ALLOWED_INSTRUMENTS)
  .refine((instruments) => new Set(instruments).size === instruments.length, {
    error: "List each instrument once.",
  });
