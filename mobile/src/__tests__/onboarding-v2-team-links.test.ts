/** Onboarding v2 (docs/onboarding-v2-2026-11, Flow 4): team invite links, team requests and My team open in the app. */
import { describe, expect, it } from "vitest";

import { DEEP_LINK_ROUTES, deepLinkKind, notificationTarget, sitePageUrl } from "../deep-links";

const SITE = "https://gokesari.com";

describe("onboarding v2 — My team links", () => {
  it("an invite link and the request page are team links; My team is part of the dealer portal", () => {
    expect(deepLinkKind(`${SITE}/team/join/AbC_12-xyzAbC_12-xyz`, SITE)).toBe("team");
    expect(deepLinkKind(`${SITE}/team/invitations`, SITE)).toBe("team");
    expect(deepLinkKind(`${SITE}/dealer/team`, SITE)).toBe("dealer");
    expect(sitePageUrl(`${SITE}/team/join/AbC_12-xyz`, SITE)).toBe(`${SITE}/team/join/AbC_12-xyz`);
    expect(DEEP_LINK_ROUTES.some((r) => r.prefix === "/team/")).toBe(true);
  });

  it("a team-request push opens the request page inside the app; another site's /team link is not ours", () => {
    for (const url of ["/team/invitations", "/dealer/team"]) {
      expect(notificationTarget({ url }, SITE)).toEqual({ action: "open", url: `${SITE}${url}` });
    }
    expect(deepLinkKind("https://example.com/team/join/x", SITE)).toBeNull();
  });
});
