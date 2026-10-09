import { venueFor, type ServedAccount } from "@crypto-trading/exchanges";
import { z } from "zod";
import type { ExchangeAccount } from "../accounts";
import { customerHandler } from "../http";

/**
 * The customer's exchange accounts that the worker serves, oldest first,
 * with each one's venue, whether it is read only, and whether its venue
 * serves it now. Every account route takes one of their IDs.
 */
export function accounts(
  list: (customerId: string) => Promise<ExchangeAccount[]>,
) {
  return customerHandler({
    query: z.strictObject({}),
    async handle({ customerId }) {
      return {
        status: "connected",
        accounts: (await list(customerId)).map((account): ServedAccount => ({
          id: account.exchangeAccountId,
          venue: account.venue,
          venueName: venueFor(account.venue).name,
          label: account.label,
          accountingCurrency: account.accountingCurrency,
          readOnly: account.readOnly,
          status: account.status,
        })),
      };
    },
  });
}
