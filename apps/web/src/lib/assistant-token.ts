import { createHmac, hkdfSync } from "node:crypto";
import { authSecret } from "./auth-secret";

// The eve assistant runs as its own process and cannot read Better Auth
// sessions. The proxy checks the session on every assistant request, then
// forwards the request with this token, which names the customer for a
// minute. agent/lib/customer-principal.ts verifies it; keep these values in
// step with that file's.
const ISSUER = "crypto-trading-agent/web";
const AUDIENCE = "crypto-trading-agent/assistant";
const KEY_INFO = "crypto-trading-agent assistant token v1";
const LIFETIME_SECONDS = 60;

/** Derived from AUTH_SECRET, so the token key is never the secret itself. */
export function assistantTokenKey(secret = authSecret()): string {
  return Buffer.from(
    hkdfSync("sha256", secret, new Uint8Array(0), KEY_INFO, 32),
  ).toString("hex");
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An HS256 JWT saying the request comes from `customerId`. */
export function signAssistantToken(
  customerId: string,
  { key = assistantTokenKey(), now = Date.now() } = {},
): string {
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: customerId,
    iat: issuedAt,
    exp: issuedAt + LIFETIME_SECONDS,
  })}`;
  const signature = createHmac("sha256", Buffer.from(key, "utf8"))
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}
