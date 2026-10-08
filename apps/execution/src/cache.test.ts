import assert from "node:assert/strict";
import { test } from "node:test";
import { createCache } from "./cache";

function setup() {
  let now = 1_800_000_000_000;
  let loads = 0;
  const cache = createCache<number>(1_000, () => now);
  return {
    get: (key = "key") => cache(key, async () => ++loads),
    cache,
    loads: () => loads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("serves a value until it is older than the TTL", async () => {
  const c = setup();
  assert.equal(await c.get(), 1);
  c.advance(1_000);
  assert.equal(await c.get(), 1);
  c.advance(1);
  assert.equal(await c.get(), 2);
});

test("reloads after the clock steps back", async () => {
  const c = setup();
  await c.get();
  c.advance(-1);
  assert.equal(await c.get(), 2);
});

test("concurrent requests share one load, and keys load separately", async () => {
  const c = setup();
  assert.deepEqual(await Promise.all([c.get(), c.get(), c.get()]), [1, 1, 1]);
  assert.equal(await c.get("other"), 2);
  assert.equal(c.loads(), 2);
});

test("failed loads, even synchronous throws, are not cached", async () => {
  const c = setup();
  await assert.rejects(
    c.cache("key", () => {
      throw new Error("sync");
    }),
  );
  await assert.rejects(
    c.cache("key", () => Promise.reject(new Error("async"))),
  );
  assert.equal(await c.get(), 1);
});

test("clear drops values, and a load started before it is not stored", async () => {
  const c = setup();
  assert.equal(await c.get(), 1);
  c.cache.clear();
  assert.equal(await c.get(), 2);
  c.cache.clear();
  let release!: (value: number) => void;
  const old = c.cache(
    "key",
    () => new Promise<number>((done) => (release = done)),
  );
  await new Promise(setImmediate);
  c.cache.clear();
  // A request after the clear loads afresh instead of joining the old load.
  const fresh = c.get();
  release(99);
  assert.equal(await old, 99);
  assert.equal(await fresh, 3);
  assert.equal(await c.get(), 3, "the old load's value is not stored");
});
