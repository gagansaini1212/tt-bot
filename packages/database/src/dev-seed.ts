// Stable IDs of the development data `pnpm db:seed` creates. This module has
// no imports, so the web app can read the IDs without a database client.

/** The customer every request acts for until customer sign-in (#35). */
export const DEV_CUSTOMER_ID = "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a01";

/**
 * The dev customer's Binance Spot Testnet exchange account, in simulation
 * mode. The execution worker's testnet credentials belong to it.
 */
export const DEV_EXCHANGE_ACCOUNT_ID = "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7a02";
