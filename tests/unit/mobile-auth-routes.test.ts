/** The browser half of the app's Google sign-in, and the app-link association files. */
import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.AUTH_GOOGLE_ID = "test-google-id";
  process.env.AUTH_GOOGLE_SECRET = "test-google-secret";
  process.env.MOBILE_ANDROID_CERT_SHA256 = "aa:bb:cc, dd:ee:ff";
  process.env.MOBILE_IOS_APP_IDS = "ABCDE12345.com.gokesari.app";
  return {
    jar: new Map<string, { value: string; options?: Record<string, unknown> }>(),
    deleted: [] as unknown[],
    auth: vi.fn(async (): Promise<{ user: { id: string } } | null> => null),
    signIn: vi.fn(async () => {
      throw new Error("NEXT_REDIRECT");
    }),
    signOut: vi.fn(async () => undefined),
    getCurrentUser: vi.fn(async (): Promise<{ id: string } | null> => null),
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const entry = mocks.jar.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => mocks.jar.set(name, { value, options }),
    delete: (arg: string | { name: string }) => {
      mocks.deleted.push(arg);
      mocks.jar.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
}));
vi.mock("@/server/auth", () => ({ auth: mocks.auth, signIn: mocks.signIn, signOut: mocks.signOut }));
vi.mock("@/server/authz/guards", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { NextRequest } from "next/server";

import { GET as assetLinks } from "@/app/.well-known/assetlinks.json/route";
import { GET as appleAssociation } from "@/app/.well-known/apple-app-site-association/route";
import { GET as complete } from "@/app/mobile-auth/complete/route";
import { GET as start } from "@/app/mobile-auth/start/route";
import { MOBILE_AUTH_COOKIE, challengeForVerifier, redeemMobileAuthCode } from "@/server/mobile-auth";

const USER_ID = "3f0c5a52-6a3e-4c55-9f3b-2a1d7e9b8c11";
const verifier = randomBytes(32).toString("base64url");
const challenge = challengeForVerifier(verifier);

function startRequest(query: string) {
  return new NextRequest(`https://gokesari.com/mobile-auth/start?${query}`);
}

beforeEach(() => {
  mocks.jar.clear();
  mocks.deleted.length = 0;
  vi.clearAllMocks();
  mocks.auth.mockReset().mockResolvedValue(null);
  mocks.getCurrentUser.mockReset().mockResolvedValue(null);
});

describe("/mobile-auth/start", () => {
  it("refuses a missing or plain challenge, or an unknown app", async () => {
    for (const query of ["", `challenge=plain&app=gokesari`, `challenge=${challenge}&app=evil`]) {
      const res = await start(startRequest(query));
      expect(res.status).toBe(400);
    }
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.jar.size).toBe(0);
  });

  it("remembers the app and challenge, then goes to Google", async () => {
    await expect(start(startRequest(`challenge=${challenge}&app=gokesari-preview`))).rejects.toThrow("NEXT_REDIRECT");
    const saved = mocks.jar.get(MOBILE_AUTH_COOKIE);
    expect(saved?.value).toBe(`gokesari-preview.${challenge}`);
    expect(saved?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/mobile-auth" });
    expect(mocks.signIn).toHaveBeenCalledWith("google", { redirectTo: "/mobile-auth/complete" });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("signs out a session the browser already holds, so Google is not linked to it", async () => {
    mocks.auth.mockResolvedValueOnce({ user: { id: USER_ID } });
    await expect(start(startRequest(`challenge=${challenge}&app=gokesari`))).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false });
    expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.signIn.mock.invocationCallOrder[0]);
  });
});

describe("/mobile-auth/complete", () => {
  it("needs the cookie /start set", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: USER_ID });
    const res = await complete();
    expect(res.status).toBe(400);
  });

  it("needs Google to have signed the browser in", async () => {
    mocks.jar.set(MOBILE_AUTH_COOKIE, { value: `gokesari.${challenge}` });
    const res = await complete();
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("auth-callback");
  });

  it("hands the app a code only its verifier can redeem, and forgets the challenge", async () => {
    mocks.jar.set(MOBILE_AUTH_COOKIE, { value: `gokesari.${challenge}` });
    mocks.getCurrentUser.mockResolvedValueOnce({ id: USER_ID });
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const html = await res.text();
    const code = decodeURIComponent(/gokesari:\/\/auth-callback\?code=([^"&\\]+)/.exec(html)?.[1] ?? "");
    expect(redeemMobileAuthCode(code, verifier)).toBe(USER_ID);
    expect(redeemMobileAuthCode(code, randomBytes(32).toString("base64url"))).toBeNull();
    expect(mocks.deleted).toEqual([{ name: MOBILE_AUTH_COOKIE, path: "/mobile-auth" }]);
  });
});

describe("app link association files", () => {
  it("serves assetlinks.json with every configured certificate", async () => {
    const res = assetLinks();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].target).toEqual({
      namespace: "android_app",
      package_name: "com.gokesari.app",
      sha256_cert_fingerprints: ["AA:BB:CC", "DD:EE:FF"],
    });
  });

  it("serves apple-app-site-association as JSON", async () => {
    const res = appleAssociation();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.gokesari.app"]);
  });
});
