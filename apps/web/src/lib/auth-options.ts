import type { BetterAuthOptions } from "better-auth";
import type { Pool } from "pg";

/**
 * How long after signing in a session stays fresh. Changing exchange
 * credentials or activating live trading needs a fresh session (see
 * `requireFreshSession`); Better Auth's own sensitive endpoints use it too.
 */
export const FRESH_SESSION_SECONDS = 10 * 60;

/**
 * Better Auth's options, apart from the Next.js cookie plugin, so tests can
 * build the same instance outside a request. The tables are created by
 * `packages/database/migrations/…_customer_sign_in.sql`; keep the names and
 * columns here in step with it. Better Auth checks them when it starts.
 */
export function authOptions(database: Pool) {
  return {
    appName: "Crypto Trading Agent",
    database,
    // Customers are created by the operator (and, locally, by pnpm db:seed),
    // so there is no sign-up.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    session: {
      modelName: "auth_sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
      freshAge: FRESH_SESSION_SECONDS,
    },
    user: {
      modelName: "auth_users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        // The customer this login acts for. Nobody can set it through Better
        // Auth's endpoints.
        customerId: {
          type: "string",
          fieldName: "customer_id",
          required: true,
          input: false,
        },
      },
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    advanced: {
      database: { generateId: "uuid" },
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}
