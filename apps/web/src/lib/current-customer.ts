import "server-only";
import { DEV_CUSTOMER_ID } from "@crypto-trading/database/dev-seed";

export type CurrentCustomer = { id: string };

/**
 * The customer this request acts for, or null when nobody is signed in.
 * Everything the web app reads or changes for a customer starts here, and the
 * execution worker is told this customer on every call (see worker-client).
 *
 * There is no customer sign-in yet, so every request acts for the seeded dev
 * customer. Customer sign-in (#35) replaces this body with a Better Auth
 * session lookup; callers already handle null.
 */
export async function getCurrentCustomer(): Promise<CurrentCustomer | null> {
  return { id: DEV_CUSTOMER_ID };
}
