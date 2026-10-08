import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";
import { withEve } from "eve/next";

// Customer sign-in needs DATABASE_URL and AUTH_SECRET, which live in the
// repository's .env (see .env.example). Take only those: that file also holds
// the schema owner's DATABASE_ADMIN_URL, which the apps never use. Values from
// this app's own env files, which Next.js has already loaded, win. The eve
// assistant inherits the result.
const repositoryEnv = resolve(process.cwd(), "../../.env");
if (existsSync(repositoryEnv)) {
  const values = parseEnv(readFileSync(repositoryEnv, "utf8"));
  for (const name of ["DATABASE_URL", "AUTH_SECRET"])
    if (process.env[name] === undefined && values[name] !== undefined)
      process.env[name] = values[name];
}

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      // The Activity page used to live at /decisions. Temporary, so the path
      // stays free for a future AI decision history page.
      { source: "/decisions", destination: "/activity", permanent: false },
    ];
  },
};

export default withEve(nextConfig, {
  eveRoot: "../..",
});
