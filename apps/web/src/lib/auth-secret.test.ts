import assert from "node:assert/strict";
import { test } from "node:test";
import { authSecret } from "./auth-secret";

const random = "kQ3v7m2X9pZ1rT8wY4nB6cD0fH5jL2sA";

test("sign-in needs AUTH_SECRET", () => {
  assert.throws(() => authSecret({ NODE_ENV: "development" }), /AUTH_SECRET/);
  assert.equal(
    authSecret({ NODE_ENV: "development", AUTH_SECRET: random }),
    random,
  );
});

test("production refuses the example secret and short ones", () => {
  const example = "replace-with-at-least-32-random-characters";
  // Fine on a developer's machine, where .env.example was copied.
  assert.equal(
    authSecret({ NODE_ENV: "development", AUTH_SECRET: example }),
    example,
  );
  for (const secret of [example, "too-short"])
    assert.throws(
      () => authSecret({ NODE_ENV: "production", AUTH_SECRET: secret }),
      /at least 32 random characters/,
    );
  assert.equal(
    authSecret({ NODE_ENV: "production", AUTH_SECRET: random }),
    random,
  );
});
