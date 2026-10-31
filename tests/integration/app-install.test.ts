/**
 * docs/app-install-2026-10: the signed-in person's install-prompt record
 * (GET/POST /api/app-install), the native update-check endpoint and the
 * service worker script.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET, POST } from "@/app/api/app-install/route";
import { GET as versionGET } from "@/app/api/app/version/route";
import { GET as swGET } from "@/app/sw.js/route";
import { db } from "@/server/db";
import { appInstallStates } from "@/server/db/schema";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

async function signIn() {
  const user = await createUser();
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
  return user;
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/app-install", () => {
  it("needs a signed-in person", async () => {
    expect((await call(GET, "/api/app-install")).status).toBe(401);
    expect((await call(POST, "/api/app-install", { method: "POST", body: { event: "declined", platform: "android" } })).status).toBe(401);
  });

  it("starts empty, counts every decline and never marks installed for a decline", async () => {
    await signIn();
    expect((await call(GET, "/api/app-install")).body).toEqual({ declineCount: 0, lastDeclinedAt: null, installedPlatforms: [] });
    for (let i = 0; i < 3; i++) await call(POST, "/api/app-install", { method: "POST", body: { event: "declined", platform: "android" } });
    const record = (await call(GET, "/api/app-install")).body;
    expect(record.declineCount).toBe(3);
    expect(record.lastDeclinedAt).toEqual(expect.any(String));
    expect(record.installedPlatforms).toEqual([]);
  });

  it("records installs per platform (once each) and an uninstall removes only that platform", async () => {
    const user = await signIn();
    await call(POST, "/api/app-install", { method: "POST", body: { event: "installed", platform: "android" } });
    await call(POST, "/api/app-install", { method: "POST", body: { event: "installed", platform: "android" } });
    await call(POST, "/api/app-install", { method: "POST", body: { event: "installed", platform: "ios" } });
    expect((await call(GET, "/api/app-install")).body.installedPlatforms).toEqual(["android", "ios"]);
    await call(POST, "/api/app-install", { method: "POST", body: { event: "uninstalled", platform: "android" } });
    expect((await call(GET, "/api/app-install")).body.installedPlatforms).toEqual(["ios"]);
    const rows = await db.select().from(appInstallStates).where(eq(appInstallStates.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects unknown events and platforms", async () => {
    await signIn();
    expect((await call(POST, "/api/app-install", { method: "POST", body: { event: "forever", platform: "android" } })).status).toBe(422);
    expect((await call(POST, "/api/app-install", { method: "POST", body: { event: "declined", platform: "tv" } })).status).toBe(422);
  });
});

describe("/api/app/version", () => {
  it("offers nothing until the environment names a version and a link", async () => {
    vi.stubEnv("MOBILE_APP_ANDROID_LATEST", "");
    vi.stubEnv("MOBILE_APP_IOS_LATEST", "");
    const body = await versionGET().json();
    expect(body.android).toEqual({ latest: null, minimum: null, url: null });
  });

  it("returns the configured release per platform", async () => {
    vi.stubEnv("MOBILE_APP_ANDROID_LATEST", "1.4.0");
    vi.stubEnv("MOBILE_APP_ANDROID_MINIMUM", "1.1.0");
    vi.stubEnv("MOBILE_APP_ANDROID_URL", "https://play.google.com/store/apps/details?id=com.gokesari.app");
    const body = await versionGET().json();
    expect(body.android).toEqual({ latest: "1.4.0", minimum: "1.1.0", url: "https://play.google.com/store/apps/details?id=com.gokesari.app" });
  });
});

describe("/sw.js", () => {
  it("is never cached, carries the build version and caches only static files", async () => {
    const response = swGET();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("javascript");
    const script = await response.text();
    expect(script).toContain('const CACHE = "gk-static-" + VERSION');
    expect(script).toContain("/_next/static/");
    expect(script).toContain("SKIP_WAITING");
  });
});
