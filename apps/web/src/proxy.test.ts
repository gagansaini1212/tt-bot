import assert from "node:assert/strict";
import { test } from "node:test";
import { isAssistantPath } from "./proxy";

test("every path Next.js rewrites to the assistant counts as one", () => {
  for (const path of [
    "/eve/v1/session",
    "/EVE/v1/session",
    "/Eve/V1/session/wrun_1/stream",
    "/%65ve/v1/session",
    "/%45VE/v1/session",
    "//eve/v1/session",
    "/eve//v1/session",
  ])
    assert.ok(isAssistantPath(path), path);
});

test("pages are not the assistant", () => {
  for (const path of ["/", "/markets", "/events", "/evening", "/%E0%A4%A"])
    assert.ok(!isAssistantPath(path), path);
});
