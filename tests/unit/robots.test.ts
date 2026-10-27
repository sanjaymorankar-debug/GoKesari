/**
 * TC-SEC-008 (QA run 24 Oct 2026, defect D-05): test.gokesari.com had no
 * robots.txt, so search engines could index the test site. Every host but
 * gokesari.com now disallows crawling; production still allows it.
 */
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ production: false }));
vi.mock("@/lib/env", () => ({ isProductionSite: () => env.production }));

import robots from "@/app/robots";

describe("robots.txt", () => {
  it("keeps search engines out of the test site and other non-production hosts", () => {
    env.production = false;
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it("lets search engines crawl gokesari.com, except the API, the cart and search results", () => {
    env.production = true;
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/cart", "/search"] } });
  });
});
