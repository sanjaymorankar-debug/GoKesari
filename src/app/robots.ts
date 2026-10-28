/**
 * robots.txt (TC-SEC-008). The test site and every other non-production host
 * keep search engines out, so test shops and orders never appear in search
 * results; gokesari.com lets them crawl as before (no file used to mean
 * "allow everything"). Decided per request from AUTH_URL's host, like the
 * other production-only switches (isProductionSite), because test.gokesari.com
 * runs a production build too.
 */
import type { MetadataRoute } from "next";

import { isProductionSite } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  if (isProductionSite()) return { rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/cart", "/search"] } };
  return { rules: { userAgent: "*", disallow: "/" } };
}
