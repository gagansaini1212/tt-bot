import "server-only";
import { redirect } from "next/navigation";
import { FRESH_SESSION_SECONDS } from "./auth-options";
import { readSession, type CurrentCustomer } from "./current-customer";
import { signInPath } from "./sign-in-path";

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
 * `FRESH_SESSION_SECONDS`. Prefer `requireFreshSession`. Use this when the
 * action must answer instead of redirecting, and refuse unless it returns
 * "fresh". Send a "stale" customer to `signInPath(next, { reauthenticate:
 * true })`: confirming their password there starts a fresh session.
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

/**
 * The customer, if they signed in within the last `FRESH_SESSION_SECONDS`.
 * Otherwise this redirects to /sign-in: to confirm their password if they
 * are signed in, then back to `next`. Call it on the server at the start of
 * every sensitive action, such as changing exchange credentials or
 * activating live trading.
 */
export async function requireFreshSession(
  next: string,
): Promise<CurrentCustomer> {
  const check = await checkFreshSession();
  if (check.status === "fresh") return check.customer;
  redirect(signInPath(next, { reauthenticate: check.status === "stale" }));
}
