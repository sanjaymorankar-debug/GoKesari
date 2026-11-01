/**
 * docs/app-install-2026-10: when the "install the app" prompt shows, how it
 * installs on each platform, and the native app's update check.
 */
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  decideInstallPrompt,
  installPlatform,
  nativeReleaseInfo,
  parseStoreLink,
  readDeclines,
  type InstallSignals,
} from "@/lib/app-install";

const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const NATIVE_APP = `${ANDROID_CHROME} GoKesariApp/1.4.0 (android)`;

const base = (over: Partial<InstallSignals> = {}): InstallSignals => ({
  userAgent: ANDROID_CHROME,
  standalone: false,
  relatedAppInstalled: false,
  installedOnDevice: false,
  accountInstalledOn: [],
  hasInstallEvent: true,
  stores: { android: null, ios: null },
  ...over,
});

describe("decideInstallPrompt", () => {
  it("shows on a first visit with Chrome's install dialog", () => {
    expect(decideInstallPrompt(base())).toEqual({ show: true, platform: "android", method: "native-prompt" });
  });

  it("keeps showing after any number of declines: declines are not an input", () => {
    // The decision has no decline input at all — a decline only hides the sheet for that page view.
    for (let visit = 2; visit <= 5; visit++) expect(decideInstallPrompt(base()).show).toBe(true);
  });

  it("never shows inside the native app, the installed web app, or once installed", () => {
    expect(decideInstallPrompt(base({ userAgent: NATIVE_APP }))).toEqual({ show: false, reason: "native-app" });
    expect(decideInstallPrompt(base({ standalone: true }))).toEqual({ show: false, reason: "standalone" });
    expect(decideInstallPrompt(base({ relatedAppInstalled: true }))).toEqual({ show: false, reason: "related-app" });
    expect(decideInstallPrompt(base({ installedOnDevice: true }))).toEqual({ show: false, reason: "installed-on-device" });
    expect(decideInstallPrompt(base({ accountInstalledOn: ["android"] }))).toEqual({ show: false, reason: "installed-on-account" });
  });

  it("an install on another platform of the account does not hide it here", () => {
    expect(decideInstallPrompt(base({ accountInstalledOn: ["ios"] })).show).toBe(true);
  });

  it("Android without the install event shows the menu guide; with a Play listing it links there", () => {
    expect(decideInstallPrompt(base({ hasInstallEvent: false }))).toMatchObject({ method: "android-menu" });
    expect(decideInstallPrompt(base({ stores: { android: "https://play.google.com/store/apps/details?id=com.gokesari.app", ios: null } }))).toMatchObject({
      method: "store",
    });
  });

  it("iPhone and iPad get the Add to Home Screen guide, or the App Store when listed", () => {
    expect(decideInstallPrompt(base({ userAgent: IPHONE_SAFARI, hasInstallEvent: false }))).toEqual({ show: true, platform: "ios", method: "ios-guide" });
    expect(decideInstallPrompt(base({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5, hasInstallEvent: false }))).toMatchObject({ platform: "ios" });
    expect(
      decideInstallPrompt(base({ userAgent: IPHONE_SAFARI, hasInstallEvent: false, stores: { android: null, ios: "https://apps.apple.com/in/app/gokesari/id1" } })),
    ).toMatchObject({ method: "store" });
  });

  it("computers: only when the browser can install", () => {
    expect(decideInstallPrompt(base({ userAgent: DESKTOP_CHROME }))).toMatchObject({ show: true, platform: "desktop", method: "native-prompt" });
    expect(decideInstallPrompt(base({ userAgent: DESKTOP_CHROME, hasInstallEvent: false }))).toEqual({ show: false, reason: "desktop-no-install" });
    expect(decideInstallPrompt(base({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0, hasInstallEvent: false })).show).toBe(false);
  });
});

describe("helpers", () => {
  it("installPlatform", () => {
    expect(installPlatform(ANDROID_CHROME)).toBe("android");
    expect(installPlatform(IPHONE_SAFARI)).toBe("ios");
    expect(installPlatform(DESKTOP_CHROME)).toBe("desktop");
  });

  it("store links: only https Play / App Store addresses", () => {
    expect(parseStoreLink("https://play.google.com/store/apps/details?id=com.gokesari.app", "android")).toContain("play.google.com");
    expect(parseStoreLink("https://example.com/app.apk", "android")).toBeNull();
    expect(parseStoreLink("http://play.google.com/x", "android")).toBeNull();
    expect(parseStoreLink("https://play.google.com/x", "ios")).toBeNull();
    expect(parseStoreLink("not a url", "ios")).toBeNull();
    expect(parseStoreLink(undefined, "ios")).toBeNull();
  });

  it("readDeclines tolerates anything stored", () => {
    expect(readDeclines(null)).toEqual({ count: 0, lastAt: null });
    expect(readDeclines("{bad")).toEqual({ count: 0, lastAt: null });
    expect(readDeclines('{"count":-3}')).toEqual({ count: 0, lastAt: null });
    expect(readDeclines('{"count":4,"lastAt":"2026-10-31T00:00:00.000Z"}')).toEqual({ count: 4, lastAt: "2026-10-31T00:00:00.000Z" });
  });

  it("compareVersions and nativeReleaseInfo", () => {
    expect(compareVersions("1.3.0", "1.4.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("x", "1.0.0")).toBe(0);
    expect(nativeReleaseInfo("1.4.0", "1.2.0", "https://example.com/a.apk")).toEqual({ latest: "1.4.0", minimum: "1.2.0", url: "https://example.com/a.apk" });
    expect(nativeReleaseInfo("v1", "", "http://insecure")).toEqual({ latest: null, minimum: null, url: null });
  });
});
