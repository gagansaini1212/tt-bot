import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { getAuth } from "./auth";
import { FRESH_SESSION_SECONDS } from "./auth-options";

export type CurrentCustomer = {
  /** The customer every worker call and query acts for. */
  id: string;
  /** The signed-in login's name and email, for display. */
  name: string;
  email: string;
};

type SignedIn = { customer: CurrentCustomer; signedInAt: Date };

// Better Auth reads the session from the database, so a session signed out
// elsewhere ends at once. Once per request: the layout, the page and every
// worker call share it.
const readSession = cache(async (): Promise<SignedIn | null> => {
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

/** Whether a session that started at `signedInAt` is still fresh at `now`. */
export function isFreshSession(signedInAt: Date, now = Date.now()): boolean {
  return now - signedInAt.getTime() < FRESH_SESSION_SECONDS * 1000;
}

export type FreshSessionCheck =
  | { status: "fresh"; customer: CurrentCustomer }
  | { status: "signed_out" | "stale" };

/**
 * Sensitive actions, such as changing exchange credentials or activating live
 * trading, need a customer who signed in within the last
 * `FRESH_SESSION_SECONDS`. Call this on the server at the start of every such
 * action and refuse unless it returns "fresh". Send a "stale" customer to
 * `signInPath(next, { reauthenticate: true })`: confirming their password
 * there starts a fresh session.
 */
export async function checkFreshSession(
  now = Date.now(),
): Promise<FreshSessionCheck> {
  const session = await readSession();
  if (!session) return { status: "signed_out" };
  return isFreshSession(session.signedInAt, now)
    ? { status: "fresh", customer: session.customer }
    : { status: "stale" };
}
