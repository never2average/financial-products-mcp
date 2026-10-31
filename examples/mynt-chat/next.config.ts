import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the Mynt repo; build it on its own.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // Run these from node_modules on the server rather than bundling them.
  serverExternalPackages: ["@modelcontextprotocol/sdk", "@anthropic-ai/vertex-sdk", "google-auth-library"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
