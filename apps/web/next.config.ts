import type { NextConfig } from "next";
import { withEve } from "eve/next";

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
