/**
 * batch-2026-10 WS-F (F15.2.3): /.well-known association files — served always,
 * host-aware, with placeholders until the owner sets the signing details — and
 * the route map shared with the app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GET as assetLinks } from "@/app/.well-known/assetlinks.json/route";
import { GET as appleAssociation } from "@/app/.well-known/apple-app-site-association/route";
import {
  ANDROID_FINGERPRINT_PLACEHOLDER,
  APPLE_TEAM_ID_PLACEHOLDER,
  DEEP_LINK_ROUTES,
  appBuildForHost,
  requestHost,
} from "@/lib/deep-links";

const saved = {
  cert: process.env.MOBILE_ANDROID_CERT_SHA256,
  ios: process.env.MOBILE_IOS_APP_IDS,
  pkg: process.env.MOBILE_ANDROID_PACKAGE,
};

afterEach(() => {
  for (const [key, value] of [
    ["MOBILE_ANDROID_CERT_SHA256", saved.cert],
    ["MOBILE_IOS_APP_IDS", saved.ios],
    ["MOBILE_ANDROID_PACKAGE", saved.pkg],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const at = (host: string, file: string) => new Request(`https://${host}/.well-known/${file}`, { headers: { host } });

/** Apple: first matching component wins. */
function aasaOpens(components: { "/": string; exclude?: boolean }[], pathname: string): boolean {
  const match = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(pathname);
  const hit = components.find((c) => match(c["/"]));
  return Boolean(hit && !hit.exclude);
}

describe("assetlinks.json", () => {
  it("TC-B26-F-060 is served (JSON) before the fingerprint is set, with the literal placeholder", async () => {
    delete process.env.MOBILE_ANDROID_CERT_SHA256;
    delete process.env.MOBILE_ANDROID_PACKAGE;
    const res = assetLinks(at("gokesari.com", "assetlinks.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body[0].relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(body[0].target).toEqual({
      namespace: "android_app",
      package_name: "com.gokesari.app",
      sha256_cert_fingerprints: [ANDROID_FINGERPRINT_PLACEHOLDER],
    });
    expect(ANDROID_FINGERPRINT_PLACEHOLDER).toBe("REPLACE_WITH_SHA256_SIGNING_FINGERPRINT");
  });

  it("TC-B26-F-061 is host-aware (test site → preview build) and lists every configured fingerprint", async () => {
    process.env.MOBILE_ANDROID_CERT_SHA256 = "aa:bb, cc:dd";
    delete process.env.MOBILE_ANDROID_PACKAGE;
    const test = await assetLinks(at("test.gokesari.com", "assetlinks.json")).json();
    expect(test[0].target).toMatchObject({ package_name: "com.gokesari.app.preview", sha256_cert_fingerprints: ["AA:BB", "CC:DD"] });
    const prod = await assetLinks(at("gokesari.com", "assetlinks.json")).json();
    expect(prod[0].target.package_name).toBe("com.gokesari.app");
    // An explicit package wins.
    process.env.MOBILE_ANDROID_PACKAGE = "com.example.other";
    expect((await assetLinks(at("gokesari.com", "assetlinks.json")).json())[0].target.package_name).toBe("com.example.other");
  });
});

describe("apple-app-site-association", () => {
  it("TC-B26-F-062 is served as application/json at the extension-less path with the Team ID placeholder", async () => {
    delete process.env.MOBILE_IOS_APP_IDS;
    const res = appleAssociation(at("gokesari.com", "apple-app-site-association"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body.applinks.details[0].appIDs).toEqual([`${APPLE_TEAM_ID_PLACEHOLDER}.com.gokesari.app`]);
    expect(APPLE_TEAM_ID_PLACEHOLDER).toBe("REPLACE_WITH_APPLE_TEAM_ID");
    const preview = await appleAssociation(at("test.gokesari.com", "apple-app-site-association")).json();
    expect(preview.applinks.details[0].appIDs).toEqual(["REPLACE_WITH_APPLE_TEAM_ID.com.gokesari.app.preview"]);
  });

  it("TC-B26-F-063 uses MOBILE_IOS_APP_IDS when set, and opens every route-map page but never /api or sign-in", async () => {
    process.env.MOBILE_IOS_APP_IDS = "ABCDE12345.com.gokesari.app";
    const body = await appleAssociation(at("gokesari.com", "apple-app-site-association")).json();
    const details = body.applinks.details[0];
    expect(details.appIDs).toEqual(["ABCDE12345.com.gokesari.app"]);
    for (const route of DEEP_LINK_ROUTES) {
      const sample = route.example.replace(/<[^>]+>/g, "x1");
      expect(aasaOpens(details.components, sample), sample).toBe(true);
    }
    expect(aasaOpens(details.components, "/api/invoices/1")).toBe(false);
    expect(aasaOpens(details.components, "/mobile-auth/start")).toBe(false);
  });
});

describe("route map and hosts", () => {
  it("TC-B26-F-064 maps hosts to builds and reads the forwarded host behind the proxy", () => {
    expect(appBuildForHost("gokesari.com")).toBe("production");
    expect(appBuildForHost("www.gokesari.com")).toBe("production");
    expect(appBuildForHost("test.gokesari.com:443")).toBe("preview");
    expect(requestHost(new Request("http://127.0.0.1:3000/x", { headers: { host: "127.0.0.1:3000", "x-forwarded-host": "test.gokesari.com" } }))).toBe(
      "test.gokesari.com",
    );
  });

  it("TC-B26-F-065 every route-map prefix is in the app's Android intent filters and its own route map", () => {
    const root = path.resolve(__dirname, "../..");
    const appConfig = readFileSync(path.join(root, "mobile/app.config.ts"), "utf8");
    const appRoutes = readFileSync(path.join(root, "mobile/src/deep-links.ts"), "utf8");
    const intentList = /const DEEP_LINK_ROUTE_PREFIXES = \[([^\]]*)\]/.exec(appConfig)?.[1] ?? "";
    for (const route of DEEP_LINK_ROUTES) {
      expect(intentList, route.prefix).toContain(`"${route.prefix}"`);
      expect(appRoutes, route.prefix).toContain(`prefix: "${route.prefix}"`);
    }
    expect(appConfig).toContain("INTENT_PATH_PREFIXES.map((pathPrefix)");
    expect(appConfig).toContain("autoVerify: true");
    expect(appConfig).toContain("associatedDomains: [`applinks:${variant.host}`]");
  });
});
