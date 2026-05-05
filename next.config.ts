import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Packaged Electron builds use the standalone server output so we don't ship
  // the full node_modules tree inside the .app bundle.
  output: "standalone",
};

export default nextConfig;
