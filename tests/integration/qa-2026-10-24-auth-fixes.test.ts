/**
 * Sign-in / sign-out fixes from the automated QA run of 24 Oct 2026:
 *
 * TC-AUTH-034 — a session cookie copied before Sign out kept working (stateless JWT).
 * TC-AUTH-027 — "Email me a link" for a suspended account showed the error page.
 * TC-AUTH-038 — the chosen delivery location survived Sign out.
 * TC-AUTH-040 — a rider who signed out stayed online.
 * TC-AUTH-045 — Sign out wrote no audit row.
 * TC-FLD-004 — a sign-up without the Terms box ticked was accepted by the server.
 *
 * The app's real Auth.js configuration (src/server/auth.ts) runs on the real
 * @auth/core engine here: only the thin next-auth wrapper is replaced (it
 * needs a Next.js request), by one that does what it does — every page and
 * API reads the session through Auth's session action with the request's
 * cookie, and signIn / signOut post to Auth's own routes.
 */
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { CORE, CORE_ERRORS, ORIGIN, SESSION_COOKIE } = vi.hoisted(() => ({
  CORE: "../../node_modules/next-auth/node_modules/@auth/core/index.js",
  CORE_ERRORS: "../../node_modules/next-auth/node_modules/@auth/core/errors.js",
  ORIGIN: "http://localhost:3000",
  SESSION_COOKIE: "authjs.session-token",
}));

type CoreModule = {
  Auth: (request: Request, config: unknown) => Promise<Response & { redirect?: string; cookies?: { name: string; value: string }[] }>;
  raw: symbol;
  skipCSRFCheck: symbol;
};

const state = vi.hoisted(() => {
  // The emailed-link provider is on (console mode outside production), as on a site with SMTP.
  process.env.AUTH_EMAIL_FROM = "GoKesari <no-reply@test.local>";
  return {
    /** The session cookie the current "request" carries. */
    cookie: "",
    /** Cookies the current request deleted. */
    deleted: [] as string[],
    outbox: [] as { to: string; subject: string; text: string }[],
    core: null as unknown as CoreModule,
    config: null as unknown as Record<string, unknown>,
  };
});

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      ...(state.cookie ? { cookie: `${SESSION_COOKIE}=${state.cookie}` } : {}),
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "qa-vitest",
    }),
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: (name: string) => {
      state.deleted.push(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

/** next-auth's wrapper, minus Next.js: the same calls into the real Auth.js core. */
vi.mock("next-auth", async () => {
  const core = (await import(/* @vite-ignore */ CORE)) as CoreModule;
  const errors = (await import(/* @vite-ignore */ CORE_ERRORS)) as { AuthError: typeof Error };
  state.core = core;
  const post = (path: string, body: Record<string, string>, cookie = state.cookie) =>
    new Request(`${ORIGIN}/api/auth/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
      },
      body: new URLSearchParams(body),
    });
  return {
    default: (config: Record<string, unknown>) => {
      state.config = { ...config, basePath: "/api/auth" };
      const rawConfig = () => ({ ...state.config, raw: core.raw, skipCSRFCheck: core.skipCSRFCheck });
      return {
        handlers: {},
        // auth() in a page, server action or route handler: Auth's session action with the request's cookie.
        auth: async () => {
          const res = await core.Auth(
            new Request(`${ORIGIN}/api/auth/session`, { headers: state.cookie ? { cookie: `${SESSION_COOKIE}=${state.cookie}` } : {} }),
            state.config,
          );
          if (!res.ok) return null;
          const data = await res.json();
          return data && Object.keys(data).length ? data : null;
        },
        signIn: async (provider: string, options: Record<string, string> = {}) => {
          const { redirectTo, ...rest } = options;
          const credentials = provider === "otp-ticket" || provider === "test-credentials";
          return core.Auth(post(`${credentials ? "callback" : "signin"}/${provider}`, { ...rest, callbackUrl: redirectTo ?? "/" }), rawConfig());
        },
        signOut: async () => core.Auth(post("signout", { callbackUrl: "/" }), rawConfig()),
      };
    },
    AuthError: errors.AuthError,
  };
});

import { GET as walletRoute } from "@/app/api/wallet/route";
import { POST as cartRoute } from "@/app/api/cart/route";
import { POST as housekeepingRoute } from "@/app/api/cron/auth-housekeeping/route";
import SignInPage from "@/app/signin/page";
import { resetRateLimits } from "@/server/api/rate-limit";
import { purgeExpiredSessionRevocations } from "@/server/auth-sessions";
import { getCurrentUser } from "@/server/authz/guards";
import { signIn, signOut } from "@/server/auth";
import { db } from "@/server/db";
import { auditLogs, deliveryOrders, deliveryPartners, loginOtps, revokedSessions, userConsents, users } from "@/server/db/schema";
import { TERMS_REQUIRED, requestLoginOtp, verifyLoginOtp } from "@/server/otp/service";
import { signOutAction } from "@/server/sign-out-action";
import { call } from "../helpers/http";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(revokedSessions);
  resetRateLimits();
  state.cookie = "";
  state.deleted = [];
  state.outbox = [];
});

/** Signs in through Auth's own callback (the dev-only email provider) and returns the new session cookie. */
async function signInCookie(email: string): Promise<string> {
  state.cookie = "";
  const res = (await signIn("test-credentials", { email, redirectTo: "/" })) as unknown as { cookies?: { name: string; value: string }[] };
  const cookie = res.cookies?.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("no session cookie was issued");
  return cookie;
}

/** /api/auth/session with this cookie: the session (or null) and the cookies the reply sets. */
async function sessionEndpoint(cookie: string) {
  const res = await state.core.Auth(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }), state.config);
  const body = await res.json();
  return { session: body && Object.keys(body).length ? body : null, setCookies: res.headers.getSetCookie() };
}

async function asRequestWith(cookie: string) {
  state.cookie = cookie;
  return getCurrentUser();
}

describe("TC-AUTH-034: Sign out ends the session on the server", () => {
  it("a copy of the session cookie taken before Sign out is refused afterwards by pages, APIs and /api/auth/session", async () => {
    const customer = await createUser({ email: "copy@test.local" });
    const cookie = await signInCookie(customer.email);
    const copied = cookie; // what someone copies out of the browser before the owner signs out

    expect((await asRequestWith(copied))?.id).toBe(customer.id);
    expect((await call(walletRoute, "/api/wallet")).status).toBe(200);
    expect((await call(cartRoute, "/api/cart", { method: "POST", body: { shopProductId: crypto.randomUUID(), quantity: 1 } })).status).not.toBe(401);

    state.cookie = cookie;
    await signOutAction(); // the header menu's Sign out

    // The copy: no user for a page, 401 for the APIs.
    expect(await asRequestWith(copied)).toBeNull();
    const wallet = await call(walletRoute, "/api/wallet");
    expect(wallet.status).toBe(401);
    expect(wallet.body.error.code).toBe("UNAUTHENTICATED");
    expect((await call(cartRoute, "/api/cart", { method: "POST", body: { shopProductId: crypto.randomUUID(), quantity: 1 } })).status).toBe(401);

    // /api/auth/session neither answers with the user nor re-issues (extends) the token; it clears the cookie.
    const endpoint = await sessionEndpoint(copied);
    expect(endpoint.session).toBeNull();
    expect(endpoint.setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);

    const [row] = await db.select().from(revokedSessions).where(eq(revokedSessions.userId, customer.id));
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 24 * 60 * 60_000); // outlives every copy
  });

  it("signing out on one device leaves the person's other sessions signed in (per session, not per person)", async () => {
    const customer = await createUser({ email: "two-devices@test.local" });
    const phone = await signInCookie(customer.email);
    const laptop = await signInCookie(customer.email);
    state.cookie = phone;
    await signOut();
    expect(await asRequestWith(phone)).toBeNull();
    expect((await asRequestWith(laptop))?.id).toBe(customer.id);
  });

  it("a session re-issued by /api/auth/session keeps its id, so signing out with either copy ends both — also for a token from before session ids", async () => {
    const { encode } = await import("next-auth/jwt");
    const customer = await createUser({ email: "reissued@test.local" });
    const reissue = async (cookie: string) =>
      (await sessionEndpoint(cookie)).setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0].slice(SESSION_COOKIE.length + 1);
    const fromSignIn = await signInCookie(customer.email);
    const fromBefore = await encode({ token: { sub: customer.id, email: customer.email }, secret: process.env.AUTH_SECRET!, salt: SESSION_COOKIE });
    for (const original of [fromSignIn, fromBefore]) {
      const refreshed = await reissue(original);
      expect(refreshed).not.toBe(original);
      state.cookie = refreshed;
      await signOut();
      expect(await asRequestWith(original)).toBeNull();
      expect(await asRequestWith(refreshed)).toBeNull();
    }
  });

  it("a token issued before session ids existed (no sid) works, and Sign out refuses its copies too", async () => {
    const { encode } = await import("next-auth/jwt");
    const customer = await createUser({ email: "legacy@test.local" });
    const legacy = await encode({ token: { sub: customer.id, email: customer.email, name: "Legacy" }, secret: process.env.AUTH_SECRET!, salt: SESSION_COOKIE });
    const other = await encode({ token: { sub: customer.id, email: customer.email, name: "Legacy" }, secret: process.env.AUTH_SECRET!, salt: SESSION_COOKIE });
    expect((await asRequestWith(legacy))?.id).toBe(customer.id);
    state.cookie = legacy;
    await signOut();
    expect(await asRequestWith(legacy)).toBeNull();
    expect((await asRequestWith(other))?.id).toBe(customer.id); // a different session of the same person
  });

  it("keeps the suspension check: a suspended account's session is refused while suspended, and works again once reinstated", async () => {
    const customer = await createUser({ email: "suspended-session@test.local" });
    const cookie = await signInCookie(customer.email);
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, customer.id));
    expect(await asRequestWith(cookie)).toBeNull();
    await db.update(users).set({ status: "ACTIVE" }).where(eq(users.id, customer.id));
    expect((await asRequestWith(cookie))?.id).toBe(customer.id);
    expect(await db.select().from(revokedSessions)).toHaveLength(0);
  });

  it("the auth-housekeeping job forgets revocations once every copy has expired", async () => {
    const customer = await createUser();
    const past = new Date(Date.now() - 60_000);
    await db.insert(revokedSessions).values([
      { sessionId: "expired-one", userId: customer.id, expiresAt: past },
      { sessionId: "still-live", userId: customer.id, expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    const response = await housekeepingRoute(
      new NextRequest("http://localhost/api/cron/auth-housekeeping", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).sessions).toEqual({ deleted: 1 });
    expect((await db.select().from(revokedSessions)).map((r) => r.sessionId)).toEqual(["still-live"]);
    expect(await purgeExpiredSessionRevocations()).toEqual({ deleted: 0 });
  });
});

describe("Sign out: location, rider and audit", () => {
  it("TC-AUTH-038: clears the chosen delivery location cookie so the next person on the phone does not see it", async () => {
    const owner = await createUser({ email: "shared-phone@test.local" });
    state.cookie = await signInCookie(owner.email);
    await signOutAction();
    expect(state.deleted).toContain("gk_location");
  });

  it("TC-AUTH-045: records auth.signed_out with the user, IP and time — once, even for a double click", async () => {
    const customer = await createUser({ email: "audit-out@test.local" });
    const cookie = await signInCookie(customer.email);
    state.cookie = cookie;
    await signOutAction();
    state.cookie = cookie; // the second click of a double click still carries the cookie
    await signOutAction();
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "auth.signed_out"), eq(auditLogs.actorId, customer.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "user", entityId: customer.id, ipAddress: "203.0.113.7", userAgent: "qa-vitest" });
  });

  it("TC-AUTH-040: an online rider who signs out is set offline (and not offered the next READY order)", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER", email: "rider-out@test.local" });
    const partner = await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: 18.52, longitude: 73.85 });
    state.cookie = await signInCookie(riderUser.email);
    await signOutAction();
    const [after] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(after.isOnline).toBe(false);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "delivery_partner.online_status_changed"), eq(auditLogs.entityId, partner.id)));
    expect(audit.map((a) => a.newValue)).toEqual([{ isOnline: false }]);
  });

  it("TC-AUTH-040: a rider signing out mid-delivery is signed out, but the delivery and the online flag are left alone", async () => {
    const riderUser = await createUser({ role: "DELIVERY_PARTNER", email: "rider-busy@test.local" });
    const partner = await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: 18.52, longitude: 73.85 });
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(shopOwner.id);
    const order = await createOrder((await createUser()).id, shop.id, { status: "READY" });
    const [delivery] = await db.insert(deliveryOrders).values({ orderId: order.id, deliveryPartnerId: partner.id, status: "PICKED_UP" }).returning();
    const cookie = await signInCookie(riderUser.email);
    state.cookie = cookie;
    await signOutAction();
    expect(await asRequestWith(cookie)).toBeNull(); // the sign-out itself went ahead
    const [after] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(after.isOnline).toBe(true);
    const [job] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, delivery.id));
    expect(job.status).toBe("PICKED_UP");
    expect(job.deliveryPartnerId).toBe(partner.id);
  });
});

/* ------------------------------------------------------------- /signin */

type AnyElement = ReactElement<{ children?: ReactNode; action?: unknown; verify?: unknown; id?: string }>;

/** Every element of the page's tree (the page's own JSX, not rendered). */
function elements(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as AnyElement;
    out.push(element);
    elements(element.props.children, out);
  }
  return out;
}

async function signInPage(query: Record<string, string> = {}) {
  state.cookie = "";
  return elements(await SignInPage({ searchParams: Promise.resolve(query) }));
}

/** The server action of the form that holds the element with this id. */
function formActionAround(tree: AnyElement[], inputId: string) {
  const form = tree.find((e) => e.type === "form" && elements(e.props.children).some((c) => c.props.id === inputId));
  if (!form || typeof form.props.action !== "function") throw new Error(`no form around #${inputId}`);
  return form.props.action as (data: FormData) => Promise<void>;
}

describe("TC-AUTH-027: a refused sign-in from the sign-in page's forms", () => {
  it("'Email me a link' for a suspended account lands on /signin?error=AccessDenied, not the error page, and sends no link", async () => {
    const suspended = await createUser({ email: "suspended-link@test.local" });
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, suspended.id));
    const emailLink = formActionAround(await signInPage(), "magic-link-email");
    const form = new FormData();
    form.set("email", suspended.email);
    await expect(emailLink(form)).rejects.toThrow("REDIRECT:/signin?error=AccessDenied");
    expect(state.outbox).toHaveLength(0);
  });

  it("the page it lands on shows the suspended notice with the grievance link", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ error: "AccessDenied" }) }));
    expect(html).toContain("This account is suspended or closed, so it cannot sign in.");
    expect(html).toContain('href="/grievance"');
  });
});

describe("TC-FLD-004: no new account without the Terms & Privacy consent", () => {
  function lastCodeTo(email: string): string {
    const code = [...state.outbox].reverse().find((m) => m.to === email)?.subject.match(/^(\d{4,8}) /)?.[1];
    if (!code) throw new Error(`no code was emailed to ${email}`);
    return code;
  }

  it("the server refuses a sign-up sent without consent: no account, no consent row — and the same code works once it is ticked", async () => {
    const email = "no-consent@test.local";
    await requestLoginOtp({ email });
    const code = lastCodeTo(email);
    await expect(verifyLoginOtp({ email, code })).rejects.toThrow(TERMS_REQUIRED);
    await expect(verifyLoginOtp({ email, code, acceptedTerms: false })).rejects.toThrow(TERMS_REQUIRED);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    const blocked = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.otp_blocked"));
    expect(blocked.map((r) => (r.newValue as { reason?: string }).reason)).toContain("terms_not_accepted");

    const { user, isNewUser } = await verifyLoginOtp({ email, code, acceptedTerms: true });
    expect(isNewUser).toBe(true);
    const consents = await db.select().from(userConsents).where(eq(userConsents.userId, user.id));
    expect(consents.map((c) => [c.consentType, c.granted])).toEqual([["TERMS_AND_PRIVACY", true]]);
  });

  it("a wrong code says only that the code is wrong, whatever the consent (it tells nothing about which emails have accounts)", async () => {
    await requestLoginOtp({ email: "probe@test.local" });
    const code = lastCodeTo("probe@test.local");
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(verifyLoginOtp({ email: "probe@test.local", code: wrong })).rejects.toThrow(/wrong or has expired/);
  });

  it("an existing account signs in again without being asked", async () => {
    const existing = await createUser({ email: "returning@test.local" });
    await requestLoginOtp({ email: existing.email });
    const { user, isNewUser } = await verifyLoginOtp({ email: existing.email, code: lastCodeTo(existing.email) });
    expect([user.id, isNewUser]).toEqual([existing.id, false]);
  });

  it("the sign-in page's code step passes the box's state to the server", async () => {
    const tree = await signInPage();
    const otpForm = tree.find((e) => typeof e.props.verify === "function");
    const verify = otpForm!.props.verify as (input: { mobile: string | null; email: string | null; code: string; acceptedTerms: boolean }) => Promise<{ error?: string } | void>;
    const email = "page-signup@test.local";
    await requestLoginOtp({ email });
    const code = lastCodeTo(email);
    expect(await verify({ mobile: null, email, code, acceptedTerms: false })).toEqual({ error: TERMS_REQUIRED });
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
    // Ticked: the account is created and the session opened (Auth's callback issues the cookie).
    expect(await verify({ mobile: null, email, code, acceptedTerms: true })).toBeUndefined();
    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created).toBeDefined();
    expect(await db.select().from(loginOtps).where(eq(loginOtps.email, email))).toHaveLength(1);
  });
});
