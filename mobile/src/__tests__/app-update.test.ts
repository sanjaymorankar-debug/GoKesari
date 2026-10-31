/**
 * docs/app-install-2026-10: the app's update check (plain TypeScript — no device needed).
 */
import { describe, expect, it } from "vitest";

import { compareVersions, decideUpdate, parseAppStoreLookup, storeOpenUrl } from "../app-update-policy";

const PLAY = "https://play.google.com/store/apps/details?id=com.gokesari.app";

describe("decideUpdate", () => {
  it("offers nothing until the site names a version and a link", () => {
    expect(decideUpdate("1.4.0", null)).toEqual({ kind: "none" });
    expect(decideUpdate("1.4.0", { latest: "1.5.0", minimum: null, url: null })).toEqual({ kind: "none" });
    expect(decideUpdate("1.4.0", { latest: null, minimum: null, url: PLAY })).toEqual({ kind: "none" });
  });

  it("offers a newer build, and nothing when this one is current or newer", () => {
    expect(decideUpdate("1.4.0", { latest: "1.5.0", minimum: null, url: PLAY })).toEqual({ kind: "optional", version: "1.5.0", url: PLAY });
    expect(decideUpdate("1.5.0", { latest: "1.5.0", minimum: null, url: PLAY })).toEqual({ kind: "none" });
    expect(decideUpdate("1.6.0", { latest: "1.5.0", minimum: null, url: PLAY })).toEqual({ kind: "none" });
  });

  it("requires the update below the minimum", () => {
    expect(decideUpdate("1.1.0", { latest: "1.5.0", minimum: "1.2.0", url: PLAY })).toEqual({ kind: "required", version: "1.5.0", url: PLAY });
  });

  it("on iPhone the App Store listing wins", () => {
    const listing = parseAppStoreLookup({ results: [{ version: "1.6.0", trackViewUrl: "https://apps.apple.com/in/app/gokesari/id1" }] });
    expect(listing).toEqual({ version: "1.6.0", url: "https://apps.apple.com/in/app/gokesari/id1" });
    expect(decideUpdate("1.5.0", { latest: "1.5.0", minimum: null, url: "https://apps.apple.com/in/app/gokesari/id1" }, listing)).toMatchObject({
      kind: "optional",
      version: "1.6.0",
    });
    expect(parseAppStoreLookup({ results: [] })).toBeNull();
    expect(parseAppStoreLookup({ results: [{ version: "1.0", trackViewUrl: "https://x" }] })).toBeNull();
  });
});

describe("helpers", () => {
  it("compareVersions", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("Play links open the Play Store app; other links stay as they are", () => {
    expect(storeOpenUrl(PLAY)).toBe("market://details?id=com.gokesari.app");
    expect(storeOpenUrl("https://apps.apple.com/in/app/gokesari/id1")).toBe("https://apps.apple.com/in/app/gokesari/id1");
    expect(storeOpenUrl("https://example.com/GoKesari.apk")).toBe("https://example.com/GoKesari.apk");
  });
});
