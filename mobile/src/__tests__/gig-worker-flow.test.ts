/**
 * App 1.4.0 (docs/gig-worker-2026-10 at the repository root): the gig worker
 * screens are website pages, so they must open inside the app — from a link
 * and from a push notification tap — and the shop's "Call" link for a
 * delivery partner must reach the dialler.
 */
import { describe, expect, it } from "vitest";

import { notificationTarget, sitePageUrl } from "../deep-links";
import { decideNavigation } from "../navigation-policy";

const SITE = "https://gokesari.com";

describe("1.4.0 — gig worker flow", () => {
  it("opens the partner's registration, KYC and documents pages in the app", () => {
    for (const path of ["/delivery-partner/register", "/delivery-partner/kyc", "/delivery-partner/documents", "/delivery-partner"]) {
      expect(sitePageUrl(`${SITE}${path}`, SITE), path).toBe(`${SITE}${path}`);
      expect(decideNavigation(`${SITE}${path}`, SITE, true), path).toEqual({ action: "load" });
    }
  });

  it("opens the shop's Delivery partners page and the admin's Rider verification page in the app", () => {
    for (const path of ["/shop/delivery-partners", "/admin/rider-verification"]) {
      expect(decideNavigation(`${SITE}${path}`, SITE, true), path).toEqual({ action: "load" });
    }
  });

  it("a tap on a KYC, document or order-completed notification opens its page", () => {
    for (const url of ["/delivery-partner/kyc", "/delivery-partner/documents", "/orders", "/shop/orders"]) {
      expect(notificationTarget({ url }, SITE), url).toEqual({ action: "open", url: `${SITE}${url}` });
    }
  });

  it("the shop's Call link for the partner opens the dialler, never inside the page", () => {
    expect(decideNavigation("tel:+919822012345", SITE, true)).toEqual({ action: "open-outside", url: "tel:+919822012345" });
  });

  it("never opens the KYC or document APIs as pages", () => {
    expect(sitePageUrl(`${SITE}/api/delivery-partner/me/kyc`, SITE)).toBeNull();
    expect(sitePageUrl(`${SITE}/api/admin/rider-background-docs/00000000-0000-0000-0000-000000000000/file`, SITE)).toBeNull();
  });
});
