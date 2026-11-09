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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { encode } from "next-auth/jwt";

import { call } from "./http";
import { blocked } from "./record";
import { BASE_URL, HOST, IS_PROD, IS_REMOTE, TARGET } from "./target";
import { ROLE_NAMES, world, type Role } from "./world";

const AUTH_DIR = process.env.E2E_AUTH_DIR ?? ".e2e-auth";
/** Seller Central's shop switcher (ACTIVE_SHOP_COOKIE in src/lib/seller/active-shop.ts). */
const ACTIVE_SHOP_COOKIE = "gk_shop";
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
  const shopKey = world().users[role]?.activeShop;
  const shopId = shopKey ? world().shops[shopKey]?.id : undefined;
  if (!shopId) return file;
  // An owner's pages open their newest shop unless the switcher chose another; this account owns several.
  const state = JSON.parse(readFileSync(file, "utf8")) as Exclude<StorageState, string | undefined>;
  return {
    ...state,
    cookies: [
      ...state.cookies.filter((c) => c.name !== ACTIVE_SHOP_COOKIE),
      { name: ACTIVE_SHOP_COOKIE, value: shopId, domain: new URL(BASE_URL).hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" },
    ],
  };
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

/**
 * An account that still holds only the CUSTOMER role. Registering a test shop turns an account into
 * a shop owner, so checks about what a plain customer may not do look it up; none left blocks them.
 */
export async function plainCustomer(): Promise<"customer" | "customer2"> {
  const seen: string[] = [];
  for (const role of ["customer2", "customer"] as const) {
    if (!world().users[role]) continue;
    const user = await me(role);
    if (user.role === "CUSTOMER") return role;
    seen.push(`${role} is ${user.role}`);
  }
  blocked(`no test account is still a plain customer (${seen.join(", ")})`);
}

/** Whether `role`'s account owns no shop: its Seller Central home is the registration start. The CUSTOMER role does not say so. */
export async function ownsNoShop(role: Role): Promise<boolean> {
  const res = await call(await as(role), "GET", "/shop", undefined, { maxRedirects: 3 });
  return res.status === 200 && /seller-welcome|Welcome to Seller Central/.test(res.text);
}

/** A plain customer who also owns no shop, for checks about the seller portal. None left blocks them. */
export async function shopFreeCustomer(): Promise<"customer" | "customer2"> {
  const seen: string[] = [];
  for (const role of ["customer2", "customer"] as const) {
    if (!world().users[role]) continue;
    if ((await me(role)).role === "CUSTOMER" && (await ownsNoShop(role))) return role;
    seen.push(role);
  }
  blocked(`no test account is a customer without a shop (${seen.join(", ")} each own one)`);
}

export async function disposeActors() {
  for (const ctx of apis.values()) await ctx.dispose().catch(() => {});
  apis.clear();
  known.clear();
}
