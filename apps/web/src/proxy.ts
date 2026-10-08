import { NextResponse, type NextRequest } from "next/server";

import { signAssistantToken } from "@/lib/assistant-token";
import { getAuth } from "@/lib/auth";
import { signInPath } from "@/lib/sign-in-path";

const UNAVAILABLE = "Sign-in is unavailable. Check the web server's output.";

function refuse(status: 401 | 503, code: string, error: string) {
  return NextResponse.json(
    { ok: false, code, error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Whether Next.js would send this path to the eve assistant. Its rewrite of
 * /eve/v1/… ignores case, so this does too, and it looks through
 * percent-encoding and repeated slashes. Erring wide only refuses more.
 */
export function isAssistantPath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Malformed encoding: judge the path as it is.
  }
  return path.toLowerCase().replace(/\/+/g, "/").startsWith("/eve/");
}

// Read-only: the proxy cannot set the refreshed cookie.
async function signedInCustomerId(request: NextRequest) {
  const session = await getAuth().api.getSession({
    headers: request.headers,
    query: { disableRefresh: true },
  });
  return session?.user.customerId ?? null;
}

/**
 * The eve assistant runs as its own process behind /eve, and cannot read
 * sessions. Forward only a signed-in customer's requests, with a token that
 * names the customer, and without their cookies.
 */
async function forwardToAssistant(request: NextRequest) {
  const customerId = await signedInCustomerId(request);
  if (!customerId)
    return refuse(401, "unauthorized", "Sign in to use the assistant.");
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${signAssistantToken(customerId)}`);
  headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
}

/**
 * Sends signed-out visitors to /sign-in, checking the session in the
 * database rather than trusting a cookie. Pages, server actions and data
 * access still check for themselves.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const assistant = isAssistantPath(pathname);
  try {
    if (assistant) return await forwardToAssistant(request);
    if (pathname === "/sign-in") return NextResponse.next();
    if (await signedInCustomerId(request)) return NextResponse.next();
  } catch (error) {
    console.error("Could not check the session.", error);
    return assistant
      ? refuse(503, "unavailable", UNAVAILABLE)
      : new NextResponse(UNAVAILABLE, { status: 503 });
  }
  // A server action answers for itself: each one checks the session, and
  // tells a signed-out customer so.
  if (request.headers.has("next-action")) return NextResponse.next();
  if (request.method !== "GET" && request.method !== "HEAD")
    return new NextResponse("Sign in first.", { status: 401 });
  return NextResponse.redirect(
    new URL(signInPath(`${pathname}${search}`), request.url),
  );
}

export const config = {
  // Everything but Better Auth's endpoints, Next.js's own files and the icon.
  matcher: ["/((?!api/auth/|_next/|__nextjs|favicon\\.ico$).*)"],
};
