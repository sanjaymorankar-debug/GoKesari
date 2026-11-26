/** Onboarding v2 (docs/onboarding-v2-2026-11): Become a franchisee and My team open inside the app. */
import { describe, expect, it } from "vitest";

import { deepLinkKind, notificationTarget, sitePageUrl } from "../deep-links";

const SITE = "https://gokesari.com";

describe("onboarding v2 — franchise links", () => {
  it("/franchise/start (with its model / zones query) and /dealer/team open in the app", () => {
    expect(deepLinkKind(`${SITE}/franchise/start`, SITE)).toBe("franchise");
    expect(deepLinkKind(`${SITE}/franchise/start?model=paid&zones=GKZ-PUN-07`, SITE)).toBe("franchise");
    expect(sitePageUrl(`${SITE}/franchise/start?model=free`, SITE)).toBe(`${SITE}/franchise/start?model=free`);
    expect(deepLinkKind(`${SITE}/dealer/team`, SITE)).toBe("dealer");
  });

  it("the 'dealer approved' push opens the dealer page in the app", () => {
    expect(notificationTarget({ url: "/dealer" }, SITE)).toEqual({ action: "open", url: `${SITE}/dealer` });
  });
});
