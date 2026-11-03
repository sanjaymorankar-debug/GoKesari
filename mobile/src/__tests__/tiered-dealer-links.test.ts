/** 1.7.0: the dealer portal and Add my shop are deep-link routes; commission and reward pushes open them in the WebView. */
import { describe, expect, it } from "vitest";

import { deepLinkKind, notificationTarget, sitePageUrl } from "../deep-links";

const SITE = "https://gokesari.com";

describe("1.7.0 — dealer network and shop referrals", () => {
  it("a shop's referral link and the page it lands on open in the app", () => {
    expect(deepLinkKind(`${SITE}/r/SHOPAB2CD`, SITE)).toBe("referral");
    expect(deepLinkKind(`${SITE}/shop/register?ref=SHOPAB2CD`, SITE)).toBe("shop-register");
    expect(sitePageUrl(`${SITE}/dealer?statement=2026-11`, SITE)).toBe(`${SITE}/dealer?statement=2026-11`);
  });

  it("a commission, payout or reward push opens its page inside the app", () => {
    for (const url of ["/dealer", "/dealer?statement=2026-11", "/shop/wallet"]) {
      expect(notificationTarget({ url }, SITE)).toEqual({ action: "open", url: `${SITE}${url}` });
    }
  });
});
