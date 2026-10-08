import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";
import { withEve } from "eve/next";

// DATABASE_URL and AUTH_SECRET live in the repository's .env, which every
// app reads (see .env.example). Next.js has already loaded this app's own env
// files, and their values win. The eve assistant inherits the result.
const repositoryEnv = resolve(process.cwd(), "../../.env");
if (existsSync(repositoryEnv)) process.loadEnvFile(repositoryEnv);

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
