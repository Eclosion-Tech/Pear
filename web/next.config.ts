import type { NextConfig } from "next";

// ── Optional OIDC proxy ────────────────────────────────────────────────────────
// Some self-hosted OIDC providers (e.g. Dex) don't send CORS headers, which
// blocks browser fetches to the discovery / token endpoints.
// Solution: proxy through Next.js so all OIDC traffic is same-origin.
//
// To enable:
//   1. Set OIDC_PROXY_ORIGIN to the provider's base URL (e.g. http://localhost:5556)
//   2. Set NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY to http://localhost:3001/dex
//      (the proxy path must match the provider's own base path, e.g. /dex for Dex)
//
// Cloud providers (Auth0, Okta, Google, etc.) already support CORS — no proxy needed.
const oidcProxyOrigin = process.env.OIDC_PROXY_ORIGIN;

const nextConfig: NextConfig = {
  output: "standalone",

  ...(oidcProxyOrigin
    ? {
        async rewrites() {
          return [{ source: "/dex/:path*", destination: `${oidcProxyOrigin}/dex/:path*` }];
        },
      }
    : {}),
};

export default nextConfig;
