// Intl formats decimal strings exactly, so amounts are never converted to
// floating point. A fixed locale keeps server and browser output identical.
type NumericString = `${number}`;

const twoDecimals = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const signedTwoDecimals = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});
const smallPrice = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 4,
});
// Binance sends at most 8 decimals, well inside this limit.
const exact = [0, 2].map(
  (minimumFractionDigits) =>
    new Intl.NumberFormat("en-US", {
      minimumFractionDigits,
      maximumFractionDigits: 20,
    }),
);

/** A non-negative amount to two decimals. A nonzero amount that rounds to zero shows as "< 0.01". */
export function formatAmount(value: string) {
  const text = twoDecimals.format(value as NumericString);
  return text === "0.00" && /[1-9]/.test(value) ? "< 0.01" : text;
}

/**
 * An exact decimal without Binance's trailing zeros, such as "0.0012" for
 * "0.00120000". With `cents`, keeps at least two decimals: "82,364.70".
 */
export function formatDecimal(value: string, { cents = false } = {}) {
  return exact[cents ? 1 : 0].format(value as NumericString);
}

/** A signed amount to two decimals, such as "+12.30" or "-0.45". */
export function formatChange(value: string) {
  return signedTwoDecimals.format(value as NumericString);
}

/** A signed percentage to two decimals, such as "+1.25%". */
export function formatPercent(value: string) {
  return `${signedTwoDecimals.format(value as NumericString)}%`;
}

/** A price: two decimals from 1 up, four significant digits below 1. */
export function formatPrice(value: string) {
  return /^0(\.|$)/.test(value)
    ? smallPrice.format(value as NumericString)
    : twoDecimals.format(value as NumericString);
}

/** Like "2026-10-08 13:05:09 UTC". */
export function formatUtc(time: number) {
  return `${new Date(time).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** How long before `now` the time was, such as "5m ago". */
export function formatAge(time: number, now: number) {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
