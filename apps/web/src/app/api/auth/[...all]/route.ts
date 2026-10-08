import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";

// Better Auth's sign-in, sign-out and session endpoints.
export const { GET, POST } = toNextJsHandler((request) =>
  getAuth().handler(request),
);
