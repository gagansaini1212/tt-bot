/**
 * Where to go after signing in: a path on this site, or the Overview. Anything
 * else could send the customer to another site once they sign in.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const url = URL.parse(value, "http://localhost");
  if (!url || url.origin !== "http://localhost") return "/";
  const path = `${url.pathname}${url.search}`;
  // A browser reads "//host" as another site, so check after the parser has
  // resolved "/.//host", "/%2e//host" and "/\host" to it.
  if (path.startsWith("//") || url.pathname === "/sign-in") return "/";
  return path;
}

/** The sign-in page, returning to `next` afterwards. */
export function signInPath(
  next = "/",
  { reauthenticate = false }: { reauthenticate?: boolean } = {},
): string {
  const query = new URLSearchParams();
  const path = safeNextPath(next);
  if (path !== "/") query.set("next", path);
  if (reauthenticate) query.set("reauthenticate", "1");
  const search = query.toString();
  return search ? `/sign-in?${search}` : "/sign-in";
}
