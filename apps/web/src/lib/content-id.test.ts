import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import { contentId } from "./content-id";

test("a snapshot's ID is a UUID that names exactly its content", () => {
  const snapshot = { capturedAt: "2026-10-08T14:00:00.000Z", balances: [] };
  const id = contentId(snapshot);
  assert.ok(z.uuid().safeParse(id).success, id);
  assert.equal(contentId(structuredClone(snapshot)), id);
  assert.notEqual(
    contentId({ ...snapshot, capturedAt: "2026-10-08T14:00:10.000Z" }),
    id,
  );
});
