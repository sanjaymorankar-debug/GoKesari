/** D-23: only a same-site page is ever a place to return to after signing in. */
import { describe, expect, it } from "vitest";

import { NextRequest } from "next/server";

import { RETURN_TO_COOKIE, safeReturnPath } from "@/lib/return-to";
import { proxy } from "@/proxy";

describe("safeReturnPath", () => {
  it("keeps a page's path and query", () => {
    expect(safeReturnPath("/wallet")).toBe("/wallet");
    expect(safeReturnPath("/orders?tab=active")).toBe("/orders?tab=active");
    expect(safeReturnPath("/shops/kesari-dairy?_rsc=abc12")).toBe("/shops/kesari-dairy");
    expect(safeReturnPath("/")).toBe("/");
  });

  it("refuses other sites and odd forms", () => {
    for (const raw of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "wallet", "", null, undefined, "/a\u0000b", `/${"x".repeat(600)}`]) {
      expect(safeReturnPath(raw), String(raw)).toBeNull();
    }
  });

  it("refuses sign-in, onboarding, API, build files and plain files", () => {
    for (const raw of ["/signin", "/signin?error=x", "/onboarding", "/api/wallet", "/_next/static/a.js", "/mobile-auth/callback", "/r/GKABC123", "/icon.png", "/robots.txt"]) {
      expect(safeReturnPath(raw), raw).toBeNull();
    }
    expect(safeReturnPath("/signing-up")).toBe("/signing-up"); // only whole segments are excluded
  });

  it("refuses help, complaint and policy pages, so signing in goes home", () => {
    for (const raw of ["/support", "/support/4f1c", "/support?orderId=1", "/grievance", "/legal/terms", "/contact", "/about"]) {
      expect(safeReturnPath(raw), raw).toBeNull();
    }
  });
});

describe("proxy: remembering the page", () => {
  const remembered = (headers: Record<string, string>, path = "/wallet") =>
    proxy(new NextRequest(`https://gokesari.test${path}`, { headers })).cookies.get(RETURN_TO_COOKIE)?.value;

  it("records a full page load", () => {
    expect(remembered({ "sec-fetch-dest": "document" })).toBe("/wallet");
  });

  it("does not record a router prefetch, which reaches the proxy without its Next headers", () => {
    expect(remembered({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" })).toBeUndefined();
  });

  it("does not record a help page even on a full load", () => {
    expect(remembered({ "sec-fetch-dest": "document" }, "/support")).toBeUndefined();
  });
});
