import { hkdfSync } from "node:crypto";
import {
  extractBearerToken,
  verifyJwtHmac,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";
import type { SessionAuth, SessionAuthContext } from "eve/context";

// The web app's proxy checks the customer's Better Auth session on every
// request to the assistant, then forwards it with a short-lived token naming
// the customer (apps/web/src/lib/assistant-token.ts). These values must match
// that file's.
const ISSUER = "crypto-trading-agent/web";
const AUDIENCE = "crypto-trading-agent/assistant";
const KEY_INFO = "crypto-trading-agent assistant token v1";

export const CUSTOMER_AUTHENTICATOR = "customer-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token key, derived from AUTH_SECRET so it is never the secret itself. */
function tokenKey(): string | undefined {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return undefined;
  return Buffer.from(
    hkdfSync("sha256", secret, new Uint8Array(0), KEY_INFO, 32),
  ).toString("hex");
}

/**
 * Accepts a request the web app vouched for, as the signed-in customer. Any
 * other request falls through to the next authenticator.
 */
export function customerSession(): AuthFn<Request> {
  return withAuthChallenges(
    async (request) => {
      const key = tokenKey();
      if (!key) return null;
      const result = await verifyJwtHmac(
        extractBearerToken(request.headers.get("authorization")),
        {
          algorithm: "HS256",
          issuer: ISSUER,
          audiences: [AUDIENCE],
          secret: key,
          clockSkewSeconds: 5,
        },
      );
      const customerId = result.ok ? result.sessionAuth.subject : undefined;
      if (!customerId || !UUID.test(customerId)) return null;
      return {
        authenticator: CUSTOMER_AUTHENTICATOR,
        issuer: ISSUER,
        principalId: customerId,
        principalType: "user",
        subject: customerId,
        attributes: {},
      } satisfies SessionAuthContext;
    },
    [{ scheme: "Bearer" }],
  );
}

function customerOf(caller: SessionAuthContext | null): string | undefined {
  return caller?.authenticator === CUSTOMER_AUTHENTICATOR &&
    caller.issuer === ISSUER &&
    caller.principalType === "user" &&
    UUID.test(caller.principalId)
    ? caller.principalId
    : undefined;
}

/**
 * The customer a turn acts for: the signed-in customer who sent it, who must
 * also be the customer who started the conversation. Every other caller is
 * refused, including eve's `localDev()` principal and Vercel OIDC `user`
 * principals, which identify developers and Vercel accounts rather than
 * customers. eve lets anyone who passes route auth continue a conversation
 * whose ID they know, so this keeps another customer from acting in it.
 */
export function customerIdFrom({ current, initiator }: SessionAuth): string {
  const customerId = customerOf(current);
  if (!customerId)
    throw new Error(
      current
        ? `A signed-in customer is required. The caller authenticated through "${current.authenticator}" as "${current.principalType}", which does not identify a customer. Sign in to the web app and use the assistant there.`
        : "A signed-in customer is required. Sign in to the web app and use the assistant there.",
    );
  if (customerOf(initiator) !== customerId)
    throw new Error(
      "This conversation belongs to another customer. Start a new conversation.",
    );
  return customerId;
}
