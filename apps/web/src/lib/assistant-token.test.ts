import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DEV_CUSTOMER_ID } from "@crypto-trading/database/dev-seed";
import {
  CUSTOMER_AUTHENTICATOR,
  customerIdFrom,
  customerSession,
} from "../../../../agent/lib/customer-principal";
import { assistantTokenKey, signAssistantToken } from "./assistant-token";

const secret = "assistant-test-secret-at-least-32-characters";

beforeEach(() => {
  process.env.AUTH_SECRET = secret;
});
afterEach(() => {
  delete process.env.AUTH_SECRET;
});

function assistantRequest(token?: string) {
  return new Request("http://localhost:3000/eve/v1/session", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test("the assistant accepts the web app's token as the customer it names", async () => {
  const caller = await customerSession()(
    assistantRequest(signAssistantToken(DEV_CUSTOMER_ID)),
  );
  assert.ok(caller);
  assert.equal(caller.authenticator, CUSTOMER_AUTHENTICATOR);
  assert.equal(caller.principalType, "user");
  assert.equal(caller.principalId, DEV_CUSTOMER_ID);
  assert.equal(customerIdFrom(caller), DEV_CUSTOMER_ID);
});

test("the assistant ignores missing, expired, forged and altered tokens", async () => {
  const authenticate = customerSession();
  const expired = signAssistantToken(DEV_CUSTOMER_ID, {
    now: Date.now() - 2 * 60_000,
  });
  const forged = signAssistantToken(DEV_CUSTOMER_ID, {
    key: assistantTokenKey("another-secret-at-least-32-characters!"),
  });
  const [header, , signature] = signAssistantToken(DEV_CUSTOMER_ID).split(".");
  const otherCustomer = Buffer.from(
    JSON.stringify({
      iss: "crypto-trading-agent/web",
      aud: "crypto-trading-agent/assistant",
      sub: "6d1f3c52-8b7e-4a51-9a0d-2f4e8c1b7aff",
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  ).toString("base64url");
  const altered = `${header}.${otherCustomer}.${signature}`;
  for (const token of [undefined, expired, forged, altered, "not-a-jwt"])
    assert.equal(await authenticate(assistantRequest(token)), null, token);
});

test("the assistant ignores tokens when it has no AUTH_SECRET", async () => {
  const token = signAssistantToken(DEV_CUSTOMER_ID);
  delete process.env.AUTH_SECRET;
  assert.equal(await customerSession()(assistantRequest(token)), null);
});

test("the key is derived from AUTH_SECRET, not the secret itself", () => {
  assert.notEqual(assistantTokenKey(secret), secret);
  assert.equal(assistantTokenKey(secret), assistantTokenKey(secret));
  assert.notEqual(assistantTokenKey(secret), assistantTokenKey(`${secret}!`));
});

test("only a signed-in customer may draft proposals", () => {
  for (const caller of [
    null,
    {
      attributes: {},
      authenticator: "local-dev",
      principalId: "local-dev",
      principalType: "local-dev",
    },
    {
      attributes: {},
      authenticator: "vercel-oidc",
      principalId: DEV_CUSTOMER_ID,
      principalType: "user",
    },
    // A customer principal must come from the web app's token.
    {
      attributes: {},
      authenticator: CUSTOMER_AUTHENTICATOR,
      principalId: DEV_CUSTOMER_ID,
      principalType: "user",
    },
    {
      attributes: {},
      authenticator: CUSTOMER_AUTHENTICATOR,
      issuer: "crypto-trading-agent/web",
      principalId: "local-dev",
      principalType: "user",
    },
  ])
    assert.throws(() => customerIdFrom(caller), /signed-in customer/);
});
