import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createStoredFlag } from "./stored-flag";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage;
}
const unavailable = () => {
  throw new DOMException("Storage is disabled", "SecurityError");
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("reads and writes the stored choice", () => {
  const storage = memoryStorage();
  const flag = createStoredFlag("hide-dust", true, () => storage);
  assert.equal(flag.get(), true);
  flag.set(false);
  assert.equal(storage.getItem("hide-dust"), "false");
  assert.equal(createStoredFlag("hide-dust", true, () => storage).get(), false);
});

test("ignores values it did not write", () => {
  const storage = memoryStorage();
  storage.setItem("hide-dust", "yes");
  assert.equal(createStoredFlag("hide-dust", true, () => storage).get(), true);
});

test("works for the page's life when storage is unavailable", () => {
  const flag = createStoredFlag("hide-dust", true, unavailable);
  assert.equal(flag.get(), true);
  flag.set(false);
  assert.equal(flag.get(), false);
});

test("notifies subscribers and follows changes from other tabs", () => {
  const window = new EventTarget();
  Object.assign(globalThis, { window });
  const storage = memoryStorage();
  const flag = createStoredFlag("hide-dust", true, () => storage);
  let calls = 0;
  const unsubscribe = flag.subscribe(() => calls++);

  flag.set(false);
  assert.equal(calls, 1);
  storage.setItem("hide-dust", "true");
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "other" }));
  assert.equal(calls, 1);
  window.dispatchEvent(
    Object.assign(new Event("storage"), { key: "hide-dust" }),
  );
  assert.equal(calls, 2);
  assert.equal(flag.get(), true);

  unsubscribe();
  flag.set(false);
  assert.equal(calls, 2);
});
