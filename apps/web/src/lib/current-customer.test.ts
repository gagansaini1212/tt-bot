import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";
import { DEV_CUSTOMER_ID } from "@crypto-trading/database/dev-seed";
import type * as CurrentCustomerModule from "./current-customer";
import type * as FreshSessionModule from "./fresh-session";

let current: typeof CurrentCustomerModule;
let fresh: typeof FreshSessionModule;
let session: object | null = null;

class Redirect extends Error {
  constructor(readonly path: string) {
    super(`redirect to ${path}`);
  }
}

// Stand-ins for the request, Next.js's redirect and Better Auth.
before(async () => {
  mock.module("next/headers", {
    exports: { headers: async () => new Headers() },
  });
  mock.module("next/navigation", {
    exports: {
      redirect: (path: string) => {
        throw new Redirect(path);
      },
    },
  });
  (globalThis as { cryptoTradingAuth?: unknown }).cryptoTradingAuth = {
    api: { getSession: async () => session },
  };
  current = await import("./current-customer");
  fresh = await import("./fresh-session");
});
beforeEach(() => {
  session = null;
});

function signedIn(minutesAgo: number) {
  session = {
    user: {
      customerId: DEV_CUSTOMER_ID,
      name: "Development customer",
      email: "dev@example.com",
    },
    session: { createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  };
}

/** Where `work` redirected the customer. */
async function redirectedTo(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof Redirect, String(error));
    return error.path;
  }
  assert.fail("expected a redirect");
}

test("the current customer is the signed-in login's customer", async () => {
  assert.equal(await current.getCurrentCustomer(), null);
  signedIn(1);
  assert.deepEqual(await current.getCurrentCustomer(), {
    id: DEV_CUSTOMER_ID,
    name: "Development customer",
    email: "dev@example.com",
  });
});

test("a session is fresh for ten minutes after signing in", () => {
  const signedInAt = new Date("2026-10-08T12:00:00Z");
  const at = (seconds: number) => signedInAt.getTime() + seconds * 1000;
  assert.ok(fresh.isFreshSession(signedInAt, at(599)));
  assert.ok(!fresh.isFreshSession(signedInAt, at(600)));
});

test("a sensitive action proceeds only with a recent sign-in", async () => {
  signedIn(9);
  assert.equal(
    (await fresh.requireFreshSession("/settings")).id,
    DEV_CUSTOMER_ID,
  );
  assert.equal((await fresh.checkFreshSession()).status, "fresh");

  signedIn(11);
  assert.equal((await fresh.checkFreshSession()).status, "stale");
  assert.equal(
    await redirectedTo(fresh.requireFreshSession("/settings")),
    "/sign-in?next=%2Fsettings&reauthenticate=1",
  );

  session = null;
  assert.equal((await fresh.checkFreshSession()).status, "signed_out");
  assert.equal(
    await redirectedTo(fresh.requireFreshSession("/settings")),
    "/sign-in?next=%2Fsettings",
  );
});
