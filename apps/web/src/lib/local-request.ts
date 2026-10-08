import "server-only";
import { headers } from "next/headers";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Next.js rejects a Server Action whose Origin differs from its host, but lets
 * one with no Origin through. Order actions also require an Origin, and the
 * page and server must both be on this machine, so another site cannot reach
 * them, even through DNS rebinding to a loopback address.
 */
export function isLocalActionRequest(request: {
  origin: string | null;
  host: string | null;
  forwardedHost: string | null;
  fetchSite: string | null;
}) {
  const origin = request.origin ? URL.parse(request.origin) : null;
  const host = request.forwardedHost ?? request.host;
  if (!origin || !host || !request.host) return false;
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  // Older browsers omit Sec-Fetch-Site. When present it must agree.
  if (request.fetchSite !== null && request.fetchSite !== "same-origin")
    return false;
  return (
    origin.host === host &&
    LOOPBACK_HOSTS.has(origin.hostname) &&
    LOOPBACK_HOSTS.has(URL.parse(`http://${request.host}`)?.hostname ?? "")
  );
}

export async function isLocalRequest() {
  const list = await headers();
  return isLocalActionRequest({
    origin: list.get("origin"),
    host: list.get("host"),
    forwardedHost: list.get("x-forwarded-host"),
    fetchSite: list.get("sec-fetch-site"),
  });
}
