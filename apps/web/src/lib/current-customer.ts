import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { getAuth } from "./auth";

export type CurrentCustomer = {
  /** The customer every worker call and query acts for. */
  id: string;
  /** The signed-in login's name and email, for display. */
  name: string;
  email: string;
};

export type SignedIn = { customer: CurrentCustomer; signedInAt: Date };

/**
 * The signed-in customer and when they signed in, or null. Better Auth reads
 * the session from the database, so a session signed out elsewhere ends at
 * once. Once per request: the layout, the page and every worker call share
 * it.
 */
export const readSession = cache(async (): Promise<SignedIn | null> => {
  // First, so a build renders the page on each request rather than at build
  // time, when there is neither a database nor a secret.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  return {
    customer: {
      id: session.user.customerId,
      name: session.user.name,
      email: session.user.email,
    },
    signedInAt: new Date(session.session.createdAt),
  };
});

/**
 * The customer this request acts for, or null when nobody is signed in.
 * Everything the web app reads or changes for a customer starts here, and the
 * execution worker is told this customer on every call (see worker-client).
 * The proxy sends signed-out visitors to /sign-in, but server actions and
 * data access must still check: never trust that a page was protected.
 */
export async function getCurrentCustomer(): Promise<CurrentCustomer | null> {
  return (await readSession())?.customer ?? null;
}
