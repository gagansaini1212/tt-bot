import {
  assertRowLevelSecurity,
  DEV_EXCHANGE_ACCOUNT_ID,
  withCustomerScope,
  type Database,
} from "@crypto-trading/database";

/** The exchange account a request acts on, and the customer who owns it. */
export type AccountScope = { customerId: string; exchangeAccountId: string };

/**
 * Returns the account the worker trades on if `customerId` owns it, or
 * undefined. Throws if the database cannot answer.
 */
export type AccountResolver = (
  customerId: string,
) => Promise<AccountScope | undefined>;

/**
 * The exchange account the worker's Binance testnet credentials belong to.
 * There is one set of credentials, the seeded dev customer's, until exchange
 * accounts keep their own.
 */
export const TESTNET_EXCHANGE_ACCOUNT_ID = DEV_EXCHANGE_ACCOUNT_ID;

/**
 * Looks the testnet account up in the requesting customer's scope, so
 * row-level security hides it from every other customer. Live accounts, and
 * accounts the customer removed, are refused. Before the first lookup it checks that row-level security applies
 * to the worker's database role at all.
 */
export function accountResolver(database: Database): AccountResolver {
  const exchangeAccountId = TESTNET_EXCHANGE_ACCOUNT_ID;
  let secured: Promise<void> | undefined;
  let lastLogged: string | undefined;
  return async (customerId) => {
    try {
      secured ??= assertRowLevelSecurity(database).catch((error: unknown) => {
        secured = undefined;
        throw error;
      });
      await secured;
      const [account] = await withCustomerScope(
        database,
        customerId,
        (transaction) => transaction`
          select id from exchange_accounts
          where id = ${exchangeAccountId}
            and exchange = 'binance-spot-testnet'
            and mode = 'simulation'
            and status not in ('disconnected', 'handed_over')
        `,
      );
      lastLogged = undefined;
      return account ? { customerId, exchangeAccountId } : undefined;
    } catch (error) {
      // Refreshing pages retry every few seconds, so say it once.
      const message = `The execution worker cannot use PostgreSQL: ${error instanceof Error ? error.message : "unknown error"}`;
      if (message !== lastLogged) console.error(message);
      lastLogged = message;
      throw error;
    }
  };
}
