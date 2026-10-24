/**
 * Helpers for the access / admin / platform checks (QA package 2): pages and
 * APIs as each role sees them, route sweeps, fresh local accounts, the
 * business-rules screen, a real emailed-code sign-in, and reading audit rows.
 *
 * Everything that writes calls assertWritable(); everything that reads the
 * database is for the "local" tier only (db() refuses elsewhere).
 */
import { request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { encode } from "next-auth/jwt";

import { as } from "./actors";
import { db, verifySellerDocument } from "./db";
import { anonymous, call, expectStatus, RUN, type Answer, type Method } from "./http";
import { waitForCode } from "./mail";
import { apiRoutes, NO_SUCH_ID } from "./routes";
import { blocked, expect, need } from "./record";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";
import { world, type Role, type WorldUser } from "./world";

export { NO_SUCH_ID };

/** The world's accounts, including the owner of the pending shop ("pending", local worlds only). */
export type AnyRole = Role | "pending";

export function worldUser(role: AnyRole): WorldUser | undefined {
  return (world().users as Record<string, WorldUser | undefined>)[role];
}

/** The world's society id (local and sites that list one). */
export function societyId(): string | undefined {
  return world().society?.id;
}

/** The QA category of the local world (not in the World type). */
export function worldCategory(): { id: string; name: string } | undefined {
  return (world() as unknown as { category?: { id: string; name: string } }).category;
}

/* ------------------------------------------------------------ requests */

/** GET a page or API as `role` (or a guest) without following redirects. */
export async function getAs(role: Role | "guest", path: string): Promise<Answer> {
  if (role === "guest") {
    const guest = await anonymous();
    try {
      return await call(guest, "GET", path);
    } finally {
      await guest.dispose();
    }
  }
  return call(await as(role), "GET", path);
}

/** The path a redirect answer points at ("/" for the home page), or null when it is not a redirect. */
export function redirectPath(res: Answer): string | null {
  if (![301, 302, 303, 307, 308].includes(res.status) || !res.location) return null;
  return new URL(res.location, BASE_URL).pathname;
}

/** True when `path` answered a page the caller may not see: a redirect away from it, 401/403, or 404. */
export function refused(res: Answer, path: string): boolean {
  if ([401, 403, 404].includes(res.status)) return true;
  const to = redirectPath(res);
  return to !== null && to !== new URL(path, BASE_URL).pathname;
}

/** A short description of an answer for a result's detail. */
export function brief(res: Answer) {
  const to = redirectPath(res);
  return to ? `${res.status}→${to}` : String(res.status);
}

/** The error code / message of an answer, for assertions on refusals. */
export function errorCode(res: Answer): string {
  return String(res.body?.error?.code ?? "");
}

/* ------------------------------------------------------------ route sweeps */

export interface SweepTarget {
  path: string;
  method: Method;
  file: string;
}

/** API routes under `prefix` (e.g. "/api/admin", "/api/shops/[id]") with each exported method. */
export function routesUnder(prefix: string, options: { writesOnly?: boolean } = {}): SweepTarget[] {
  return apiRoutes()
    .filter((r) => r.path === prefix || r.path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
    .flatMap((r) => r.methods.filter((m) => !options.writesOnly || m !== "GET").map((m) => ({ path: r.path, method: m as Method, file: r.file })));
}

/** Fills a route's dynamic segments: `[id]` with `id` when given, every other one with an id that exists nowhere. */
export function fillRoute(path: string, id?: string) {
  let out = path;
  if (id) out = out.replace("[id]", id);
  return out.replace(/\[\.\.\.[^\]]+\]/g, "x").replace(/\[[^\]]+\]/g, NO_SUCH_ID);
}

/** Calls every target as `ctx` with an empty JSON body; groups the answers by status. */
export async function sweep(ctx: APIRequestContext, targets: SweepTarget[], id?: string) {
  const byStatus = new Map<number, string[]>();
  for (const t of targets) {
    const path = fillRoute(t.path, id);
    const res = await call(ctx, t.method, path, t.method === "GET" || t.method === "DELETE" ? undefined : {});
    const line = `${t.method} ${t.path} ${errorCode(res)}`.trim();
    byStatus.set(res.status, [...(byStatus.get(res.status) ?? []), line]);
  }
  return byStatus;
}

export function summarizeSweep(byStatus: Map<number, string[]>) {
  return [...byStatus.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, l]) => `${s}×${l.length}`)
    .join(", ");
}

/* ------------------------------------------------------------ pages */

/** Collects console errors and uncaught page errors while a page is used (third-party noise left out). */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/favicon|ERR_BLOCKED_BY_CLIENT|maps\.googleapis|gstatic|Failed to load resource: the server responded with a status of 40[134]/.test(text)) return;
    errors.push(`${page.url().replace(BASE_URL, "")}: ${text.slice(0, 200)}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url().replace(BASE_URL, "")}: pageerror ${e.message.slice(0, 200)}`));
  return errors;
}

/** Opens `path`, expects a non-error answer and no error page. */
export async function openPage(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(res, `no response for ${path}`).toBeTruthy();
  expect(res!.status(), `${path} answered ${res!.status()}`).toBeLessThan(400);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await expect(page.locator("body"), `${path} shows an error page`).not.toContainText(/Something went wrong|Application error|Internal Server Error/i);
  return res!;
}

/** Horizontal overflow of the current page in CSS pixels (0 when it fits). */
export async function sidewaysOverflow(page: Page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

/* ------------------------------------------------------------ local accounts */

const SECURE = BASE_URL.startsWith("https");
const COOKIE = SECURE ? "__Secure-authjs.session-token" : "authjs.session-token";

/** A session cookie for any local account, minted as Auth.js mints it (local tier only). */
export async function mintedState(userId: string, email: string) {
  if (!IS_LOCAL) throw new Error("minted sessions are for the local server only");
  const secret = process.env.AUTH_SECRET;
  if (!secret) blocked("AUTH_SECRET (the local server's) is not set");
  const value = await encode({ token: { sub: userId, email, name: "qa" }, secret, salt: COOKIE });
  const url = new URL(BASE_URL);
  return {
    cookies: [{ name: COOKIE, value, domain: url.hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" as const }],
    origins: [],
  };
}

/** An API context signed in as a local account that is not one of the world's roles. Dispose it when done. */
export async function apiFor(user: { id: string; email: string }): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: BASE_URL, storageState: await mintedState(user.id, user.email), timeout: 120_000 });
}

/** A browser context + page signed in as a local account (close the context when done). */
export async function browserFor(browser: Browser, user: { id: string; email: string }, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...options, baseURL: BASE_URL, storageState: await mintedState(user.id, user.email) });
  return { context, page: await context.newPage() };
}

let mobileSeq = 0;
/** A 10-digit Indian mobile number no seeded account uses. */
export function freshMobile() {
  mobileSeq += 1;
  return `7${String(Date.now() % 1e6).padStart(6, "0")}${String(mobileSeq % 1000).padStart(3, "0")}`;
}

/**
 * A new local CUSTOMER account, arranged in the database the way the seed
 * arranges its accounts (profile done, terms accepted, optionally a mobile,
 * a funded wallet and customer 1's address). For cases that suspend, change
 * roles of or otherwise use up an account.
 */
export async function freshCustomer(label: string, options: { walletPaise?: number; withAddress?: boolean; withMobile?: boolean; name?: string } = {}) {
  assertWritable("create a local account");
  const sql = db();
  const email = `qa-${label}-${RUN}-${randomUUID().slice(0, 6)}@test.local`;
  const mobile = options.withMobile === false ? null : freshMobile();
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, name, role, status, email_verified, profile_completed_at, phone, phone_e164, phone_verified_at)
    values (${email}, ${options.name ?? `QA ${label}`}, 'CUSTOMER', 'ACTIVE', now(), now(), ${mobile}, ${mobile ? `+91${mobile}` : null}, ${mobile ? new Date() : null})
    returning id`;
  const seed = need(worldUser("customer")?.id, "customer 1 of the local world (its consent and address are copied)");
  await sql`insert into user_consents (user_id, consent_type, version, granted)
    select ${user.id}, consent_type, version, true from user_consents where user_id = ${seed} and consent_type = 'TERMS_AND_PRIVACY' limit 1`;
  const balance = options.walletPaise ?? 0;
  await sql`insert into wallets (user_id, balance_paise) values (${user.id}, 0) on conflict do nothing`;
  if (balance > 0) {
    await sql`
      with w as (select id, balance_paise from wallets where user_id = ${user.id} for update)
      , upd as (update wallets set balance_paise = balance_paise + ${balance}, updated_at = now() where id = (select id from w) returning id)
      insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
      select w.id, ${user.id}, 'TOP_UP', ${balance}, w.balance_paise, w.balance_paise + ${balance}, ${`qa-topup-${RUN}-${user.id}`}, 'QA top-up'
      from w`;
  }
  if (options.withAddress) {
    const from = need(world().addresses?.customer, "customer 1's address in the local world");
    await sql`insert into addresses (user_id, line1, line2, area, city, state, pincode, latitude, longitude, address_type, recipient_name, is_default, location_verified, location_verified_at, location_source)
      select ${user.id}, line1, line2, area, city, state, pincode, latitude, longitude, address_type, recipient_name, true, location_verified, location_verified_at, location_source
      from addresses where id = ${from}`;
  }
  return { id: user.id, email, mobile };
}

/* ------------------------------------------------------------ audit rows */

export interface AuditRow {
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  entity_type: string;
  entity_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  created_at: Date;
}

/** Audit rows of an entity written since `since` (local only), oldest first. */
export async function auditRows(entityId: string, since: Date, action?: string): Promise<AuditRow[]> {
  const sql = db();
  return action
    ? sql<AuditRow[]>`select action, actor_id, actor_role, entity_type, entity_id, previous_value, new_value, created_at from audit_logs
        where entity_id = ${entityId} and created_at >= ${since} and action = ${action} order by created_at`
    : sql<AuditRow[]>`select action, actor_id, actor_role, entity_type, entity_id, previous_value, new_value, created_at from audit_logs
        where entity_id = ${entityId} and created_at >= ${since} order by created_at`;
}

/** The database clock (audit rows are stamped by it, not by this machine). */
export async function dbNow(): Promise<Date> {
  const [row] = await db()<{ now: Date }[]>`select now() as now`;
  return row.now;
}

/* ------------------------------------------------------------ business rules */

export interface RuleRow {
  key: string;
  description: string;
  defaults: Record<string, unknown>;
  value: Record<string, unknown>;
  overridden: boolean;
}

export async function listRules(): Promise<RuleRow[]> {
  const res = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(res, 200, "GET /api/admin/settings as admin");
  return res.body.rules as RuleRow[];
}

/**
 * Runs `body` and afterwards puts every rule group in `keys` back as it was:
 * an override is written back, a group that was at its default is reset.
 */
export async function withRulesRestored<T>(keys: string[], body: () => Promise<T>): Promise<T> {
  assertWritable("change business rules");
  const before = new Map((await listRules()).filter((r) => keys.includes(r.key)).map((r) => [r.key, r]));
  try {
    return await body();
  } finally {
    const admin = await as("admin");
    for (const key of keys) {
      const was = before.get(key);
      if (!was) continue;
      const res = was.overridden
        ? await call(admin, "PUT", "/api/admin/settings", { key, value: was.value })
        : await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(key)}`);
      if (res.status !== 200) console.warn(`[access-helpers] could not restore rule ${key}: HTTP ${res.status}`);
    }
  }
}

/* ------------------------------------------------------------ sign-in */

/** Ticks the consent box until React (once hydrated) enables Get code. */
async function agreeTo(page: Page) {
  const agree = page.getByRole("checkbox", { name: /I agree/i }).first();
  const getCode = page.getByRole("button", { name: "Get code" });
  for (let i = 0; i < 30 && !(await getCode.isEnabled()); i++) {
    await agree.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

/**
 * Signs `email` in through the sign-in page with the code the local mail
 * catcher received (one code request). Returns the page's URL after sign-in,
 * or the message the page showed when the sign-in was refused.
 */
export async function signInByEmail(page: Page, email: string, options: { codeWaitMs?: number } = {}): Promise<{ signedIn: boolean; url: string; message: string }> {
  if (!IS_LOCAL) blocked("signing in with an emailed code is automated on the local server only (the local mail catcher)");
  await page.goto("/signin", { waitUntil: "domcontentloaded" });
  const identifier = page.getByLabel("Mobile number or email");
  if (!(await identifier.count())) blocked("the sign-in code form is not shown (email sending is not configured on this server)");
  await identifier.fill(email);
  await agreeTo(page);
  const since = Date.now() - 1000;
  await page.getByRole("button", { name: "Get code" }).click();
  const codeField = page.getByLabel("One-time code");
  const appeared = await codeField.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!appeared) {
    const message = (await page.getByRole("alert").first().textContent().catch(() => "")) ?? "";
    return { signedIn: false, url: page.url(), message: message.trim() || "no code step" };
  }
  // A refused account may get no code at all: wait for one, but report its absence instead of blocking.
  const code = await waitForCode(email, since, options.codeWaitMs ?? 30_000).catch((error) => {
    if (options.codeWaitMs) return null;
    throw error;
  });
  if (!code) return { signedIn: false, url: page.url(), message: `no sign-in code was emailed within ${(options.codeWaitMs ?? 0) / 1000} s` };
  await codeField.fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 30_000 }).catch(() => {});
  const url = page.url();
  if (new URL(url).pathname.startsWith("/signin")) {
    const message = (await page.getByRole("alert").first().textContent().catch(() => "")) ?? "";
    return { signedIn: false, url, message: message.trim() };
  }
  return { signedIn: true, url, message: "" };
}

/** Who a browser context is signed in as (null when signed out). */
export async function sessionOf(page: Page): Promise<{ id: string; role: string; status?: string } | null> {
  const res = await page.request.get("/api/auth/session");
  const body = await res.json().catch(() => null);
  return body?.user?.id ? { id: String(body.user.id), role: String(body.user.role ?? ""), status: body.user.status } : null;
}

/** Opens the header's account menu (home page: account-dropdown; other pages: account-button) and returns the role switcher in it. */
export async function roleSwitcher(page: Page) {
  const button = page.locator("[data-testid=account-dropdown]:visible, [data-testid=account-button]:visible").first();
  await button.click();
  return page.locator("[data-testid=role-switcher]:visible").first();
}

/** Grants `role` to a local account and makes it the active role (as an admin grant would). */
export async function grantLocalRole(userId: string, role: string, activate = true) {
  assertWritable("grant a role");
  const sql = db();
  await sql`insert into user_role_grants (user_id, role, source, status) values (${userId}, ${role}, 'ADMIN', 'ACTIVE')
    on conflict (user_id, role) do update set status = 'ACTIVE', revoked_at = null, revoked_by = null`;
  if (activate) await sql`update users set role = ${role}, updated_at = now() where id = ${userId}`;
}

/** A new local shop owner (a fresh account holding SHOP_OWNER). */
export async function freshOwner(label: string) {
  const user = await freshCustomer(label, { name: `QA Owner ${label}` });
  await grantLocalRole(user.id, "SHOP_OWNER");
  return user;
}

/**
 * A throwaway copy of a world shop for a case that uses one up (reject,
 * suspend, approve): every column copied, with a new id, slug, name, owner
 * and status. Returns its id and name.
 */
export async function cloneShop(sourceId: string, options: { ownerId: string; status: "PENDING_APPROVAL" | "APPROVED"; label: string }) {
  assertWritable("create a local shop");
  const sql = db();
  const suffix = `${RUN}-${randomUUID().slice(0, 6)}`;
  const name = `QA ${options.label} ${suffix}`;
  const overrides = {
    id: randomUUID(),
    slug: `qa-${options.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`,
    name,
    owner_id: options.ownerId,
    status: options.status,
    registration_number: `QA-${suffix}`,
    rejection_reason: null,
    shop_act_key: null,
  };
  const [row] = await sql<{ id: string; name: string }[]>`
    insert into shops select * from jsonb_populate_record(null::shops,
      (select to_jsonb(s) || ${sql.json(overrides)}::jsonb from shops s where s.id = ${sourceId}))
    returning id, name`;
  return row;
}

/** What an approval needs in the database: the seller documents verified and the registration fee settled (waived). */
export async function readyForApproval(shopId: string) {
  assertWritable("arrange a shop for approval");
  const sql = db();
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT", "FSSAI"]) {
    // A number on file (encrypted value present) and a future expiry: what a reviewed licence leaves behind.
    await verifySellerDocument(shopId, docType, {
      number_encrypted: "qa-seeded",
      number_masked: "XXXX",
      number_hash: `qa-${shopId}-${docType}`,
      consent_given_at: new Date(),
      valid_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    });
  }
  await sql`update shops set fee_payment_status = 'PAID', registration_fee_paise = 0 where id = ${shopId}`;
}

/** Adds `paise` to a local account's wallet (creating it if missing) with a matching ledger row, as a settled top-up leaves it. */
export async function fundWallet(userId: string, paise: number) {
  assertWritable("fund a wallet");
  const sql = db();
  await sql`insert into wallets (user_id, balance_paise) values (${userId}, 0) on conflict do nothing`;
  await sql`
    with w as (select id, balance_paise from wallets where user_id = ${userId} for update)
    , upd as (update wallets set balance_paise = balance_paise + ${paise}, updated_at = now() where id = (select id from w) returning id)
    insert into wallet_transactions (wallet_id, user_id, type, amount_paise, previous_balance_paise, new_balance_paise, idempotency_key, description)
    select w.id, ${userId}, 'TOP_UP', ${paise}, w.balance_paise, w.balance_paise + ${paise}, ${`qa-fund-${RUN}-${randomUUID().slice(0, 8)}`}, 'QA top-up'
    from w`;
}

/**
 * "Find rider now" as an operator, retried until the manual cooldown after
 * the last attempt (rule dispatch.manualCooldownSeconds) lets it through.
 */
export async function findRiderNow(orderId: string, timeoutMs = 75_000): Promise<Answer> {
  assertWritable("ask for a rider");
  const until = Date.now() + timeoutMs;
  let res = await call(await as("ops"), "POST", `/api/orders/${orderId}/assign`, {});
  // 409 "already has an active delivery assignment": a rider was offered it meanwhile (e.g. right after a decline).
  while (res.status !== 200 && !(res.status === 409 && /active delivery assignment/i.test(res.text)) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    res = await call(await as("ops"), "POST", `/api/orders/${orderId}/assign`, {});
  }
  return res;
}
