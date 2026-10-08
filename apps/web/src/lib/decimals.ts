import Decimal from "decimal.js";

/** The most decimal places any of these values uses, ignoring trailing zeros. */
export function fractionDigits(values: Iterable<string>): number {
  let digits = 0;
  for (const value of values) {
    const fraction = value.split(".")[1]?.replace(/0+$/, "") ?? "";
    digits = Math.max(digits, fraction.length);
  }
  return digits;
}

/** Rounds to `digits` places and groups thousands: "82384.5" → "82,384.50". */
export function formatDecimal(value: Decimal.Value, digits: number): string {
  const [whole, fraction] = new Decimal(value).toFixed(digits).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
