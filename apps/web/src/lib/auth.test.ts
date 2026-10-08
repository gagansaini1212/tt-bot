import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { NextRequest } from "next/server";
import {
  DEV_CUSTOMER_ID,
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_PASSWORD,
} from "@crypto-trading/database/dev-seed";
import {
  createTestDatabase,
  databaseTestsSkipped,
  seedDevelopment,
  type MigratedTestDatabase,
} from "@crypto-trading/database/testing";
import { customerSession } from "../../../../agent/lib/customer-principal";
import { proxy } from "../proxy";
import { getAuth } from "./auth";

const origin = "http://localhost:3000";

/** A request as Next.js hands it to the proxy, Host header included. */
function pageRequest(
  path: string,
  {
    headers = {},
    method = "GET",
  }: { headers?: Record<string, string>; method?: string } = {},
) {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: { host: "localhost:3000", ...headers },
  });
}

function signIn(email: string, password: string, host = "localhost:3000") {
  return getAuth().handler(
    new Request(`http://${host}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://${host}`,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/** The session cookie a successful sign-in set, as a Cookie header. */
function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describe("customer sign-in", { skip: databaseTestsSkipped }, () => {
  let database: MigratedTestDatabase;
  let role: string;
  let cookie: string;

  before(async () => {
    database = await createTestDatabase();
    await seedDevelopment(database.admin);
    // Sign-in only, as the web app's login would be in a deployment.
    role = `ct_test_${randomBytes(6).toString("hex")}`;
    await database.admin.unsafe(
      `create role ${role} login password 'web' in role trading_auth`,
    );
    const url = new URL(database.adminUrl);
    url.username = role;
    url.password = "web";
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_SECRET = "auth-test-secret-at-least-32-characters";

    const response = await signIn(DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD);
    assert.equal(response.status, 200);
    cookie = sessionCookie(response);
  });
  after(async () => {
    await getAuth().options.database.end();
    await database?.admin.unsafe(`drop role if exists ${role}`);
    await database?.drop();
  });

  test("the dev login signs in as the dev customer", async () => {
    const session = await getAuth().api.getSession({
      headers: new Headers({ cookie, host: "localhost:3000" }),
    });
    assert.ok(session);
    assert.equal(session.user.customerId, DEV_CUSTOMER_ID);
    assert.equal(session.user.email, DEV_LOGIN_EMAIL);
  });

  test("a wrong password, an unknown email or a sign-up gets no session", async () => {
    for (const response of [
      await signIn(DEV_LOGIN_EMAIL, "not-the-password"),
      await signIn("nobody@example.com", DEV_LOGIN_PASSWORD),
    ]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
    const signUp = await getAuth().handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          name: "Intruder",
          email: "intruder@example.com",
          password: "intruder-password",
        }),
      }),
    );
    assert.equal(signUp.status, 400);
    assert.deepEqual(signUp.headers.getSetCookie(), []);
  });

  test("sign-in is served only to requests addressed to this machine", async () => {
    await assert.rejects(
      signIn(DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD, "trading.example.com"),
      /not in the allowed hosts/,
    );
  });

  test("signed-out visitors are sent to sign in, and back afterwards", async () => {
    const signedOut = await proxy(pageRequest("/markets?pair=ETH-USDT"));
    assert.equal(signedOut.status, 307);
    assert.equal(
      signedOut.headers.get("location"),
      `${origin}/sign-in?next=%2Fmarkets%3Fpair%3DETH-USDT`,
    );

    const signedIn = await proxy(
      pageRequest("/markets", { headers: { cookie } }),
    );
    assert.equal(signedIn.headers.get("x-middleware-next"), "1");

    // Only a server action may POST signed out; it checks the session itself.
    const post = await proxy(pageRequest("/markets", { method: "POST" }));
    assert.equal(post.status, 401);
    const action = await proxy(
      pageRequest("/markets", {
        method: "POST",
        headers: { "next-action": "0123abcd" },
      }),
    );
    assert.equal(action.headers.get("x-middleware-next"), "1");

    const signInPage = await proxy(pageRequest("/sign-in"));
    assert.equal(signInPage.headers.get("x-middleware-next"), "1");

    // A forged cookie is no session.
    const forged = await proxy(
      pageRequest("/", {
        headers: { cookie: "better-auth.session_token=forged.value" },
      }),
    );
    assert.equal(forged.status, 307);
  });

  test("the assistant hears only from signed-in customers, by token", async () => {
    for (const path of ["/eve/v1/session", "/EVE/v1/session"]) {
      const signedOut = await proxy(pageRequest(path, { method: "POST" }));
      assert.equal(signedOut.status, 401, path);
      assert.equal(signedOut.headers.get("x-middleware-next"), null, path);
    }

    const forwarded = await proxy(
      pageRequest("/eve/v1/session", {
        method: "POST",
        headers: { cookie, authorization: "Bearer chosen-by-the-browser" },
      }),
    );
    assert.equal(forwarded.headers.get("x-middleware-next"), "1");
    const overridden =
      forwarded.headers.get("x-middleware-override-headers")?.split(",") ?? [];
    // The session cookie stays with the web app.
    assert.ok(!overridden.includes("cookie"));
    const authorization = forwarded.headers.get(
      "x-middleware-request-authorization",
    );
    assert.ok(authorization && overridden.includes("authorization"));
    const caller = await customerSession()(
      new Request(`${origin}/eve/v1/session`, {
        method: "POST",
        headers: { authorization },
      }),
    );
    assert.equal(caller?.principalId, DEV_CUSTOMER_ID);
  });

  test("a freshly signed-in customer can change their password", async () => {
    const headers = new Headers({ cookie, host: "localhost:3000", origin });
    const change = (currentPassword: string, newPassword: string) =>
      getAuth().api.changePassword({
        body: { currentPassword, newPassword },
        headers,
      });
    await change(DEV_LOGIN_PASSWORD, "a-changed-password");
    assert.equal(
      (await signIn(DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD)).status,
      401,
    );
    assert.equal(
      (await signIn(DEV_LOGIN_EMAIL, "a-changed-password")).status,
      200,
    );
    await change("a-changed-password", DEV_LOGIN_PASSWORD);
  });

  test("signing out ends the session", async () => {
    const response = await getAuth().handler(
      new Request(`${origin}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin },
      }),
    );
    assert.equal(response.status, 200);
    const session = await getAuth().api.getSession({
      headers: new Headers({ cookie, host: "localhost:3000" }),
    });
    assert.equal(session, null);
    const redirected = await proxy(pageRequest("/", { headers: { cookie } }));
    assert.equal(redirected.status, 307);
  });
});
