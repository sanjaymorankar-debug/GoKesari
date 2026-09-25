import type { NextConfig } from "next";

/**
 * SEC-05 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): the app previously
 * sent no security headers at all. This follows Next.js's own documented
 * "Without Nonces" pattern (node_modules/next/dist/docs/01-app/02-guides/
 * content-security-policy.md) rather than the nonce-based one: a nonce
 * requires converting every page to dynamic rendering (Next's own docs:
 * "all pages must be dynamically rendered... Static optimization and ISR
 * are disabled"), which would be a much bigger, riskier change than "add
 * headers" for an app that currently mixes static and dynamic routes. The
 * trade-off, matching Next's own documented default, is 'unsafe-inline' for
 * scripts/styles rather than a maximally strict script-src.
 *
 * Origins allowed beyond 'self', and why (see src/lib/cashfree-checkout.ts,
 * src/lib/geo/provider.ts):
 *   - sdk.cashfree.com          — the Checkout widget script
 *   - *.cashfree.com            — the Checkout iframe and its API calls span
 *                                 several subdomains (sdk/api/sandbox/
 *                                 payments/payments-test) that Cashfree may
 *                                 add to over time; a gateway gets a
 *                                 wildcard rather than an enumerated list,
 *                                 so a missed subdomain doesn't show up as a
 *                                 dead checkout found by a customer
 *   - maps.googleapis.com       — the Maps JS + Places script, and its own
 *                                 XHR/fetch calls once loaded
 *   - maps.gstatic.com          — map tiles and UI icons Maps JS loads
 *
 * NOT verified in this environment: an actual browser-rendered Cashfree
 * checkout (sandbox or live) against this CSP — the test suite only proves
 * the server-side confirmation logic, never renders the widget. Smoke-test
 * a real top-up on staging before this reaches production, per the
 * deployment plan's own staging-then-smoke-test step.
 */
const isDev = process.env.NODE_ENV === "development";

const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://sdk.cashfree.com https://maps.googleapis.com${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://maps.googleapis.com https://maps.gstatic.com",
  "font-src 'self'",
  "connect-src 'self' https://maps.googleapis.com https://*.cashfree.com",
  "frame-src https://*.cashfree.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
];

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspDirectives.join("; ") },
  // Defense in depth alongside frame-ancestors 'none' above — older browsers
  // that don't act on CSP's frame-ancestors still respect this.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Only takes effect once the app is actually served over HTTPS (Hostinger)
  // — harmless on a plain HTTP dev server, which ignores it.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
