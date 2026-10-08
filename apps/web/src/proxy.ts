import { NextResponse, type NextRequest } from "next/server";

import { signAssistantToken } from "@/lib/assistant-token";
import { getAuth } from "@/lib/auth";
import { signInPath } from "@/lib/sign-in-path";

const UNAVAILABLE = "Sign-in is unavailable. Check the web server's output.";

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
    return NextResponse.json(
      {
        ok: false,
        code: "unauthorized",
        error: "Sign in to use the assistant.",
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
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
  try {
    if (pathname.startsWith("/eve/")) return await forwardToAssistant(request);
    if (pathname === "/sign-in") return NextResponse.next();
    if (await signedInCustomerId(request)) return NextResponse.next();
  } catch (error) {
    console.error("Could not check the session.", error);
    return pathname.startsWith("/eve/")
      ? NextResponse.json(
          { ok: false, code: "unavailable", error: UNAVAILABLE },
          { status: 503, headers: { "cache-control": "no-store" } },
        )
      : new NextResponse(UNAVAILABLE, { status: 503 });
  }
  // A server action answers for itself: each one checks the session.
  if (request.method !== "GET" && request.method !== "HEAD")
    return NextResponse.next();
  return NextResponse.redirect(
    new URL(signInPath(`${pathname}${search}`), request.url),
  );
}

export const config = {
  // Everything but Better Auth's endpoints, Next.js's own files and the icon.
  matcher: ["/((?!api/auth/|_next/|__nextjs|favicon\\.ico$).*)"],
};
