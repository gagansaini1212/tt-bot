// Browser-safe: the exchange accounts the execution worker serves for a
// customer, as the dashboard chooses between them.
import { z } from "zod";
import { venueIdSchema } from "./venues";

export const servedAccountSchema = z.object({
  id: z.uuid(),
  venue: venueIdSchema,
  // The venue as the dashboard names it.
  venueName: z.string().max(100),
  label: z.string().max(200),
  accountingCurrency: z.string().max(20),
  // The worker monitors a read-only account and never trades on it.
  readOnly: z.boolean(),
  // `unavailable` while its venue cannot serve it: entries wait.
  status: z.enum(["connected", "reconciling", "unavailable"]),
});
export type ServedAccount = z.infer<typeof servedAccountSchema>;

/**
 * The account the dashboard acts on when the customer has not chosen one:
 * their oldest account that trades, else their oldest one.
 */
export function defaultAccount<T extends { readOnly: boolean }>(
  accounts: readonly T[],
): T | undefined {
  return accounts.find((account) => !account.readOnly) ?? accounts[0];
}
