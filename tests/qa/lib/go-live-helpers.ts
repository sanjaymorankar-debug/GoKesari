/**
 * Helpers for the "go live" checks of the identity-first shop registration
 * (owner brief 08-Nov-2026, docs/shop-onboarding-identity-first-2026-11):
 * the wizard driven through its own routes (/api/shops/registration-draft/*),
 * the registration fee paid on the sandbox gateway's page, the approval log,
 * the scheduled registration reminders and the documents follow-up run.
 *
 * Local tier only, except the small read helpers: every registration is made
 * by a fresh local account (sellers-helpers freshAccount), its GSTIN or PAN is
 * verified by the local mock KYC provider (KYC_PROVIDER unset = mock: any
 * number whose PAN digits are not 0000 / 5555 / 7777 / 8888 / 9999 is
 * "active"), and the fee is paid on /orders/pay/sandbox/… (PAYMENT_GATEWAY
 * unset = SANDBOX). Nothing here ever runs against a real government record or
 * a real payment.
 */
import { request as playwrightRequest, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { me } from "./actors";
import { db } from "./db";
import { call, expectStatus, RUN, why } from "./http";
import { istDate, mailsTo, type Mail } from "./money-helpers";
import { blocked, expect, need } from "./record";
import { ctxFor, freshAccount, gstinFor, needPanStorage, notificationsOf, pageFor, shopRow, uniqueMobile, uniquePan, withRule, type Account } from "./sellers-helpers";
import { assertWritable, BASE_URL, IS_LOCAL } from "./target";
import { world } from "./world";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- the wizard */

/** What the wizard's routes answer (services/shop-registration-wizard.ts WizardView), the fields the checks read. */
export interface WizardView {
  id: string;
  status: "OPEN" | "SUBMITTED" | "COMPLETED" | "ABANDONED";
  route: "GSTIN" | "PAN_ONLY" | null;
  nextStep: string;
  canContinue: boolean;
  foodShop: boolean;
  licenceGraceDays: number;
  ownerName: string | null;
  referral: { answered: boolean; code: string | null; required: boolean; locked: boolean };
  gstin: { numberMasked: string | null; status: string; message: string | null } | null;
  pan: { numberMasked: string | null; status: string; message: string | null } | null;
  shop: { id: string; name: string; registrationNumber: string | null; status: string; feeDuePaise: number; lastPaymentFailed: boolean } | null;
  documents: { missing: string[]; canSubmit: boolean; needsTeamApproval: boolean };
  setup: { location: boolean; categories: boolean; products: boolean } | null;
}

export interface Place {
  pincode: string;
  lat: number;
  lng: number;
  line: string;
  area: string;
}

/** Shop A's PIN and pin (customer 1 lives there), else Kothrud. */
export function homePlace(): Place {
  const loc = world().location;
  return {
    pincode: loc?.pincode ?? "411038",
    lat: loc?.lat ?? 18.5074,
    lng: loc?.lng ?? 73.8077,
    line: `${RUN.toUpperCase()} QA Go-live Lane, Paud Road`,
    area: "Kothrud",
  };
}

/** A place in another PIN, ~4 km from homePlace (Shivajinagar). */
export function otherPlace(): Place {
  return { pincode: "411005", lat: 18.5308, lng: 73.8475, line: `${RUN.toUpperCase()} QA Station Road`, area: "Shivajinagar" };
}

/** The mock KYC provider's scenario digits (adapters/mock.ts): these PANs do not come back "active". */
const MOCK_SCENARIOS = new Set(["0000", "5555", "7777", "8888", "9999"]);

/** A PAN of an individual (4th letter P, so the record names the owner) the mock provider verifies. */
export function wizardPan(): string {
  for (;;) {
    const pan = uniquePan();
    if (pan[3] === "P" && !MOCK_SCENARIOS.has(pan.slice(5, 9))) return pan;
  }
}

/** The local admin's user id (referral codes need a creator). */
async function adminId(): Promise<string> {
  return world().users.admin?.id ?? (await me("admin")).id;
}

let plainCode: string | null = null;

/**
 * A referral code for this run (local database): the shop referral code is MANDATORY by migration
 * 0100 (referral_required_shop), so every registration sends one. A plain code with no dealer.
 */
export async function referralCode(): Promise<string> {
  if (plainCode) return plainCode;
  assertWritable("create a referral code");
  const code = `QAGL${RUN.toUpperCase()}`.slice(0, 32);
  await db()`insert into referral_codes (code, label, status, created_by) values (${code}, ${"QA go-live checks"}, 'ACTIVE', ${await adminId()}) on conflict (code) do nothing`;
  plainCode = code;
  return code;
}

let dealerSeq = 0;

/**
 * A dealer (not internal, APPROVED, with its own GoKesari account) and an active dealer code,
 * arranged in the local database as an admin's dealer approval leaves them.
 */
export async function dealerWithCode(label: string): Promise<{ user: Account; code: string; dealerId: string }> {
  const user = await freshAccount(`${label}-dealer`);
  dealerSeq += 1;
  const code = `QADL${RUN.toUpperCase()}${dealerSeq}`.slice(0, 32);
  try {
    const sql = db();
    const [rc] = await sql<{ id: string }[]>`insert into referral_codes (code, label, status, created_by) values (${code}, ${"QA dealer code"}, 'ACTIVE', ${await adminId()}) returning id`;
    const [dealer] = await sql<{ id: string }[]>`
      insert into dealers (user_id, legal_name, contact_name, dealer_type, status)
      values (${user.id}, ${`QA Dealer ${label} ${RUN}`}, ${"QA Dealer"}, 'PROPRIETORSHIP', 'APPROVED') returning id`;
    await sql`insert into dealer_codes (referral_code_id, dealer_id, kind, status) values (${rc.id}, ${dealer.id}, 'DEALER', 'ACTIVE')`;
    return { user, code, dealerId: dealer.id };
  } catch (error) {
    blocked(`could not arrange a dealer and its code in the local database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** POSTs one wizard step; expects 200 and returns the whole wizard. */
export async function wizardStep(ctx: APIRequestContext, path: string, body: unknown, what: string): Promise<WizardView> {
  const res = await call(ctx, "POST", `/api/shops/registration-draft/${path}`, body);
  expectStatus(res, 200, what);
  return res.body as WizardView;
}

/** The owner's wizard as the page reads it (null: nothing started). */
export async function wizardOf(ctx: APIRequestContext): Promise<WizardView | null> {
  const res = await call(ctx, "GET", "/api/shops/registration-draft");
  expectStatus(res, 200, "GET the registration wizard");
  return (res.body as WizardView | null) ?? null;
}

export interface Draft {
  owner: Account;
  ctx: APIRequestContext;
  pan: string;
  gstin: string | null;
  code: string | null;
  view: WizardView;
}

/**
 * A fresh account on "Verify your business": the referral code, then the GSTIN (its PAN is checked
 * in the background) — or, with `route: "PAN"`, the PAN with the "not GST-registered" declaration.
 * Stops where the owner is asked to confirm the address (nextStep ADDRESS).
 */
export async function startDraft(label: string, opts: { route?: "GSTIN" | "PAN"; pan?: string; gstin?: string; code?: string | null; owner?: Account } = {}): Promise<Draft> {
  const owner = opts.owner ?? (await freshAccount(label));
  const ctx = await ctxFor(owner);
  await needPanStorage(ctx);
  const code = opts.code === undefined ? await referralCode() : opts.code;
  const pan = opts.pan ?? (opts.gstin ? opts.gstin.slice(2, 12) : wizardPan());
  await wizardStep(ctx, "referral", { referralCode: code }, "the referral code");
  let view: WizardView;
  let gstin: string | null = null;
  if (opts.route === "PAN") {
    view = await wizardStep(ctx, "pan", { pan, declaration: true, consent: true }, "verify the PAN");
  } else {
    gstin = opts.gstin ?? gstinFor(pan);
    view = await wizardStep(ctx, "gstin", { gstin, consent: true }, "verify the GSTIN");
  }
  expect(view.nextStep, `after verification (GSTIN ${JSON.stringify(view.gstin)}, PAN ${JSON.stringify(view.pan)})`).toBe("ADDRESS");
  return { owner, ctx, pan, gstin, code, view };
}

/** Confirms the address and pins the shop: the wizard then asks for the shop's name and type (nextStep SHOP). */
export async function addressAndPin(d: Draft, place: Place = homePlace()): Promise<WizardView> {
  let view = await wizardStep(
    d.ctx,
    "address",
    { addressLine1: place.line, addressLine2: null, area: place.area, city: "Pune", state: "Maharashtra", pincode: place.pincode, landmark: null },
    "confirm the address",
  );
  expect(view.nextStep, "after the address").toBe("PIN");
  view = await wizardStep(d.ctx, "location", { latitude: place.lat, longitude: place.lng }, "pin the shop on the map");
  expect(view.nextStep, "after the map pin").toBe("SHOP");
  d.view = view;
  return view;
}

export interface ShopInput {
  name: string;
  phone?: string;
  shopType?: string;
  /** Rupees; 15 lakh is the first turnover slab (₹999 + GST by default). */
  turnover?: number;
}

/** "Contact and shop details": saved; the wizard is on "Payment" (nextStep REVIEW). */
export async function shopDetails(d: Draft, shop: ShopInput): Promise<WizardView> {
  const view = await wizardStep(
    d.ctx,
    "details",
    {
      name: shop.name,
      ownerName: null,
      phone: shop.phone ?? uniqueMobile(),
      email: null,
      shopType: shop.shopType ?? "GENERAL_TRADING",
      categoryIds: [],
      annualTurnoverRupees: shop.turnover ?? 15_00_000,
      couponCode: null,
      referralCode: null,
      employeeId: null,
    },
    "the shop details",
  );
  expect(view.nextStep, "after the shop details").toBe("REVIEW");
  d.view = view;
  return view;
}

/** "Create my shop and pay": the shop is created, PENDING_APPROVAL, with its fee due. */
export async function createShop(d: Draft, opts: { fssai?: string } = {}): Promise<{ shopId: string; shopName: string; feeDuePaise: number; view: WizardView }> {
  // DF-08 (owner, 21-Nov-2026): a food shop gives its FSSAI licence before payment.
  if (opts.fssai) await wizardStep(d.ctx, "documents", { docType: "FSSAI", number: opts.fssai, consent: true }, "the FSSAI number");
  let view = await wizardStep(d.ctx, "submit", undefined, "create the shop");
  const shop = need(view.shop, "the shop the wizard created");
  // The documents screen (DF-07 / DF-08): the owner promises what is not uploaded (the Shop Act, a licence).
  if (view.nextStep === "DOCUMENTS") view = await wizardStep(d.ctx, "documents-step", { promise: true }, "promise the remaining documents");
  expect(view.nextStep, "a fee is due: the payment step").toBe("PAYMENT");
  d.view = view;
  return { shopId: shop.id, shopName: shop.name, feeDuePaise: shop.feeDuePaise, view };
}

let nameSeq = 0;

/** A shop name unique to this run (title case: names are shown as the owner typed them). */
export function shopName(label: string): string {
  nameSeq += 1;
  return `Qa ${label} ${RUN.toUpperCase()} ${nameSeq}`;
}

export interface UnpaidShop extends Draft {
  shopId: string;
  shopName: string;
  feeDuePaise: number;
  place: Place;
}

/** A wizard shop created and not paid yet (a fresh owner, or `opts.owner`). */
export async function unpaidShop(label: string, opts: { route?: "GSTIN" | "PAN"; pan?: string; gstin?: string; code?: string | null; owner?: Account; shop?: Partial<ShopInput>; place?: Place; fssai?: string } = {}): Promise<UnpaidShop> {
  const d = await startDraft(label, opts);
  const place = opts.place ?? homePlace();
  await addressAndPin(d, place);
  await shopDetails(d, { name: opts.shop?.name ?? shopName(label), ...opts.shop });
  const created = await createShop(d, { fssai: opts.fssai });
  expect(created.feeDuePaise, "a registration fee is due (rule registrationFeeByTurnover)").toBeGreaterThan(0);
  return { ...d, ...created, place };
}

/* --------------------------------------------------------- the fee payment */

/** The sandbox page path of a redirect, or blocks when this server's gateway is not the sandbox. */
export function sandboxPathOf(url: string): string {
  const path = url.startsWith("http") ? `${new URL(url).pathname}${new URL(url).search}` : url;
  if (!/^\/orders\/pay\/sandbox\//.test(path)) blocked(`the registration fee opens ${url || "no page"}, not the sandbox gateway (PAYMENT_GATEWAY is not SANDBOX on this server)`);
  return path;
}

/** On the sandbox page: presses "Pay (success)" or "Fail" and waits to be sent back. */
export async function answerSandbox(page: Page, outcome: "pay" | "fail") {
  const box = page.getByTestId("sandbox-checkout");
  await expect(box).toBeVisible();
  await box.getByTestId(outcome === "pay" ? "sandbox-pay" : "sandbox-fail").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/orders/pay/sandbox"), { timeout: 45_000 });
}

/** Starts the fee checkout (POST /api/shops/{id}/registration-fee) and answers the sandbox page in a browser as the owner. */
export async function payFee(browser: Browser, owner: Account, shopId: string, outcome: "pay" | "fail"): Promise<{ intentId: string; landedOn: string }> {
  assertWritable("pay a registration fee");
  const res = await call(await ctxFor(owner), "POST", `/api/shops/${shopId}/registration-fee`);
  expectStatus(res, 201, "start the registration-fee payment");
  const path = sandboxPathOf(String(res.body.redirectUrl ?? ""));
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto(path);
    await answerSandbox(page, outcome);
    return { intentId: String(res.body.intentId), landedOn: new URL(page.url()).pathname + new URL(page.url()).search };
  } finally {
    await context.close();
  }
}

/** The shop's latest instant-approval decision (shop_auto_approval_log). */
export async function approvalLog(shopId: string) {
  const [row] = await db()<{ outcome: string; reasons: string[]; evidence: Record<string, unknown> }[]>`
    select outcome, reasons, evidence from shop_auto_approval_log where shop_id = ${shopId} order by created_at desc limit 1`;
  return row ?? null;
}

/** Waits for the shop's status to settle after a payment (the approval runs just after the capture commits). */
export async function settledStatus(shopId: string, want: string, timeoutMs = 45_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  let status = (await shopRow(shopId)).status;
  while (status !== want && Date.now() < until) {
    await sleep(1_000);
    status = (await shopRow(shopId)).status;
  }
  return status;
}

/** Expects the shop APPROVED after its payment; the failure names the approval log's reasons. */
export async function expectLive(shopId: string) {
  const status = await settledStatus(shopId, "APPROVED");
  if (status !== "APPROVED") {
    const log = await approvalLog(shopId);
    expect(status, `the shop goes live as soon as the fee is paid — still ${status}; approval log: ${log ? `${log.outcome}: ${log.reasons.join("; ")}` : "none"}`).toBe("APPROVED");
  }
}

/** A wizard shop registered and paid in the sandbox: live (APPROVED). */
export async function liveShop(browser: Browser, label: string, opts: Parameters<typeof unpaidShop>[1] = {}): Promise<UnpaidShop> {
  const shop = await unpaidShop(label, opts);
  await payFee(browser, shop.owner, shop.shopId, "pay");
  await expectLive(shop.shopId);
  return shop;
}

/* ------------------------------------------------------------- the browser */

/**
 * Drives the wizard on /shop/register from "Verify your business" to "Create my shop and pay"; the
 * payment then opens by itself (the sandbox page). Returns on the sandbox page.
 */
export async function registerInWizard(page: Page, input: { code: string | null; gstin: string; name: string; phone: string; shopType: string; place: Place }) {
  await page.goto("/shop/register");
  await expect(page.getByRole("heading", { name: "Verify your business" })).toBeVisible();
  if (input.code) await page.getByTestId("wizard-referral-code").fill(input.code);
  await page.getByTestId("gstin-input").fill(input.gstin);
  await page.getByLabel("I agree that GoKesari checks this number with the government record.").check();
  await page.getByTestId("verify-identity").click();

  await expect(page.getByRole("heading", { name: "Confirm your shop address" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("address-line1").fill(input.place.line);
  await page.getByTestId("address-city").fill("Pune");
  await page.getByTestId("address-pincode").fill(input.place.pincode);
  await page.getByTestId("address-continue").click();

  await expect(page.getByRole("heading", { name: "Mark your shop location on the map" })).toBeVisible({ timeout: 30_000 });
  await page.getByText("Map not loading? Enter the coordinates").click();
  await page.getByTestId("pin-latitude").fill(String(input.place.lat));
  await page.getByTestId("pin-longitude").fill(String(input.place.lng));
  await page.getByTestId("pin-save").click();

  await expect(page.getByRole("heading", { name: "Contact and shop details" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("shop-name").fill(input.name);
  await page.getByTestId("shop-phone").fill(input.phone);
  await page.getByTestId("shop-type").selectOption(input.shopType);
  const slabs = page.getByTestId("turnover-slabs").getByRole("radio");
  if ((await slabs.count()) > 0) await slabs.first().click();
  await page.getByTestId("shop-continue").click();

  await expect(page.getByRole("heading", { name: "Payment", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("create-and-pay").click();
  await page.waitForURL((u) => u.pathname.startsWith("/orders/pay/sandbox") || !u.pathname.startsWith("/shop/register"), { timeout: 45_000 });
  sandboxPathOf(page.url());
}

/** Back on /shop/register after a payment: reloads until the live screen shows (the approval runs just after the capture). */
export async function waitForLiveScreen(page: Page, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (!new URL(page.url()).pathname.startsWith("/shop/register")) await page.goto("/shop/register");
    if (await page.getByTestId("onboarding-complete").isVisible().catch(() => false)) return;
    if (Date.now() > until) break;
    await sleep(2_000);
    await page.goto("/shop/register");
  }
  await expect(page.getByTestId("onboarding-complete"), "the live screen after payment").toBeVisible();
}

/* ------------------------------------------------------ cron, mail, notices */

/** POSTs a cron entry point with the local CRON_SECRET (5 minutes allowed: /api/cron/daily runs every daily job). */
export async function cron(path: "/api/cron/daily" | "/api/cron/every-minute"): Promise<Record<string, unknown>> {
  if (!IS_LOCAL) blocked("running a cron job needs the local server's CRON_SECRET (local runs only)");
  assertWritable(`run ${path}`);
  const secret = need(process.env.CRON_SECRET, "CRON_SECRET of the local server");
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    let last = "";
    for (let i = 0; i < 8; i++) {
      const res = await ctx.fetch(new URL(path, BASE_URL).toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        failOnStatusCode: false,
        timeout: 300_000,
      });
      const text = await res.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = null;
      }
      last = `HTTP ${res.status()}: ${text.slice(0, 200)}`;
      // The cron limit per minute, or a run of the same entry point still going: wait and go again.
      if (res.status() === 429 || body?.skipped === true) {
        await sleep(15_000);
        continue;
      }
      expect(res.status(), `${path} — ${last}`).toBe(200);
      return body ?? {};
    }
    blocked(`${path} kept answering 429 / ALREADY_RUNNING (${last})`);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Runs `body` with the documents follow-up acting today (rule shopDocumentFollowUp.reminderDaysOfMonth =
 * today's IST day, the 1st and 15th otherwise) and `patch` applied; the rule is restored after.
 */
export async function withFollowUpToday<T>(patch: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const day = Number(istDate(0).slice(8, 10));
  if (day > 28) blocked(`today is day ${day} of the month (IST); rule shopDocumentFollowUp.reminderDaysOfMonth takes days 1–28 only, so the follow-up cannot be made to act today`);
  return withRule("shopDocumentFollowUp", { enabled: true, reminderDaysOfMonth: [day], ...patch }, body);
}

/** The daily run (05.00 IST job); returns the documents follow-up's own result. */
export async function runFollowUp(): Promise<{ acting: boolean; checked: number; reminded: number; suspended: number; cleared: number; waiting: number; failed: number }> {
  const body = await cron("/api/cron/daily");
  const results = (body.results ?? {}) as Record<string, unknown>;
  const result = results["shop-document-follow-up"] as { acting: boolean; checked: number; reminded: number; suspended: number; cleared: number; waiting: number; failed: number } | null | undefined;
  expect(result?.acting, `the documents follow-up acted today — ${JSON.stringify(result ?? body.errors ?? body).slice(0, 300)}`).toBe(true);
  return result!;
}

/** In-app notifications of one type a user got since `since`, waited for up to `timeoutMs`. */
export async function noticesOf(userId: string, type: string, since: Date, timeoutMs = 0) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await notificationsOf(userId, since)).filter((n) => n.type === type);
    if (rows.length > 0 || Date.now() >= until) return rows;
    await sleep(1_000);
  }
}

const MAIL_DIR = process.env.QA_MAIL_DIR ?? join("test-results", "qa", "mail");

/** The newest mail to `to` since `since` whose subject matches, waited for (local mail catcher). Blocks when the catcher is not running. */
export async function mailMatching(to: string, since: number, subject: RegExp, timeoutMs = 20_000): Promise<Mail | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = mailsTo(to, since).find((m) => subject.test(m.subject));
    if (hit) return hit;
    if (Date.now() >= until) break;
    await sleep(1_000);
  }
  if (!existsSync(MAIL_DIR)) blocked(`no mail catcher output at ${MAIL_DIR} (is scripts/qa/smtp-sink.mjs running and AUTH_EMAIL_SERVER set?)`);
  return null;
}

/** The registration reminder row of a draft (scheduled_notices, key registration-idle:<draft>). */
export async function reminderOf(draftId: string) {
  const [row] = await db()<{ stage: number; due_at: Date; sent_at: Date | null; cancelled_at: Date | null; payload: Record<string, string> }[]>`
    select stage, due_at, sent_at, cancelled_at, payload from scheduled_notices where key = ${`registration-idle:${draftId}`}`;
  return row ?? null;
}

/** Brings a draft's pending reminder due now (the time the owner would have waited). */
export async function reminderDueNow(draftId: string) {
  await db()`update scheduled_notices set due_at = now() - interval '1 minute' where key = ${`registration-idle:${draftId}`} and sent_at is null and cancelled_at is null`;
}

/** The fee in the words the screens use (formatPaiseCompact: whole rupees without paise). */
export function rupees(paise: number): string {
  return paise % 100 === 0
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100)
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100);
}

/** "18 Feb 2027" for an ISO date (lib/dates formatDisplayDate). */
export function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The licence notice of the shop-type screen and the e-mail (lib/shop-licences.ts). */
export function licenceNotice(licence: string, graceDays: number): string {
  // DF-08 (owner, 21-Nov-2026): FSSAI is uploaded before payment; other licences may follow go-live.
  if (licence === "FSSAI licence") {
    return `${licence} is mandatory for this type of shop. You will upload it before paying the registration fee; your shop goes live once it is on file.`;
  }
  return `${licence} is mandatory for this type of shop. Your shop can go live now, and you have a grace period of ${graceDays} days to upload it. Otherwise, your shop will be suspended.`;
}

/** A shop's public slug (local database). */
export async function slugOf(shopId: string): Promise<string> {
  const [row] = await db()<{ slug: string }[]>`select slug from shops where id = ${shopId}`;
  return need(row?.slug, `the slug of shop ${shopId}`);
}

export { why };

/** Notification e-mails carry the in-app title plus the brand (src/server/notifications/templates.ts: `${title} — Gokesari`). */
export const MAIL_SUFFIX = " — Gokesari";
