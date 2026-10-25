/** D-23: only a same-site page is ever a place to return to after signing in. */
import { describe, expect, it } from "vitest";

import { safeReturnPath } from "@/lib/return-to";

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
});
