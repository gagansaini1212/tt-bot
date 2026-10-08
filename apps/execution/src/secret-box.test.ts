import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SecretBox, SecretBoxError } from "./secret-box";

const context = ["exchange_credentials", "customer", "account", "api_secret"];

test("a sealed secret opens only with the same key and context", () => {
  const box = new SecretBox(randomBytes(32));
  const sealed = box.seal("binance-secret", context);
  assert.equal(box.open(sealed, context), "binance-secret");
  assert.equal(sealed.includes(Buffer.from("binance-secret")), false);

  for (const other of [
    ["exchange_credentials", "customer", "other-account", "api_secret"],
    ["exchange_credentials", "customer", "account", "api_key"],
    // The parts stay apart: joining them differently is another context.
    ["exchange_credentials", "customeraccount", "", "api_secret"],
  ])
    assert.throws(() => box.open(sealed, other), SecretBoxError);
  assert.throws(
    () => new SecretBox(randomBytes(32)).open(sealed, context),
    SecretBoxError,
  );
});

test("every seal uses a fresh nonce", () => {
  const box = new SecretBox(randomBytes(32));
  const first = box.seal("same", context);
  const second = box.seal("same", context);
  assert.notDeepEqual(first.subarray(1, 13), second.subarray(1, 13));
  assert.notDeepEqual(first, second);
});

test("a changed or truncated value does not open, and the error hides it", () => {
  const box = new SecretBox(randomBytes(32));
  const sealed = box.seal("binance-secret", context);
  for (let index = 0; index < sealed.length; index++) {
    const changed = Buffer.from(sealed);
    changed[index] ^= 1;
    assert.throws(() => box.open(changed, context), SecretBoxError);
  }
  assert.throws(
    () => box.open(sealed.subarray(0, 20), context),
    (error) => {
      assert.ok(error instanceof SecretBoxError);
      assert.doesNotMatch(error.message, /binance-secret/);
      return true;
    },
  );
});

test("the master key comes from the environment, with no default", () => {
  assert.equal(SecretBox.fromEnvironment({}), undefined);
  assert.equal(
    SecretBox.fromEnvironment({ CREDENTIALS_MASTER_KEY: " " }),
    undefined,
  );
  const key = randomBytes(32).toString("base64");
  const box = SecretBox.fromEnvironment({ CREDENTIALS_MASTER_KEY: key });
  assert.ok(box);
  assert.equal(
    new SecretBox(Buffer.from(key, "base64")).open(
      box.seal("x", context),
      context,
    ),
    "x",
  );
  for (const value of [
    randomBytes(16).toString("base64"),
    randomBytes(32).toString("hex"),
    "not base64 at all, but long enough to be 32 bytes",
  ])
    assert.throws(
      () => SecretBox.fromEnvironment({ CREDENTIALS_MASTER_KEY: value }),
      /CREDENTIALS_MASTER_KEY must be 32 random bytes/,
    );
});
