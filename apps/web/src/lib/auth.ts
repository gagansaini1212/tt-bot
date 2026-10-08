import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import { authOptions } from "./auth-options";
import { authSecret } from "./auth-secret";

/** Better Auth for this app. Use `getAuth()`; tests pass their own env. */
export function createAuth(env: NodeJS.ProcessEnv = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "Set DATABASE_URL in .env to sign customers in. See docs/database.md.",
    );
  return betterAuth({
    ...authOptions(new Pool({ connectionString, max: 5 })),
    secret: authSecret(env),
    // The dashboard must stay on this machine (see README.md), so Better Auth
    // serves only requests addressed to it.
    baseURL: {
      allowedHosts: [
        "localhost",
        "localhost:*",
        "127.0.0.1",
        "127.0.0.1:*",
        "[::1]",
        "[::1]:*",
      ],
      protocol: "http",
    },
    // Sets the session cookie when a server action signs in or out. Last.
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per server process, kept across development reloads so each
// reload does not open another connection pool.
const shared = globalThis as { cryptoTradingAuth?: Auth };

/**
 * Better Auth, created on first use so that builds need neither a database
 * nor a secret.
 */
export function getAuth(): Auth {
  return (shared.cryptoTradingAuth ??= createAuth());
}
