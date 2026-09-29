import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default withEve(nextConfig, {
  eveRoot: "../..",
});
