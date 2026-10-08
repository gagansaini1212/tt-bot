import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNextPath, signInPath } from "./sign-in-path";

test("after signing in, the customer returns to the page they asked for", () => {
  assert.equal(
    safeNextPath("/markets?pair=ETH-USDT"),
    "/markets?pair=ETH-USDT",
  );
  assert.equal(safeNextPath("/accounts"), "/accounts");
  assert.equal(safeNextPath("/accounts#holdings"), "/accounts");
});

test("never to another site, or back to sign-in", () => {
  for (const value of [
    undefined,
    ["/accounts"],
    "",
    "accounts",
    "https://example.com/",
    "//example.com/accounts",
    "/\\example.com",
    "/.//example.com",
    "/%2e//example.com",
    "/a/..//example.com",
    "/\\/example.com",
    "/sign-in",
    "/sign-in?next=/accounts",
  ])
    assert.equal(safeNextPath(value), "/", String(value));
});

test("the sign-in link carries where to return and whether to confirm", () => {
  assert.equal(signInPath(), "/sign-in");
  assert.equal(signInPath("/"), "/sign-in");
  assert.equal(
    signInPath("/markets?pair=ETH-USDT"),
    "/sign-in?next=%2Fmarkets%3Fpair%3DETH-USDT",
  );
  assert.equal(signInPath("//example.com"), "/sign-in");
  assert.equal(
    signInPath("/settings", { reauthenticate: true }),
    "/sign-in?next=%2Fsettings&reauthenticate=1",
  );
});
