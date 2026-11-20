/**
 * Helpers for the identity-first shop registration wizard (/shop/register,
 * owner brief 08-Nov-2026, docs/shop-onboarding-identity-first-2026-11):
 * TC-ONB-048 … TC-ONB-069.
 *
 * - numbers for the local mock KYC vendor (src/server/kyc/adapters/mock.ts), which picks its
 *   answer by the four digits of the PAN (also the PAN inside a GSTIN):
 *     …0000 not found   …9999 vendor timeout (PENDING)   …8888 GSTIN cancelled / PAN inactive
 *     …7777 other name  …5555 "can't check" (MANUAL_REVIEW)   anything else: active
 *   The 4th letter of the PAN decides whether the record names an owner (P: a person) or not (C).
 * - admin settings changed for one check and always restored (referral setting, feature flag);
 * - a referral code arranged in the local database;
 * - the wizard driven through its own API up to the step a check is about (fast-forward);
 * - signed-tier guards that keep every wizard write off the site (nothing reaches the
 *   government check, no draft is created) and the identity screen opened for a look;
 * - generated document photos for the on-device reader (TC-ONB-055).
 *
 * Nothing here runs on production: the signed checks only look, and every writer is local.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import sharp from "sharp";

import { as, me, ownsNoShop } from "./actors";
import { db } from "./db";
import { call, expectStatus, RUN } from "./http";
import { blocked, expect } from "./record";
import { gstinFor, keep, uniqueMobile } from "./sellers-helpers";
import { assertWritable, IS_LOCAL } from "./target";
import { world } from "./world";

/* ------------------------------------------------------------- numbers */

/** Letters a PAN may carry, without I and O (no 1/0 look-alikes in a photo). */
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
let seq = 0;

/**
 * A PAN unique to this run whose scenario digits the mock vendor answers by: "4321" is an active
 * record; "0000", "9999", "8888", "7777" and "5555" are the mock's outcomes (see above).
 * holder P: a person (the record names the owner); C: a company (it does not).
 */
export function scenarioPan(holder: "P" | "C" = "P", digits = "4321"): string {
  seq += 1;
  const n = (parseInt(RUN, 36) % 9_000_000) * 131 + seq * 7_919 + Math.floor(Math.random() * 4_000);
  const pick = (k: number) => LETTERS[Math.abs(Math.floor(k)) % LETTERS.length];
  return `${pick(n)}${pick(n / 24)}${pick(n / 576)}${holder}${pick(n / 13_824)}${digits}${pick(n / 7)}`;
}

/** A checksum-valid GSTIN (state 27) around a scenario PAN. */
export function scenarioGstin(holder: "P" | "C" = "P", digits = "4321"): { gstin: string; pan: string } {
  const pan = scenarioPan(holder, digits);
  return { gstin: gstinFor(pan), pan };
}

/* ------------------------------------------------------- the wizard's words */

export const IDENTITY = {
  heading: "Verify your business",
  gstLabel: "GST number (15 characters)",
  panLabel: "PAN (10 characters)",
  derivedPanLabel: "PAN (taken from your GST number)",
  consent: "I agree that GoKesari checks this number with the government record.",
  declaration: "My shop is not registered under GST.",
  gstFormat: "Enter the 15-character GSTIN as on your GST certificate, for example 27ABCDE1234F1Z5.",
  panFormat: "Enter the 10-character PAN, for example ABCDE1234F.",
  usePan: "I don't have GST, use PAN",
  useGst: "I have a GST number",
} as const;

/** src/server/services/shop-registration-draft.ts — what the owner is told on the identity screen. */
export const OUTCOME = {
  pending: "The government service is not answering right now. Please try again in a few minutes.",
  notFound: "This number was not found in the government record. Please check it and try again.",
  cancelled: "The government record shows this GSTIN as cancelled.",
  inactive: "The government record shows this number as inactive.",
  tooMany: "Too many checks in the last hour. Please try again later.",
  outsideIndia: "Please place the pin on your shop in India.",
} as const;

/* ------------------------------------------------------------ settings */

/** Admin › Referral settings, shop registration: runs `body` with it set to `value`, then restores it (local only). */
export async function withShopReferralSetting<T>(value: "MANDATORY" | "OPTIONAL", body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked("changes Admin › Referral settings (local run only)");
  const admin = await as("admin");
  const read = await call(admin, "GET", "/api/admin/referral-settings");
  expectStatus(read, 200, "GET /api/admin/referral-settings");
  const before = ((read.body?.settings ?? []) as { key: string; value: string }[]).find((s) => s.key === "referral_required_shop")?.value ?? "OPTIONAL";
  if (before !== value) expectStatus(await call(admin, "PUT", "/api/admin/referral-settings", { key: "referral_required_shop", value }), 200, `set referral_required_shop ${value}`);
  try {
    return await body();
  } finally {
    if (before !== value) expectStatus(await call(admin, "PUT", "/api/admin/referral-settings", { key: "referral_required_shop", value: before }), 200, "restore referral_required_shop");
  }
}

/** Admin › Feature flags: runs `body` with `key` on or off everywhere, then restores it as it was (local only). */
export async function withFeatureFlag<T>(key: string, enabled: boolean, body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked(`switches the feature flag ${key} (local run only)`);
  const admin = await as("admin");
  const read = await call(admin, "GET", "/api/admin/feature-flags");
  expectStatus(read, 200, "GET /api/admin/feature-flags");
  const before = ((read.body?.flags ?? []) as { key: string; enabled: boolean; districtCodes: string[] | null }[]).find((f) => f.key === key);
  if (!before) blocked(`no feature flag ${key} on this server`);
  const put = (on: boolean, districtCodes: string[] | null, reason: string) => call(admin, "PUT", "/api/admin/feature-flags", { key, enabled: on, districtCodes, reason });
  expectStatus(await put(enabled, null, `QA ${RUN}: identity-first registration check`), 200, `set ${key}=${enabled}`);
  try {
    return await body();
  } finally {
    expectStatus(await put(before.enabled, before.districtCodes, `QA ${RUN}: restored after the check`), 200, `restore ${key}`);
  }
}

/* ------------------------------------------------------- referral codes */

let activeCode: string | null = null;

/**
 * A dealer-style referral code arranged in the local database, as an admin would issue it (ACTIVE,
 * no usage limit). `expiresAt` (YYYY-MM-DD) in the past makes an expired one.
 */
export async function localReferralCode(opts: { expiresAt?: string; prefix?: string } = {}): Promise<string> {
  if (!IS_LOCAL) blocked("arranges a referral code in the local database (local run only)");
  assertWritable("create a referral code");
  if (!opts.expiresAt && !opts.prefix && activeCode) return activeCode;
  seq += 1;
  const code = `${opts.prefix ?? "QAIDF"}${RUN.toUpperCase()}${seq}`.slice(0, 32);
  const admin = await me("admin");
  await db()`insert into referral_codes (code, label, status, expires_at, created_by)
             values (${code}, ${"QA identity-first"}, 'ACTIVE', ${opts.expiresAt ?? null}, ${admin.id})`;
  if (!opts.expiresAt && !opts.prefix) activeCode = code;
  return code;
}

/* ----------------------------------------------- the wizard through its API */

export type WizardStep = "IDENTITY" | "EMAIL" | "OWNER" | "ADDRESS" | "PIN" | "SHOP" | "REVIEW" | "PAYMENT" | "WAITING" | "LIVE";

/** GET /api/shops/registration-draft: the whole wizard (null before anything is saved). */
export async function wizardView(ctx: APIRequestContext) {
  const res = await call(ctx, "GET", "/api/shops/registration-draft");
  expectStatus(res, 200, "GET /api/shops/registration-draft");
  return res.body;
}

export interface FastForward {
  gstin: string;
  referralCode: string | null;
  ownerName?: string;
  addressLine1?: string;
  shopName?: string;
  turnoverRupees?: number;
}

/**
 * Takes a fresh owner's registration through the wizard's own routes up to `to` (local only): the
 * referral code, the GSTIN (mock vendor), the owner name when the record gives none, the address
 * (a unique line at PIN 411038), the map pin and the shop details. Returns the wizard at `to`.
 */
export async function fastForward(ctx: APIRequestContext, to: "ADDRESS" | "PIN" | "SHOP" | "REVIEW", o: FastForward) {
  if (!IS_LOCAL) blocked("drives a registration through the wizard's API (local run only)");
  const step = async (path: string, body: unknown, what: string) => {
    const res = await call(ctx, "POST", `/api/shops/registration-draft/${path}`, body);
    expectStatus(res, 200, what);
    return res.body;
  };
  await step("referral", { referralCode: o.referralCode }, "answer the referral code");
  let view = await step("gstin", { gstin: o.gstin, consent: true }, "verify the GSTIN (mock vendor)");
  expect(view.canContinue, `GSTIN verified by the mock vendor — ${JSON.stringify(view.gstin)}`).toBe(true);
  if (view.nextStep === "OWNER") view = await step("owner", { ownerName: o.ownerName ?? "QA Identity Owner" }, "owner name");
  if (to !== "ADDRESS") {
    view = await step(
      "address",
      { addressLine1: o.addressLine1 ?? `${seq + 1} QA Identity Lane ${RUN}, Paud Road`, addressLine2: null, area: "Kothrud", city: "Pune", state: "Maharashtra", pincode: "411038", landmark: null },
      "confirm the address",
    );
  }
  if (to === "SHOP" || to === "REVIEW") view = await step("location", { latitude: 18.5074, longitude: 73.8077, address: null }, "map pin");
  if (to === "REVIEW") {
    view = await step(
      "details",
      {
        name: o.shopName ?? `QA Identity Shop ${RUN} ${++seq}`,
        ownerName: null,
        phone: uniqueMobile(),
        email: null,
        shopType: "STATIONERY_STORE",
        categoryIds: [],
        annualTurnoverRupees: o.turnoverRupees ?? 2_00_00_000,
        couponCode: null,
        referralCode: null,
        employeeId: null,
      },
      "shop details",
    );
  }
  expect(view.nextStep, `wizard at ${to}`).toBe(to);
  return view;
}

/** The fresh owner's OPEN registration as stored (local only). */
export async function draftRow(ownerId: string) {
  const [row] = await db()<
    {
      id: string;
      route: string | null;
      gst_status: string;
      gst_error_code: string | null;
      pan_status: string;
      pan_error_code: string | null;
      checks_in_window: number;
      latitude: string | null;
      longitude: string | null;
      location_confirmed_at: Date | null;
      no_gst_declared_at: Date | null;
      referral_code: string | null;
      details: Record<string, unknown> | null;
    }[]
  >`select id, route, gst_status, gst_error_code, pan_status, pan_error_code, checks_in_window, latitude, longitude,
           location_confirmed_at, no_gst_declared_at, referral_code, details
    from shop_registration_drafts where owner_id = ${ownerId} and status = 'OPEN'`;
  return row ?? null;
}

/** How many paid checks the registration's audit trail records (local only). */
export async function checksAudited(draftId: string): Promise<number> {
  const [row] = await db()<{ n: number }[]>`select count(*)::int as n from audit_logs where entity_id = ${draftId} and action = 'shop_registration_draft.checked'`;
  return row.n;
}

/* --------------------------------------------------------------- the page */

/** Counts the wizard's writes a page sends (POST /api/shops/registration-draft/…). */
export function countWizardPosts(page: Page): { paths: string[] } {
  const seen = { paths: [] as string[] };
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() !== "GET" && path.startsWith("/api/shops/registration-draft/")) seen.paths.push(path);
  });
  return seen;
}

/**
 * Signed tier: every wizard write the page tries is stopped in the browser (so no draft is made and
 * no number reaches the government check on the site), except the paths `allow` lets through.
 * Returns what was stopped, with its body.
 */
export async function guardWizardWrites(page: Page, allow: (path: string) => boolean = () => false): Promise<{ method: string; path: string; body: string }[]> {
  const stopped: { method: string; path: string; body: string }[] = [];
  await page.route("**/api/shops/registration-draft/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" || allow(path)) return route.continue();
    stopped.push({ method: req.method(), path, body: req.postData() ?? "" });
    await route.abort();
  });
  return stopped;
}

/**
 * Opens /shop/register on the identity screen ("Verify your business", GST route). A registration
 * already past it is shown its tile 2; a shop waiting for its fee or approval blocks the check.
 */
export async function openIdentityScreen(page: Page, url = "/shop/register") {
  await page.goto(url);
  const waiting = page.getByTestId("registration-waiting");
  const tiles = page.getByTestId("registration-tiles");
  await expect(waiting.or(tiles).first()).toBeVisible();
  if (await waiting.isVisible()) blocked("this account has a shop waiting for its fee or approval, so the registration wizard is not shown");
  const heading = page.getByRole("heading", { name: IDENTITY.heading });
  if (!(await heading.isVisible())) {
    const tile = tiles.getByRole("button", { name: /2\. Verify/ });
    if (!(await tile.isVisible())) blocked("this account's registration is past the identity step and cannot go back to it");
    await tile.click();
  }
  await expect(heading).toBeVisible();
  const useGst = page.getByTestId("use-gst");
  if (await useGst.isVisible()) await useGst.click();
  await expect(page.getByTestId("gstin-input")).toBeVisible();
}

/** Blocks when the account's registration already holds a locked referral code (the field is read-only). */
export async function needEditableReferral(page: Page) {
  const field = page.getByTestId("wizard-referral-code");
  if ((await field.getAttribute("readonly")) !== null) blocked(`this account's registration already holds referral code ${await field.inputValue()} (locked)`);
}

/* -------------------------------------------------------- document photos */

/** A GSTIN the on-device reader reads back exactly from the generated certificate (checked with tesseract.js). */
export const PHOTO_GSTIN = "27QAXPK4321M1ZP";

/** A generated photo of a GST certificate (REG-06 wording) carrying `gstin`; `blur` > 0 makes it unreadable. */
export async function gstCertificatePhoto(gstin = PHOTO_GSTIN, blur = 0): Promise<Buffer> {
  const lines = ["Government of India", "Form GST REG-06", "Registration Certificate", `Registration Number : ${gstin}`, "Legal Name : QA PHOTO TRADERS", "Trade Name : QA PHOTO TRADERS"];
  const text = lines.map((l, i) => `<text x="70" y="${110 + i * 115}" font-family="Arial, Helvetica, sans-serif" font-size="54" fill="#000000">${l}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="820"><rect width="100%" height="100%" fill="#ffffff"/>${text}</svg>`;
  let img = sharp(Buffer.from(svg));
  if (blur > 0) img = img.blur(blur);
  return keep(`gst-certificate-${blur ? "blurred" : "clear"}.jpg`, await img.jpeg({ quality: 90 }).toBuffer());
}


/**
 * An account that owns no shop, to look at the first registration screen as a new owner would:
 * a plain customer when one is free, otherwise a delivery partner (staging's riders own no shop;
 * the wizard is the same for them). The signed checks only look, so no draft or shop is made.
 */
export async function shopFreeAccount(): Promise<"customer" | "customer2" | "rider" | "rider2"> {
  const seen: string[] = [];
  for (const role of ["customer2", "customer", "rider", "rider2"] as const) {
    if (!world().users[role]) continue;
    const who = await me(role).catch(() => null);
    if (who && ["CUSTOMER", "DELIVERY_PARTNER"].includes(who.role) && (await ownsNoShop(role))) return role;
    seen.push(role);
  }
  blocked(`no test account without a shop (${seen.join(", ")} each own one)`);
}
