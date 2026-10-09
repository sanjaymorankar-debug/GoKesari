import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MOBILE_APP_SCHEMES,
  MOBILE_APP_UA_TOKEN,
  appleAppSiteAssociation,
  androidAssetLinks,
  isMobileAppScheme,
  isMobileAppUserAgent,
  mobileAuthCallbackUrl,
} from "@/lib/mobile-app";
import {
  MOBILE_AUTH_CODE_TTL_MS,
  challengeForVerifier,
  createMobileAuthCode,
  isValidChallenge,
  redeemMobileAuthCode,
} from "@/server/mobile-auth";

const USER_ID = "3f0c5a52-6a3e-4c55-9f3b-2a1d7e9b8c11";
const OTHER_USER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

describe("mobile app detection", () => {
  it("recognises the app's WebView user agent and nothing else", () => {
    const android =
      "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/1.0.0 (android)";
    const ios =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GoKesariApp/1.0.0 (ios)";
    expect(isMobileAppUserAgent(android)).toBe(true);
    expect(isMobileAppUserAgent(ios)).toBe(true);
    expect(isMobileAppUserAgent("Mozilla/5.0 (iPhone) Safari/604.1")).toBe(false);
    expect(isMobileAppUserAgent("NotGoKesariApp/1.0")).toBe(false);
    expect(isMobileAppUserAgent(null)).toBe(false);
  });

  it("only hands codes back to the known app schemes", () => {
    expect(isMobileAppScheme("gokesari")).toBe(true);
    expect(isMobileAppScheme("gokesari-preview")).toBe(true);
    expect(isMobileAppScheme("evil")).toBe(false);
    expect(isMobileAppScheme("https")).toBe(false);
    expect(isMobileAppScheme(null)).toBe(false);
    expect(mobileAuthCallbackUrl("gokesari", "a.b.c")).toBe("gokesari://auth-callback?code=a.b.c");
  });
});

describe("mobile sign-in code (PKCE)", () => {
  it("matches RFC 7636's S256 example", () => {
    // RFC 7636 Appendix B.
    expect(challengeForVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("redeems for the user it was issued to, with the right verifier", () => {
    const verifier = newVerifier();
    const code = createMobileAuthCode(USER_ID, challengeForVerifier(verifier));
    expect(redeemMobileAuthCode(code, verifier)).toBe(USER_ID);
  });

  it("is useless without the verifier the sign-in started with", () => {
    const code = createMobileAuthCode(USER_ID, challengeForVerifier(newVerifier()));
    expect(redeemMobileAuthCode(code, newVerifier())).toBeNull();
  });

  it("expires", () => {
    const verifier = newVerifier();
    const issuedAt = Date.now();
    const code = createMobileAuthCode(USER_ID, challengeForVerifier(verifier), issuedAt);
    expect(redeemMobileAuthCode(code, verifier, issuedAt + MOBILE_AUTH_CODE_TTL_MS - 1)).toBe(USER_ID);
    expect(redeemMobileAuthCode(code, verifier, issuedAt + MOBILE_AUTH_CODE_TTL_MS)).toBeNull();
  });

  it("cannot be re-pointed at another user or given a longer life", () => {
    const verifier = newVerifier();
    const code = createMobileAuthCode(USER_ID, challengeForVerifier(verifier));
    const [, expires, mac] = code.split(".");
    expect(redeemMobileAuthCode(`${OTHER_USER_ID}.${expires}.${mac}`, verifier)).toBeNull();
    expect(redeemMobileAuthCode(`${USER_ID}.${Number(expires) + 3_600_000}.${mac}`, verifier)).toBeNull();
  });

  it("rejects malformed input instead of throwing", () => {
    const verifier = newVerifier();
    expect(redeemMobileAuthCode("", verifier)).toBeNull();
    expect(redeemMobileAuthCode("a.b", verifier)).toBeNull();
    expect(redeemMobileAuthCode("not-a-uuid.123.abc", verifier)).toBeNull();
    expect(redeemMobileAuthCode(createMobileAuthCode(USER_ID, challengeForVerifier(verifier)), "short")).toBeNull();
  });

  it("only accepts a SHA-256 base64url challenge", () => {
    expect(isValidChallenge(createHash("sha256").update("x").digest("base64url"))).toBe(true);
    expect(isValidChallenge("plain-text-challenge")).toBe(false);
    expect(isValidChallenge(null)).toBe(false);
    expect(() => createMobileAuthCode(USER_ID, "plain")).toThrow();
  });
});

describe("app link association files", () => {
  it("lists the Android package and its signing certificates", () => {
    expect(androidAssetLinks("com.gokesari.app", ["AA:BB"])).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.gokesari.app", sha256_cert_fingerprints: ["AA:BB"] },
      },
    ]);
  });

  it("keeps API calls and the browser half of sign-in out of the iOS app", () => {
    const components = appleAppSiteAssociation(["ABCDE12345.com.gokesari.app"]).applinks.details[0].components;
    expect(components.slice(0, -1)).toEqual([
      { "/": "/api/*", exclude: true },
      { "/": "/mobile-auth/*", exclude: true },
      { "/": "/.well-known/*", exclude: true },
    ]);
    // Exclusions must come before the catch-all: Apple applies the first match.
    expect(components.at(-1)).toEqual({ "/": "*" });
  });
});

describe("website and app agree (mobile/)", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const appConfig = read("mobile/app.config.ts");

  it("on the user-agent token", () => {
    expect(read("mobile/src/config.ts")).toContain(`export const UA_TOKEN = "${MOBILE_APP_UA_TOKEN}";`);
  });

  it("on the URL schemes the sign-in code may go to", () => {
    const variants = /const VARIANTS = \{([\s\S]*?)\} as const;/.exec(appConfig)?.[1] ?? "";
    const schemes = [...variants.matchAll(/scheme: "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(schemes).toEqual([...MOBILE_APP_SCHEMES].sort());
  });

  it("on which pages open in the Android app", () => {
    const list = /const APP_LINK_PATH_PREFIXES = \[([\s\S]*?)\];/.exec(appConfig)?.[1] ?? "";
    const prefixes = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const pages = readdirSync(path.join(root, "src/app"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !/^[._(@[]/.test(entry.name))
      .map((entry) => entry.name)
      .filter((name) => !["api", "mobile-auth"].includes(name));

    const missing = pages.filter((page) => !prefixes.some((prefix) => `/${page}/x`.startsWith(prefix)));
    // A new top-level page: add it to APP_LINK_PATH_PREFIXES in mobile/app.config.ts.
    expect(missing).toEqual([]);
    const stale = prefixes.filter((prefix) => !pages.some((page) => `/${page}/x`.startsWith(prefix)));
    expect(stale).toEqual([]);
  });
});
