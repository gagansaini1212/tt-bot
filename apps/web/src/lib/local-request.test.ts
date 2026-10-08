import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalActionRequest } from "./local-request";

const local = {
  origin: "http://localhost:3000",
  host: "localhost:3000",
  forwardedHost: null,
  fetchSite: "same-origin",
};

test("order actions accept same-origin requests from this machine", () => {
  assert.equal(isLocalActionRequest(local), true);
  assert.equal(
    isLocalActionRequest({
      ...local,
      origin: "http://[::1]:3000",
      host: "[::1]:3000",
    }),
    true,
  );
  assert.equal(
    isLocalActionRequest({ ...local, forwardedHost: "localhost:3000" }),
    true,
  );
  assert.equal(isLocalActionRequest({ ...local, fetchSite: null }), true);
});

test("order actions refuse requests without an Origin or from another site", () => {
  for (const request of [
    { ...local, origin: null },
    { ...local, origin: "null" },
    { ...local, origin: "http://localhost:3001" },
    { ...local, origin: "https://evil.example" },
    { ...local, fetchSite: "cross-site" },
    { ...local, fetchSite: "same-site" },
    // DNS rebinding: a site that resolves to 127.0.0.1 is same-origin with
    // itself, but its host name is not a loopback name.
    {
      ...local,
      origin: "http://rebind.example:3000",
      host: "rebind.example:3000",
    },
    {
      ...local,
      origin: "http://rebind.example:3000",
      host: "rebind.example:3000",
      forwardedHost: "localhost:3000",
    },
    // The dashboard served on a LAN address must not trade.
    {
      ...local,
      origin: "http://192.168.1.20:3000",
      host: "192.168.1.20:3000",
    },
    { ...local, host: null },
  ])
    assert.equal(isLocalActionRequest(request), false, JSON.stringify(request));
});
