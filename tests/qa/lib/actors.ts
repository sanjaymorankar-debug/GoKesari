/**
 * Signed-in test accounts, as an API request context or a browser page.
 *
 * staging  the saved session of the staging test account
 *          ($E2E_AUTH_DIR/staging-<role>.json, written by scripts/qa/signin-staging.ts
 *          from the normal emailed sign-in code). A missing or expired session
 *          blocks the case; it is never forged.
 * local    the session cookie is minted exactly as Auth.js mints it, with the
 *          local server's AUTH_SECRET, for the account scripts/qa/seed-local.ts
 *          created. The app still reads role and status from its database.
 *
 * Never on production: tierRefusal() keeps signed-in cases off gokesari.com,
 * and as() refuses there again.
 */
import { request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { encode } from "next-auth/jwt";

import { call } from "./http";
import { blocked } from "./record";
import { BASE_URL, HOST, IS_PROD, IS_REMOTE, TARGET } from "./target";
import { ROLE_NAMES, world, type Role } from "./world";

const AUTH_DIR = process.env.E2E_AUTH_DIR ?? ".e2e-auth";
const SECURE = BASE_URL.startsWith("https");
const COOKIE = SECURE ? "__Secure-authjs.session-token" : "authjs.session-token";

type StorageState = Exclude<Parameters<Browser["newContext"]>[0], undefined>["storageState"];

export function sessionFile(role: Role) {
  return join(AUTH_DIR, `${TARGET}-${role}.json`);
}

/** The storage state that signs `role` in on this target (blocks the case when there is none). */
export async function storageFor(role: Role): Promise<StorageState> {
  if (IS_PROD) throw new Error(`Refusing to sign in on ${HOST}: production runs the guest tier only.`);
  if (TARGET === "local") {
    const user = world().users[role];
    if (!user?.id) blocked(`the local world has no ${ROLE_NAMES[role]} account "${role}" (run scripts/qa/seed-local.ts)`);
    const secret = process.env.AUTH_SECRET;
    if (!secret) blocked("AUTH_SECRET (the local server's) is not set");
    const value = await encode({ token: { sub: user.id, email: user.email, name: role }, secret, salt: COOKIE });
    const url = new URL(BASE_URL);
    return {
      cookies: [{ name: COOKIE, value, domain: url.hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" }],
      origins: [],
    };
  }
  const file = sessionFile(role);
  if (!existsSync(file)) blocked(`no saved ${ROLE_NAMES[role]} session for ${TARGET} (${file}); run scripts/qa/signin-staging.ts`);
  return file;
}

const apis = new Map<Role, APIRequestContext>();

/** The API request context signed in as `role`. */
export async function as(role: Role): Promise<APIRequestContext> {
  const existing = apis.get(role);
  if (existing) return existing;
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: await storageFor(role), timeout: 120_000 });
  apis.set(role, ctx);
  return ctx;
}

/** A browser context + page signed in as `role` (close the context when done). */
export async function pageAs(browser: Browser, role: Role, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, storageState: await storageFor(role) });
  const page = await context.newPage();
  if (IS_REMOTE) {
    // The test site serves a cold page in 8–10 s and hydrates after it: a click or a keystroke
    // before React is ready is lost. Every visit waits for the network to settle (at most 10 s).
    const goto = page.goto.bind(page);
    page.goto = async (url, gotoOptions) => {
      const res = await goto(url, gotoOptions);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      return res;
    };
  }
  return { context, page };
}

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  name?: string | null;
}

const known = new Map<Role, SessionUser>();

/** Who `role`'s session is (from /api/auth/session); blocks when it is not signed in. */
export async function me(role: Role): Promise<SessionUser> {
  const cached = known.get(role);
  if (cached) return cached;
  const res = await call(await as(role), "GET", "/api/auth/session");
  const user = res.body?.user;
  if (res.status !== 200 || !user?.id) blocked(`the ${ROLE_NAMES[role]} session is not signed in (expired?) — HTTP ${res.status}`);
  const row = { id: String(user.id), email: String(user.email ?? ""), role: String(user.role ?? ""), name: user.name ?? null };
  known.set(role, row);
  return row;
}

export async function disposeActors() {
  for (const ctx of apis.values()) await ctx.dispose().catch(() => {});
  apis.clear();
  known.clear();
}
