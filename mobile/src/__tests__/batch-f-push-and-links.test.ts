/**
 * batch-2026-10 WS-F: the bridge's push message, notification taps and
 * incoming deep links (plain TypeScript — no device needed).
 */
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { buildBridgeScript } from "../bridge-script";
import { DEEP_LINK_ROUTES, deepLinkKind, notificationTarget, sitePageUrl } from "../deep-links";
import { decideNewWindow, isPaymentHost } from "../navigation-policy";
import { buildPushRegistration, isExpoPushToken, PUSH_PERMISSION_DENIED, PUSH_TOKEN_MESSAGE } from "../push-registration";

const SITE = "https://gokesari.com";
const TOKEN = "per-launch-secret";

type Message = Record<string, unknown> & { type: string; id?: number; token?: string };

function loadPage() {
  const posted: Message[] = [];
  const window: Record<string, unknown> = {
    location: { origin: SITE, href: `${SITE}/` },
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
  };
  const document = { styleSheets: [], addEventListener: () => {} };
  const script = buildBridgeScript({ siteOrigin: SITE, token: TOKEN, platform: "android", version: "1.2.0" });
  runInNewContext(script, { window, document, navigator: {}, DOMException, URL, Promise, setTimeout });
  const app = window.__gokesariApp as { receive(message: unknown): void; getPushToken(): Promise<unknown> };
  return { app, posted, last: () => posted[posted.length - 1] };
}

describe("bridge push message", () => {
  it("TC-B26-F-080 getPushToken posts push.getToken with the per-launch secret and resolves with the app's reply", async () => {
    const page = loadPage();
    const pending = page.app.getPushToken();
    expect(page.last()).toMatchObject({ type: PUSH_TOKEN_MESSAGE, token: TOKEN });
    const registration = { token: "ExponentPushToken[abc123]", platform: "android", appVariant: "production", deviceId: null, deviceName: "Pixel 8" };
    page.app.receive({ type: "reply", id: page.last().id, result: registration });
    await expect(pending).resolves.toEqual(registration);
  });

  it("TC-B26-F-081 a refused notification permission reaches the page as an error", async () => {
    const page = loadPage();
    const pending = page.app.getPushToken();
    page.app.receive({ type: "reply", id: page.last().id, error: PUSH_PERMISSION_DENIED });
    await expect(pending).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("TC-B26-F-082 the registration carries a valid Expo token, platform and build", () => {
    expect(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[a-b_c]")).toBe(true);
    expect(isExpoPushToken("fcm-raw-token")).toBe(false);
    expect(buildPushRegistration({ token: "ExpoPushToken[a]", platform: "ios", appVariant: "preview", deviceName: "iPhone 15" })).toEqual({
      token: "ExpoPushToken[a]",
      platform: "ios",
      appVariant: "preview",
      deviceId: null,
      deviceName: "iPhone 15",
    });
    expect(() => buildPushRegistration({ token: "nope", platform: "android", appVariant: "production" })).toThrow();
  });
});

describe("notification taps", () => {
  it("TC-B26-F-083 open an in-site path or a site link inside the app", () => {
    expect(notificationTarget({ url: "/orders/123" }, SITE)).toEqual({ action: "open", url: `${SITE}/orders/123` });
    expect(notificationTarget({ url: `${SITE}/shops/kesari-dairy` }, SITE)).toEqual({ action: "open", url: `${SITE}/shops/kesari-dairy` });
  });

  it("TC-B26-F-084 fall back to the notification centre, send outside https links to the browser, refuse tricks", () => {
    expect(notificationTarget({}, SITE)).toEqual({ action: "open", url: `${SITE}/notifications` });
    expect(notificationTarget(null, SITE)).toEqual({ action: "open", url: `${SITE}/notifications` });
    expect(notificationTarget({ url: "https://example.com/offer" }, SITE)).toEqual({ action: "outside", url: "https://example.com/offer" });
    expect(notificationTarget({ url: "//evil.example/x" }, SITE)).toEqual({ action: "open", url: `${SITE}/notifications` });
    expect(notificationTarget({ url: "javascript:alert(1)" }, SITE)).toEqual({ action: "open", url: `${SITE}/notifications` });
    expect(notificationTarget({ url: "/api/invoices/1.pdf" }, SITE)).toEqual({ action: "open", url: `${SITE}/notifications` });
  });
});

describe("incoming deep links", () => {
  it("TC-B26-F-085 route the map's pages (product, shop, order, referral, notification, ticket) into the WebView", () => {
    const cases: [string, string][] = [
      ["/products/7f3c", "product"],
      ["/shops/kesari-dairy", "shop"],
      ["/orders/abc", "order"],
      ["/r/KES123", "referral"],
      ["/refer", "referral"],
      ["/notifications/5", "notification"],
      ["/support/tickets/9", "ticket"],
      ["/wallet", "page"],
    ];
    for (const [path, kind] of cases) {
      expect(sitePageUrl(`${SITE}${path}`, SITE)).toBe(`${SITE}${path}`);
      expect(deepLinkKind(`${SITE}${path}`, SITE)).toBe(kind);
    }
    expect(DEEP_LINK_ROUTES.map((r) => r.kind)).toEqual(expect.arrayContaining(["product", "shop", "order", "referral", "notification", "ticket"]));
  });

  it("TC-B26-F-086 ignore other hosts, API and sign-in paths, and look-alike URLs", () => {
    expect(sitePageUrl("https://test.gokesari.com/orders/1", SITE)).toBeNull();
    expect(sitePageUrl("https://evil.example\\@gokesari.com/orders/1", SITE)).toBeNull();
    expect(sitePageUrl(`${SITE}/api/invoices/1`, SITE)).toBeNull();
    expect(sitePageUrl(`${SITE}/mobile-auth/start`, SITE)).toBeNull();
    expect(sitePageUrl(`${SITE}/.well-known/assetlinks.json`, SITE)).toBeNull();
    expect(sitePageUrl("gokesari://auth-callback?code=x", SITE)).toBeNull();
    expect(sitePageUrl(null, SITE)).toBeNull();
  });

  it("TC-B26-F-087 keep payment checkout pages (live and sandbox) in the app", () => {
    expect(isPaymentHost("sandbox.cashfree.com")).toBe(true);
    expect(isPaymentHost("api.razorpay.com")).toBe(true);
    expect(isPaymentHost("mercury-t2.phonepe.com")).toBe(true);
    expect(isPaymentHost("cashfree.com.evil.example")).toBe(false);
    expect(decideNewWindow("https://sandbox.cashfree.com/pg/view/sessions/checkout", SITE)).toEqual({ action: "load" });
    expect(decideNewWindow("https://checkout.razorpay.com/v1/checkout.js", SITE)).toEqual({ action: "load" });
    expect(decideNewWindow(`${SITE}/pay/sandbox/abc`, SITE)).toEqual({ action: "load" });
    expect(decideNewWindow("https://example.com/", SITE)).toEqual({ action: "open-outside", url: "https://example.com/" });
  });
});
