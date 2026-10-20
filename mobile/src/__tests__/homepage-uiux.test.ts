/**
 * App 1.3.0 (docs/homepage-uiux-2026-10 at the repository root): the new
 * home's "Compare N prices" links open in the app; nothing else in the route
 * map changes.
 */
import { describe, expect, it } from "vitest";

import { DEEP_LINK_ROUTES, deepLinkKind, sitePageUrl } from "../deep-links";

const SITE = "https://gokesari.com";

describe("1.3.0 — compare links", () => {
  it("routes a product's price comparison into the app", () => {
    const link = `${SITE}/search/compare?product=9b6a16c0-a990-4d70-8c9b-32974a1862f1`;
    expect(sitePageUrl(link, SITE)).toBe(link);
    expect(deepLinkKind(link, SITE)).toBe("compare");
    expect(deepLinkKind(`${SITE}/search?q=milk`, SITE)).toBe("page");
  });

  it("keeps every earlier route", () => {
    expect(DEEP_LINK_ROUTES.map((r) => r.kind)).toEqual(["product", "shop", "order", "referral", "referral", "notification", "ticket", "compare"]);
  });

  it("still never opens the search API in the app", () => {
    expect(sitePageUrl(`${SITE}/api/search/suggest?q=milk`, SITE)).toBeNull();
  });
});
