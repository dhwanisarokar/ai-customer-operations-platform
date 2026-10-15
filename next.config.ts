import type { NextConfig } from "next";
import { FRAME_DENY_HEADER, baselineHeaders } from "./src/lib/csp";

const nextConfig: NextConfig = {
  // Static security headers. The Content-Security-Policy is per request (it carries a nonce) and is set in src/proxy.ts;
  // the rules and their limits are documented in src/lib/csp.ts and docs/deployment.md.
  async headers() {
    return [
      // Safe everywhere, including the public chat widget that other websites embed in an iframe.
      {
        source: "/:path*",
        headers: baselineHeaders({ production: process.env.NODE_ENV === "production" }),
      },
      // Everything except the widget page refuses to be framed. The widget page (/widget/...) is the one document that
      // other websites embed on purpose, so it must NOT carry this header.
      { source: "/((?!widget/).*)", headers: [FRAME_DENY_HEADER] },
    ];
  },
};

export default nextConfig;
