import { z } from "zod";

/**
 * An instrument, named BASE-QUOTE as in the domain package's
 * instrumentSchema, narrowed to Latin capitals and digits so model providers
 * accept the pattern. The execution worker refuses one the customer's
 * exchange account does not allow, so the tools need not know the list.
 */
export const instrument = z
  .string()
  .regex(/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/)
  .describe(
    "The instrument as BASE-QUOTE, such as BTC-USDT. The worker refuses a market the customer's exchange account does not allow.",
  );
