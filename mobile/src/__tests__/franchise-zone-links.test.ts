/** 1.12.0 (franchise brief 21-Nov-2026): zone pages and the public commission chart open in the app. */
import { describe, expect, it } from "vitest";

import { deepLinkKind, notificationTarget, sitePageUrl } from "../deep-links";

const SITE = "https://gokesari.com";

describe("1.12.0 — franchise zones and the commission chart", () => {
  it("a shared zone page or the commission chart opens in the app", () => {
    expect(deepLinkKind(`${SITE}/franchise/zones/GKZ-PUN-02`, SITE)).toBe("franchise");
    expect(deepLinkKind(`${SITE}/franchise/book`, SITE)).toBe("franchise");
    expect(deepLinkKind(`${SITE}/dealer/commission-chart`, SITE)).toBe("commission-chart");
    expect(sitePageUrl(`${SITE}/dealer/commission-chart`, SITE)).toBe(`${SITE}/dealer/commission-chart`);
  });

  it("zone status and renewal pushes open the owner's page inside the app", () => {
    expect(notificationTarget({ url: "/franchise/my" }, SITE)).toEqual({ action: "open", url: `${SITE}/franchise/my` });
  });
});
