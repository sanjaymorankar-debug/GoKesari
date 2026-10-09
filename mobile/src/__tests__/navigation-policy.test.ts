import { describe, expect, it } from "vitest";

import { decideNavigation, decideNewWindow, parseAndroidIntentUrl } from "../navigation-policy";

const SITE = "https://gokesari.com";

describe("decideNavigation", () => {
  it("loads the website's own pages", () => {
    expect(decideNavigation("https://gokesari.com/wallet", SITE, true)).toEqual({ action: "load" });
    expect(decideNavigation("about:blank", SITE, true)).toEqual({ action: "load" });
  });

  it("keeps payment pages and anything inside an iframe in the app", () => {
    expect(decideNavigation("https://payments.cashfree.com/order", SITE, true)).toEqual({ action: "load" });
    expect(decideNavigation("https://acs.somebank.example/3ds", SITE, true)).toEqual({ action: "load" });
    expect(decideNavigation("https://wa.me/919800000000", SITE, false)).toEqual({ action: "load" });
  });

  it("hands Google sign-in to the system browser", () => {
    expect(decideNavigation("https://accounts.google.com/o/oauth2/v2/auth?client_id=x", SITE, true)).toEqual({
      action: "google-sign-in",
    });
  });

  it("opens maps, WhatsApp and the stores in their own apps", () => {
    for (const url of [
      "https://www.google.com/maps/dir/?api=1&destination=18.5,73.8",
      "https://maps.google.com/?q=18.5,73.8",
      "https://maps.app.goo.gl/abc",
      "https://wa.me/?text=hi",
      "https://play.google.com/store/apps/details?id=x",
    ]) {
      expect(decideNavigation(url, SITE, true)).toEqual({ action: "open-outside", url });
    }
    expect(decideNavigation("https://www.google.com/search?q=x", SITE, true)).toEqual({ action: "load" });
  });

  it("sends phone, email and UPI links to other apps", () => {
    for (const url of ["tel:+919800000000", "mailto:help@gokesari.com", "upi://pay?pa=x@upi", "phonepe://pay?x=1", "whatsapp://send?text=hi"]) {
      expect(decideNavigation(url, SITE, true)).toEqual({ action: "open-outside", url });
    }
  });

  it("never follows local files or the app's own sign-in callback", () => {
    expect(decideNavigation("file:///data/data/x", SITE, true)).toEqual({ action: "block" });
    expect(decideNavigation("gokesari://auth-callback?code=x", SITE, true)).toEqual({ action: "block" });
    expect(decideNavigation("garbage", SITE, true)).toEqual({ action: "block" });
  });

  it("turns Android intent links into links other apps can open", () => {
    expect(
      decideNavigation(
        "intent://pay?pa=shop@upi&am=10#Intent;scheme=upi;package=com.phonepe.app;S.browser_fallback_url=https%3A%2F%2Fgokesari.com%2Fwallet;end",
        SITE,
        true,
      ),
    ).toEqual({
      action: "open-outside",
      url: "upi://pay?pa=shop@upi&am=10",
      fallbackUrl: "https://gokesari.com/wallet",
      storePackage: "com.phonepe.app",
    });
    expect(decideNavigation("intent://#Intent;package=com.phonepe.app;end", SITE, true)).toEqual({
      action: "open-outside",
      url: "market://details?id=com.phonepe.app",
    });
    expect(decideNavigation("intent://x#Intent;end", SITE, true)).toEqual({ action: "block" });
  });
});

describe("parseAndroidIntentUrl", () => {
  it("ignores fallbacks that are not web pages and odd package names", () => {
    expect(parseAndroidIntentUrl("intent://x#Intent;scheme=upi;package=a b;S.browser_fallback_url=javascript%3Aalert(1);end")).toEqual({
      url: "upi://x",
    });
    expect(parseAndroidIntentUrl("https://gokesari.com")).toBeNull();
  });
});

describe("decideNewWindow", () => {
  it("keeps only the website's own pages in the app", () => {
    expect(decideNewWindow("https://gokesari.com/legal/terms", SITE)).toEqual({ action: "load" });
    expect(decideNewWindow("https://example.com/price", SITE)).toEqual({ action: "open-outside", url: "https://example.com/price" });
    expect(decideNewWindow("https://wa.me/?text=hi", SITE)).toEqual({ action: "open-outside", url: "https://wa.me/?text=hi" });
    expect(decideNewWindow("javascript:alert(1)", SITE)).toEqual({ action: "block" });
  });
});
