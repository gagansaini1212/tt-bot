import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { MemoryNonceStore, NonceQueue } from "./nonce-queue";

/** A venue that refuses a nonce not above the last, and two requests at once. */
function nonceVenue() {
  let last = BigInt(0);
  let inFlight = 0;
  const accepted: bigint[] = [];
  return {
    accepted,
    async send(nonce: bigint) {
      inFlight++;
      try {
        if (inFlight > 1) throw new Error("two requests at once");
        if (nonce <= last) throw new Error("EAPI:Invalid nonce");
        // Requests take a varying while, so any overlap would show.
        await sleep(Number(nonce % BigInt(3)));
        last = nonce;
        accepted.push(nonce);
        return nonce;
      } finally {
        inFlight--;
      }
    },
  };
}

test("hammered concurrently, one queue sends one request at a time with strictly increasing nonces", async () => {
  const venue = nonceVenue();
  // A clock that stands still, so the nonces come from the queue alone.
  const queue = new NonceQueue({ now: () => 1_800_000_000_000 });
  const results = await Promise.allSettled(
    Array.from({ length: 200 }, () => queue.run((nonce) => venue.send(nonce))),
  );
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(venue.accepted.length, 200);
  for (let i = 1; i < venue.accepted.length; i++)
    assert.ok(venue.accepted[i] > venue.accepted[i - 1]);
  // Microseconds since the epoch, at least.
  assert.equal(venue.accepted[0], BigInt(1_800_000_000_000_000));
});

test("a failed request uses its nonce, and the queue carries on", async () => {
  const venue = nonceVenue();
  const queue = new NonceQueue({ now: () => 1_000 });
  const used: bigint[] = [];
  const results = await Promise.allSettled([
    queue.run((nonce) => venue.send(nonce)),
    queue.run(async (nonce) => {
      used.push(nonce);
      throw new Error("timed out");
    }),
    queue.run((nonce) => venue.send(nonce)),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.deepEqual(venue.accepted, [BigInt(1_000_000), BigInt(1_000_002)]);
  assert.deepEqual(used, [BigInt(1_000_001)]);
});

test("nonces keep rising when the clock goes back, and follow the clock when it moves on", async () => {
  let now = 5_000;
  const store = new MemoryNonceStore();
  const queue = new NonceQueue({ store, now: () => now });
  assert.equal(await queue.run(async (nonce) => nonce), BigInt(5_000_000));
  now = 4_000;
  assert.equal(await queue.run(async (nonce) => nonce), BigInt(5_000_001));
  now = 6_000;
  assert.equal(await queue.run(async (nonce) => nonce), BigInt(6_000_000));
  // Another queue on the same store, as after a restart, never goes back.
  now = 1_000;
  const restarted = new NonceQueue({ store, now: () => now });
  assert.equal(await restarted.run(async (nonce) => nonce), BigInt(6_000_001));
});
