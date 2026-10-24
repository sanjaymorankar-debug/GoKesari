/**
 * Helpers for the sign-in, profile, society and marketing checks (QA package 1).
 *
 *  - sign-in codes: requests to /api/otp/request with a per-check client IP
 *    (X-Forwarded-For), so the per-IP code limit — one shared "unknown"
 *    bucket for every request from this machine — is met only by the check
 *    that tests it (TC-AUTH-018);
 *  - the sign-in page driven as a person uses it (consent box, mobile or
 *    email, the emailed code from the local mail catcher);
 *  - local-only accounts created in the database for checks that need a
 *    brand-new or a second customer, signed in by a session minted exactly as
 *    Auth.js mints it (the same way actors.ts signs in the world's accounts);
 *  - business rules changed for one check and restored afterwards;
 *  - a whole order for any customer context (checkout, packing, delivery).
 *
 * Everything that writes calls assertWritable(); the database helpers refuse
 * anything but the local server (db()).
 */
import { expect, request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { encode } from "next-auth/jwt";

import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";

import { as, storageFor } from "./actors";
import { db } from "./db";
import { offerFor, packOrder, pickupCode, riderAction } from "./flows";
import { call, expectStatus, RUN, SLOW_MS, stash, unstash, why, type Answer } from "./http";
import { messagesTo, waitForCode } from "./mail";
import { blocked, need } from "./record";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";
import { world, type Role } from "./world";

const SECURE = BASE_URL.startsWith("https");
export const SESSION_COOKIE = SECURE ? "__Secure-authjs.session-token" : "authjs.session-token";

/* ------------------------------------------------------------ identities */

/** A client IP of its own for one check (the app keys its anonymous limits on X-Forwarded-For). */
export function fakeIp() {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** An email no account has, reachable through the local mail catcher. */
export function uniqueEmail(label: string) {
  return `qa-auth-${label}-${RUN}-${randomUUID().slice(0, 6)}@test.local`.toLowerCase();
}

let mobileSeq = 0;
/** A 10-digit Indian mobile (starts with 6) no seeded account uses. */
export function uniqueMobile() {
  mobileSeq += 1;
  return `6${String(Date.now()).slice(-6)}${String(randomInt(0, 10))}${String(mobileSeq % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------------- sign-in codes */

let anon: APIRequestContext | null = null;
async function anonymousCtx() {
  anon ??= await playwrightRequest.newContext({ baseURL: BASE_URL, timeout: SLOW_MS });
  return anon;
}

/** POST /api/otp/request as a signed-out visitor from `ip`. */
export async function requestCode(body: { mobile?: string | null; email?: string | null }, ip = fakeIp()): Promise<Answer & { ms: number }> {
  assertWritable("request a sign-in code");
  const started = Date.now();
  const res = await call(await anonymousCtx(), "POST", "/api/otp/request", body, { headers: { "x-forwarded-for": ip } });
  return { ...res, ms: Date.now() - started };
}

/** login_otps rows for an email (newest first). Local only. */
export async function otpRows(email: string, purpose = "LOGIN") {
  return db()<{ id: string; code_hash: string; attempts: number; max_attempts: number; expires_at: Date; created_at: Date; consumed_at: Date | null; superseded_at: Date | null; phone_e164: string | null; channel: string; user_id: string | null }[]>`
    select id, code_hash, attempts, max_attempts, expires_at, created_at, consumed_at, superseded_at, phone_e164, channel, user_id
    from login_otps where email = ${email.toLowerCase()} and purpose = ${purpose} order by created_at desc`;
}

/** Moves an email's codes back in time, past the resend cooldown (a person waiting a minute). Local only. */
export async function ageCodes(email: string, seconds = 61, purpose = "LOGIN") {
  await db()`update login_otps set created_at = created_at - make_interval(secs => ${seconds}) where email = ${email.toLowerCase()} and purpose = ${purpose}`;
}

/** Audit rows of `action` written since `since` (ms epoch). Local only. */
export async function auditSince(action: string, since: number) {
  return db()<{ id: string; action: string; actor_id: string | null; entity_type: string; entity_id: string | null; new_value: Record<string, unknown> | null; previous_value: Record<string, unknown> | null; created_at: Date }[]>`
    select id, action, actor_id, entity_type, entity_id, new_value, previous_value, created_at from audit_logs
    where action = ${action} and created_at >= ${new Date(since - 2000)} order by created_at desc`;
}

/** The subject line of the newest message to `to` since `since`. */
export function newestSubject(to: string, since: number): string | null {
  const [message] = messagesTo(to, since);
  return message?.body.match(/^Subject:\s*(.+)$/m)?.[1]?.trim() ?? null;
}

/* ------------------------------------------------------- the sign-in page */

/** Ticks the one consent box until React (once hydrated) enables Get code. */
export async function agreeToTerms(page: Page) {
  const agree = page.getByTestId("signin-consent").getByRole("checkbox");
  const getCode = page.getByRole("button", { name: "Get code" });
  for (let i = 0; i < 30 && !(await getCode.isEnabled().catch(() => false)); i++) {
    if (await agree.isChecked().catch(() => false)) await agree.click({ force: true }).catch(() => {});
    await agree.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await expect(getCode, "Get code is enabled once 'I agree' is ticked").toBeEnabled();
}

export async function openSignIn(page: Page) {
  const res = await page.goto("/signin", { waitUntil: "domcontentloaded" });
  expect(res?.status() ?? 0, "GET /signin").toBeLessThan(400);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  if (!(await page.getByLabel("Mobile number or email").count())) blocked("the sign-in code form is not shown (email sending is not configured on this server)");
}

export interface CodeSignIn {
  /** The code that was mailed. */
  code: string;
  /** Where the code went (the account email). */
  email: string;
  /** What the code step said about where the code went. */
  sentTo: string;
  /** Time (ms epoch) just before the code was requested. */
  since: number;
}

/**
 * Requests a code on /signin for `identifier` (a mobile or an email) and
 * moves to the code step. With `signupEmail`, a mobile with no account signs
 * up from the code step ("Sign up with your email").
 */
export async function requestCodeOnPage(page: Page, identifier: string, options: { signupEmail?: string; codeEmail?: string } = {}): Promise<Omit<CodeSignIn, "code"> & { code: () => Promise<string> }> {
  await openSignIn(page);
  await agreeToTerms(page);
  await page.getByLabel("Mobile number or email").fill(identifier);
  let since = Date.now();
  await page.getByRole("button", { name: "Get code" }).click();
  const sentTo = page.getByTestId("otp-sent-to");
  await expect(sentTo, "the code step opens").toBeVisible();
  if (options.signupEmail) {
    await page.getByRole("button", { name: "Sign up with your email" }).click();
    await page.getByLabel("Email address").fill(options.signupEmail);
    since = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(sentTo).toContainText("***@");
  }
  const email = (options.signupEmail ?? options.codeEmail ?? identifier).trim().toLowerCase();
  const text = (await sentTo.innerText()).trim();
  return { email, sentTo: text, since, code: () => waitForCode(email, since) };
}

/** Types a code on the code step and presses Sign in. */
export async function enterCode(page: Page, code: string) {
  await page.getByLabel("One-time code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The whole sign-in by an emailed code; returns once the page has left /signin. */
export async function signInWithCode(page: Page, identifier: string, options: { signupEmail?: string; codeEmail?: string } = {}): Promise<CodeSignIn> {
  const step = await requestCodeOnPage(page, identifier, options);
  const code = await step.code();
  await enterCode(page, code);
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  return { code, email: step.email, sentTo: step.sentTo, since: step.since };
}

/** A fresh browser context with a client IP of its own (no session). */
export async function guestContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, extraHTTPHeaders: { "x-forwarded-for": fakeIp(), ...(options.extraHTTPHeaders ?? {}) } });
  const page = await context.newPage();
  return { context, page };
}

/** Waits until a code may be requested again for `email` (the 60 s resend cooldown), then returns. */
export async function waitOutCooldown(email: string, seconds = 61) {
  const [last] = await otpRows(email);
  if (!last) return;
  const wait = last.created_at.getTime() + seconds * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/* ------------------------------------------------------------ signing out */

const ACCOUNT_BUTTONS = ["account-button", "board-account", "seller-account-button", "account-dropdown"];

/** Waits until the browser no longer holds a session cookie (the sign-out answer clears it). */
export async function waitSignedOut(page: Page) {
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === SESSION_COOKIE), { message: "the session cookie is cleared", timeout: 30_000 })
    .toBe(false);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
}

/** Opens whichever account menu the page's header has and presses Sign out. */
export async function signOutFromMenu(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const id of ACCOUNT_BUTTONS) {
      const button = page.getByTestId(id).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        const signOut = page.getByRole("button", { name: /^Sign out$/ }).or(page.getByRole("menuitem", { name: /Sign out/ })).first();
        await expect(signOut, "Sign out in the account menu").toBeVisible();
        await signOut.click();
        await waitSignedOut(page);
        return id;
      }
    }
    // A phone header keeps the account menu behind "Open menu".
    const menu = page.getByRole("button", { name: /Open menu/i }).first();
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      const signOut = page.getByRole("button", { name: /^Sign out$/ }).first();
      if (await signOut.isVisible().catch(() => false)) {
        await signOut.click();
        await waitSignedOut(page);
        return "open-menu";
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`no account menu with Sign out on ${page.url()}`);
}

/** The signed-in user of a context, or null (GET /api/auth/session). */
export async function sessionUser(ctx: APIRequestContext): Promise<{ id: string; email: string; role: string; name: string | null } | null> {
  // One retry when a kept-alive connection was dropped ("socket hang up"); a real answer is never retried.
  const res = await call(ctx, "GET", "/api/auth/session").catch(() => call(ctx, "GET", "/api/auth/session"));
  return res.body?.user?.id ? res.body.user : null;
}

/** The session cookies of a world account (the minted one locally, the saved one on staging), to add to an open browser. */
export async function cookiesOf(role: Role) {
  const state = await storageFor(role);
  const parsed = typeof state === "string" ? (JSON.parse(readFileSync(state, "utf8")) as { cookies: Parameters<BrowserContext["addCookies"]>[0] }) : state;
  return (parsed as { cookies: Parameters<BrowserContext["addCookies"]>[0] }).cookies;
}

/* ---------------------------------------------------- local-only accounts */

export interface LocalUser {
  id: string;
  email: string;
  mobile: string | null;
  addressId: string | null;
  cookie: string;
  ctx: APIRequestContext;
}

/** A session cookie for `userId`, minted with the local server's AUTH_SECRET (as Auth.js mints it). */
export async function mintSession(userId: string, email: string, maxAgeSeconds?: number) {
  if (!IS_LOCAL) blocked("minting a session needs the local server's secret");
  const secret = process.env.AUTH_SECRET;
  if (!secret) blocked("AUTH_SECRET (the local server's) is not set");
  return encode({ token: { sub: userId, email, name: email.split("@")[0] }, secret, salt: SESSION_COOKIE, ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}) });
}

export function cookieState(value: string) {
  const url = new URL(BASE_URL);
  return {
    cookies: [{ name: SESSION_COOKIE, value, domain: url.hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" as const }],
    origins: [],
  };
}

export async function apiWithCookie(value: string) {
  return playwrightRequest.newContext({ baseURL: BASE_URL, storageState: cookieState(value), timeout: SLOW_MS, extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
}

/** A browser context + page signed in with a session cookie. */
export async function browserWithCookie(browser: Browser, value: string, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, storageState: cookieState(value), extraHTTPHeaders: { "x-forwarded-for": fakeIp() } });
  return { context, page: await context.newPage() };
}

/**
 * A customer created in the local database for one check — brand new, or set
 * up like an existing customer (details saved, mobile, default address in shop
 * A's zone, a funded wallet, marketing consent).
 */
export async function localUser(
  label: string,
  options: {
    mobile?: string | null;
    name?: string | null;
    profileComplete?: boolean;
    walletPaise?: number;
    address?: boolean;
    marketingConsent?: boolean;
    email?: string;
    placeholderEmail?: boolean;
    createdAt?: Date;
  } = {},
): Promise<LocalUser> {
  if (!IS_LOCAL) blocked("a new customer account is created in the local database only");
  const sql = db();
  const mobile = options.mobile === undefined ? uniqueMobile() : options.mobile;
  const email = options.email ?? (options.placeholderEmail && mobile ? `m91${mobile}@no-email.gokesari.invalid` : uniqueEmail(label));
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, name, role, phone, phone_e164, email_verified, profile_completed_at, email_placeholder, created_at)
    values (${email}, ${options.name === undefined ? `QA ${label}` : options.name}, 'CUSTOMER', ${mobile}, ${mobile ? `+91${mobile}` : null}, now(),
      ${options.profileComplete === false ? null : new Date()}, ${Boolean(options.placeholderEmail)}, ${options.createdAt ?? new Date()})
    returning id`;
  const [wallet] = await sql<{ id: string }[]>`insert into wallets (user_id, balance_paise) values (${user.id}, 0) returning id`;
  if (options.walletPaise) await fundWallet(user.id, options.walletPaise);
  await sql`insert into user_consents (user_id, consent_type, version, granted) values (${user.id}, 'TERMS_AND_PRIVACY', ${CURRENT_POLICY_VERSION}, true)`;
  if (options.marketingConsent) await sql`insert into user_consents (user_id, consent_type, version, granted) values (${user.id}, 'MARKETING_COMMUNICATIONS', ${CURRENT_POLICY_VERSION}, true)`;
  let addressId: string | null = null;
  if (options.address) addressId = await addAddress(user.id, `QA ${label} flat ${randomInt(1, 999)}`);
  void wallet;
  const cookie = await mintSession(user.id, email);
  return { id: user.id, email, mobile, addressId, cookie, ctx: await apiWithCookie(cookie) };
}

/** Credits a wallet with a matching ledger row, as a settled top-up leaves it. Local only. */
export async function fundWallet(userId: string, amountPaise: number) {
  await db()`
    with w as (select id, balance_paise from wallets where user_id = ${userId} for update)
    , upd as (update wallets set balance_paise = balance_paise + ${amountPaise}, updated_at = now() where id = (select id from w) returning id)
    insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
    select w.id, ${userId}, 'TOP_UP', ${amountPaise}, w.balance_paise, w.balance_paise + ${amountPaise}, ${`qa-auth-topup-${RUN}-${randomUUID()}`}, 'QA top-up'
    from w`;
}

/** A default, geo-tagged address about 1 km from shop A. Local only. */
export async function addAddress(userId: string, line1: string, extra: { societyId?: string | null; isDefault?: boolean } = {}) {
  const home = world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
  const [row] = await db()<{ id: string }[]>`
    insert into addresses (user_id, line1, area, city, state, pincode, latitude, longitude, address_type, recipient_name, is_default, location_verified, location_verified_at, location_source, society_id)
    values (${userId}, ${line1}, 'Kothrud', 'Pune', 'Maharashtra', ${home.pincode}, ${String(home.lat + 0.009)}, ${String(home.lng)}, 'HOME', 'QA Recipient',
      ${extra.isDefault ?? true}, true, now(), 'qa_seed', ${extra.societyId ?? null})
    returning id`;
  return row.id;
}

/* ------------------------------------------------------------ business rules */

/**
 * Runs `body` with rule `key` overridden by `value` (merged over its current
 * value), then puts the rule back exactly as it was: the earlier override, or
 * the code default when there was none.
 */
export async function withRule<T>(key: string, value: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked(`changing rule "${key}" is for the local server only`);
  const admin = await as("admin");
  const list = await call(admin, "GET", "/api/admin/settings");
  expectStatus(list, 200, "GET /api/admin/settings");
  const rule = (list.body.rules as { key: string; value: Record<string, unknown>; overridden: boolean }[]).find((r) => r.key === key);
  if (!rule) throw new Error(`no rule "${key}"`);
  const set = await call(admin, "PUT", "/api/admin/settings", { key, value: { ...rule.value, ...value } });
  expectStatus(set, 200, `set rule ${key}`);
  try {
    return await body();
  } finally {
    const restore = rule.overridden
      ? await call(admin, "PUT", "/api/admin/settings", { key, value: rule.value })
      : await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(key)}`);
    expectStatus(restore, 200, `restore rule ${key}`);
  }
}

/** The effective value of a rule (as the admin settings list shows it). */
export async function ruleValue(key: string): Promise<Record<string, unknown>> {
  const list = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(list, 200, "GET /api/admin/settings");
  return (list.body.rules as { key: string; value: Record<string, unknown> }[]).find((r) => r.key === key)?.value ?? {};
}

/* --------------------------------------------------------- whole orders */

export interface SimpleOrder {
  id: string;
  orderNumber: string;
  totalPaise: number;
  status: string;
}

/** Empties `ctx`'s cart, adds `quantity` of a listing and pays from the wallet. */
export async function walletOrder(ctx: APIRequestContext, shopProductId: string, shopId: string, addressId: string | null, quantity = 1): Promise<SimpleOrder> {
  assertWritable("place an order");
  expectStatus(await call(ctx, "DELETE", "/api/cart"), [200, 204], "empty the cart");
  const added = await call(ctx, "POST", "/api/cart", { shopProductId, quantity });
  expectStatus(added, [200, 201], "add to cart");
  const res = await call(ctx, "POST", "/api/checkout", {
    requestId: `qa-auth-${RUN}-${randomUUID().slice(0, 8)}`,
    addressId,
    paymentMethod: "WALLET",
    acknowledgeClosedShopIds: [shopId],
  });
  if (res.status === 409 || res.status === 422) blocked(`checkout refused — ${why(res)}`);
  expectStatus(res, 201, "checkout");
  const order = res.body.orders[0];
  return { id: order.id, orderNumber: order.orderNumber, totalPaise: order.totalPaise, status: order.status };
}

/**
 * The customer's delivery code: the one mailed when the rider started (read
 * from the local mail catcher, as the customer reads their email), else a
 * new one asked for from the order page (waiting out its resend cooldown).
 */
export async function deliveryCodeFor(customer: APIRequestContext, orderId: string, mail?: { email: string; orderNumber: string; since: number }): Promise<string> {
  if (mail && IS_LOCAL) {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      for (const m of messagesTo(mail.email, mail.since)) {
        const code = m.body.match(new RegExp(`(\\d{4,8}) is your delivery code for order ${mail.orderNumber}`))?.[1];
        if (code) return code;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  let otp = await call(customer, "POST", `/api/orders/${orderId}/delivery-code`, {});
  for (let i = 0; i < 2 && otp.status === 429; i++) {
    const seconds = Number(otp.body?.error?.message?.match(/(\d+)\s*seconds?/)?.[1] ?? 60);
    await new Promise((r) => setTimeout(r, Math.min(seconds, 120) * 1000 + 1500));
    otp = await call(customer, "POST", `/api/orders/${orderId}/delivery-code`, {});
  }
  expectStatus(otp, 200, "delivery code");
  return String(otp.body?.code ?? otp.body?.otp ?? otp.body?.deliveryCode);
}

/** Shop A packs the order and `rider` delivers it with the code `customer` reads. */
export async function deliverFor(
  orderId: string,
  customer: APIRequestContext,
  options: { rider?: Role; shop?: Role; afterAccept?: (deliveryOrderId: string) => Promise<void>; mail?: { email: string; orderNumber: string } } = {},
) {
  const rider = options.rider ?? "rider";
  await packOrder(orderId, options.shop ?? "shop");
  const offer = await offerFor(orderId, rider);
  if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept", {}, rider), 200, "rider accepts");
  if (options.afterAccept) await options.afterAccept(offer.deliveryOrderId);
  const code = await pickupCode(orderId, options.shop ?? "shop");
  expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}, rider), 200, "pickup");
  const since = Date.now();
  expectStatus(await riderAction(offer.deliveryOrderId, "start", {}, rider), 200, "start delivery");
  const otp = await deliveryCodeFor(customer, orderId, options.mail ? { ...options.mail, since } : undefined);
  expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }, rider), 200, "deliver");
  return offer.deliveryOrderId;
}

/** The world's society and its admin (blocks where the site has none). */
export function worldSociety() {
  const society = need(world().society, "a verified society in this site's test data");
  need(world().users.society, "a society admin account");
  return society;
}

/** Shop A's id (local world) — the shop whose listings the order helpers use. */
export function shopA() {
  return need(world().shops.A?.id, "shop A");
}

export { CURRENT_POLICY_VERSION };
export type { Answer };

/* ---------------------------------------------------------------- riders */

/** A world rider's delivery-partner row. Local only. */
export async function partnerOf(role: Role) {
  const userId = need(world().users[role]?.id, `${role} account`);
  const [row] = await db()<{ id: string; mobile: string; is_online: boolean }[]>`select id, mobile, is_online from delivery_partners where user_id = ${userId}`;
  if (!row) blocked(`${role} has no delivery-partner profile`);
  return row;
}

/**
 * Arranges a world rider as a person would: online at a spot near shop A
 * (rider 1 next to it, rider 2 about 3 km away) and, when asked, with a
 * mobile number of its own (the seeded riders all share one). Local only.
 */
export async function arrangeRider(role: Role, options: { online?: boolean; mobile?: string } = {}) {
  const partner = await partnerOf(role);
  const home = world().location ?? { pincode: "411038", lat: 18.5074, lng: 73.8077 };
  const lat = role === "rider2" ? home.lat + 0.027 : home.lat + 0.001;
  // Riders of earlier test worlds stay offline, so offers go to this world's riders only.
  const mine = [world().users.rider?.id, world().users.rider2?.id].filter((id): id is string => Boolean(id));
  await db()`update delivery_partners set is_online = false where is_online and not (user_id = any(${mine}::uuid[]))`;
  await db()`update delivery_partners set
    is_online = ${options.online ?? true},
    last_location_latitude = ${String(lat)}, last_location_longitude = ${String(home.lng + (role === "rider2" ? 0 : 0.001))}, last_location_at = now(),
    mobile = ${options.mobile ?? partner.mobile}
    where id = ${partner.id}`;
  return { ...partner, mobile: options.mobile ?? partner.mobile };
}

/* ---------------------------------------------------- hand-over between checks */

/**
 * stash()/unstash() for one `playwright test` invocation. lib/http's RUN is
 * re-drawn when Playwright restarts its worker after a failed check, so a key
 * built from RUN cannot be read by the checks after a failure — even when the
 * failure was a defect found at the end of a check whose data is fine. The
 * runner process (the workers' parent) stays the same for the whole
 * invocation; values older than three hours are ignored.
 */
const INVOCATION = String(process.ppid);

export function keep<T>(key: string, value: T): T {
  stash(`${key}@${INVOCATION}`, { at: Date.now(), value });
  return value;
}

export function kept<T>(key: string): T | undefined {
  const entry = unstash<{ at: number; value: T }>(`${key}@${INVOCATION}`);
  if (!entry || Date.now() - entry.at > 3 * 3_600_000) return undefined;
  return entry.value;
}

/**
 * Frees a rider still holding a job left over from an earlier failed check:
 * an offered or accepted order is cancelled by operations (and refunded); one
 * already on its way is delivered with the code the customer was mailed when
 * the rider started (read from the local mail catcher). The next dispatch
 * then starts from free riders.
 */
export async function releaseOffers(role: Role) {
  const res = await call(await as(role), "GET", "/api/delivery-partner/deliveries");
  const active = res.body?.active as { id: string; orderId: string; status: string } | null;
  if (!active) return;
  if (["OFFERED", "ACCEPTED", "ASSIGNED"].includes(active.status)) {
    await call(await as("ops"), "PATCH", `/api/orders/${active.orderId}/status`, { status: "CANCELLED", note: "QA: freeing the rider for the next check" });
    return;
  }
  if (!IS_LOCAL) return;
  const [order] = await db()<{ order_number: string; email: string }[]>`select o.order_number, u.email from orders o join users u on u.id = o.user_id where o.id = ${active.orderId}`;
  if (!order) return;
  await riderAction(active.id, "start", {}, role).catch(() => null);
  const code = messagesTo(order.email, 0)
    .map((m) => m.body.match(new RegExp(`(\\d{4,8}) is your delivery code for order ${order.order_number}`))?.[1])
    .find(Boolean);
  if (code) await riderAction(active.id, "deliver", { otp: code }, role);
}
