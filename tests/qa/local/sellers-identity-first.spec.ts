/**
 * Identity-first shop registration (/shop/register, owner brief 08-Nov-2026,
 * docs/shop-onboarding-identity-first-2026-11): TC-ONB-048 … TC-ONB-068 with the government
 * check answered — the local server's mock KYC vendor (KYC_PROVIDER=mock, the default;
 * src/server/kyc/adapters/mock.ts) answers by the PAN's four digits, so every outcome the
 * mock has (verified, not found, cancelled, inactive, vendor down, can't check) is driven here.
 *
 * Local tier: every registration is a fresh account; admin settings (referral setting, rule
 * shopReferrals, rule sellerVerification, the dealer-programme flag) are changed for one check
 * and restored. Earlier steps are taken through the wizard's own API (fastForward) and the step
 * the case is about is driven on the page.
 *
 * Not automated: TC-ONB-058 and TC-ONB-060 (see the manual() entries at the end).
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { call, expectStatus, RUN } from "../lib/http";
import { blocked, expect, manual, qa } from "../lib/record";
import {
  ctxFor,
  freshAccount,
  getRule,
  needPanStorage,
  pageFor,
  registerShop,
  shopCategoryId,
  shopRow,
  uniqueMobile,
  uniqueShopAct,
  withRule,
} from "../lib/sellers-helpers";
import { db } from "../lib/db";
import {
  checksAudited,
  countWizardPosts,
  draftRow,
  fastForward,
  IDENTITY,
  localReferralCode,
  OUTCOME,
  scenarioGstin,
  scenarioPan,
  withFeatureFlag,
  withShopReferralSetting,
} from "../lib/identity-first-helpers";

const local = { tier: "local" as const, timeout: 240_000 };

const ADDRESS_HEADING = "Confirm your shop address";
const PIN_HEADING = "Mark your shop location on the map";
const SHOP_HEADING = "Contact and shop details";
const REVIEW_HEADING = "Payment";

async function freshOwner(label: string) {
  const owner = await freshAccount(label);
  return { owner, ctx: await ctxFor(owner) };
}

/** Types the code (when given) and a number on the identity screen, ticks the consent and clicks Verify. */
async function verifyOnScreen(page: Page, number: string, opts: { code?: string | null; pan?: boolean } = {}) {
  const field = page.getByTestId("wizard-referral-code");
  // A code already in the field (and read-only once applied while rule shopReferrals is on) is left as it is.
  if (opts.code !== undefined && (await field.inputValue()) !== (opts.code ?? "")) await field.fill(opts.code ?? "");
  if (opts.pan) {
    if (await page.getByRole("button", { name: IDENTITY.usePan }).isVisible()) await page.getByRole("button", { name: IDENTITY.usePan }).click();
    await page.getByTestId("pan-input").fill(number);
    await page.getByRole("checkbox", { name: IDENTITY.declaration }).check();
  } else {
    await page.getByTestId("gstin-input").fill(number);
  }
  await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
  const answer = page.waitForResponse((r) => /\/api\/shops\/registration-draft\/(gstin|pan)$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await page.getByTestId("verify-identity").click();
  return (await answer).status();
}

async function invalid(page: Page, testId: string, flag: "valueMissing" | "patternMismatch" | "tooShort") {
  return page.getByTestId(testId).evaluate((el, f) => (el as HTMLInputElement).validity[f as keyof ValidityState] as boolean, flag);
}

/* ------------------------------------------------------- 1. verify (TS-ONB-12) */

qa("TC-ONB-048", "GSTIN with the referral code left empty (optional): read-only PAN from characters 3–12, verified by the vendor, straight on to the address; ✓ Verified from GST; Verified on tile 2", async ({ browser }) => {
  await needPanStorage();
  const { owner } = await freshOwner("onb048");
  return withShopReferralSetting("OPTIONAL", async () => {
    const { context, page } = await pageFor(browser, owner);
    try {
      await page.goto("/shop/register");
      await expect(page.getByRole("heading", { name: IDENTITY.heading, exact: true })).toBeVisible();
      await expect(page.getByText("Referral code (optional)", { exact: true })).toBeVisible();
      await expect(page.getByTestId("wizard-referral-code")).toHaveValue("");
      await expect(page.getByText(IDENTITY.gstLabel, { exact: true })).toBeVisible();
      const { gstin, pan } = scenarioGstin("P");
      await page.getByTestId("gstin-input").fill(gstin);
      await expect(page.getByText(IDENTITY.derivedPanLabel, { exact: true })).toBeVisible();
      await expect(page.getByTestId("derived-pan")).toHaveValue(pan);
      await expect(page.getByTestId("derived-pan")).toHaveAttribute("readonly", "");
      const verify = page.getByTestId("verify-identity");
      await expect(verify).toHaveText("Verify GSTIN");
      await expect(verify).toBeDisabled();
      await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
      await expect(verify).toBeEnabled();
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/shops/registration-draft/gstin");
      await verify.click();
      expect((await answer).status(), "GSTIN check").toBe(200);
      // A proprietor's record names the owner: no Owner step, straight to the address.
      await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Owner name", exact: true })).toHaveCount(0);
      await expect(page.getByLabel(/^Address\s*✓ Verified from GST$/)).toHaveValue(/Shivajinagar, Pune/);
      await expect(page.getByTestId("owner-line")).toContainText("Owner: TEST SELLER");
      await expect(page.getByTestId("owner-line").getByTestId("verified-from")).toHaveText("✓ Verified from GST");
      // Tile 2 is done and opens the identity screen again, with the number verified.
      await page.getByTestId("registration-tiles").getByRole("button", { name: /2\. Verify/ }).click();
      await expect(page.getByRole("heading", { name: IDENTITY.heading, exact: true })).toBeVisible();
      await expect(page.getByText("Verified", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
      const row = await draftRow(owner.id);
      expect(row?.gst_status, "GSTIN stored").toBe("VERIFIED");
      expect(row?.pan_status, "its PAN, checked in the background").toBe("VERIFIED");
      expect(row?.referral_code ?? null, "no referral code").toBeNull();
      return `GSTIN ${gstin.slice(0, 2)}…: PAN ${pan} read-only; Verify enabled by consent; → "${ADDRESS_HEADING}" with ✓ Verified from GST on the address and owner; tile 2 shows "Verified"`;
    } finally {
      await context.close();
    }
  });
}, local);

qa("TC-ONB-049", "the server refuses a malformed or mistyped GSTIN on the field before any check: no registration is opened and no check is counted", async () => {
  await needPanStorage();
  const { owner, ctx } = await freshOwner("onb049");
  const { gstin } = scenarioGstin("P");
  const mistyped = gstin.slice(0, 14) + (gstin[14] === "A" ? "B" : "A");
  const seen: string[] = [];
  for (const bad of ["27ABCDE1234F1Z", mistyped]) {
    const res = await call(ctx, "POST", "/api/shops/registration-draft/gstin", { gstin: bad, consent: true });
    expect(res.status, `${bad}: HTTP`).toBe(422);
    expect(res.body?.error?.details?.fields?.gstin, `${bad}: message on the gstin field`).toBeTruthy();
    seen.push(`${bad} → 422 "${res.body.error.details.fields.gstin}"`);
  }
  expect(seen[0]).toContain("GST number must be 15 characters, e.g. 27ABCDE1234F1Z0.");
  expect(seen[1]).toContain("This GST number fails its check character — one character is probably mistyped.");
  expect(await draftRow(owner.id), "no registration opened, so no check counted").toBeNull();
  return seen.join("; ");
}, { ...local, partial: "the screen's own format message and upper-casing are proven in the signed tier" });

qa("TC-ONB-050", "PAN route: Verify PAN only with both ticks; the PAN is verified (mock vendor) and the wizard moves on with ✓ Verified from PAN", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner } = await freshOwner("onb050");
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await page.getByTestId("wizard-referral-code").fill(code);
    await page.getByRole("button", { name: IDENTITY.usePan }).click();
    const pan = scenarioPan("P");
    await page.getByTestId("pan-input").fill(pan);
    const verify = page.getByTestId("verify-identity");
    await expect(verify).toHaveText("Verify PAN");
    await expect(verify, "no ticks").toBeDisabled();
    await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
    await expect(verify, "consent only").toBeDisabled();
    // "I have a GST number" switches back, and the PAN route again.
    await page.getByRole("button", { name: IDENTITY.useGst }).click();
    await expect(page.getByTestId("gstin-input")).toBeVisible();
    await page.getByRole("button", { name: IDENTITY.usePan }).click();
    const status = await verifyOnScreen(page, pan, { pan: true });
    expect(status, "PAN check").toBe(200);
    await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
    await expect(page.getByText("Your record gave no address — enter your shop's address.", { exact: true })).toBeVisible();
    await expect(page.getByTestId("owner-line").getByTestId("verified-from")).toHaveText("✓ Verified from PAN");
    const row = await draftRow(owner.id);
    expect(row?.route).toBe("PAN_ONLY");
    expect(row?.pan_status).toBe("VERIFIED");
    expect(row?.no_gst_declared_at, "the not-GST-registered declaration is recorded").not.toBeNull();
    return `PAN …${pan.slice(-4)}: Verify PAN disabled until both ticks; verified → "${ADDRESS_HEADING}", owner ✓ Verified from PAN; declaration stored`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-051", "the server refuses a malformed PAN and a PAN without the declaration before any check: nothing opened, nothing counted", async () => {
  await needPanStorage();
  const { owner, ctx } = await freshOwner("onb051");
  const bad = await call(ctx, "POST", "/api/shops/registration-draft/pan", { pan: "ABCD12345F", declaration: true, consent: true });
  expect(bad.status, "ABCD12345F").toBe(422);
  expect(bad.body?.error?.details?.fields?.pan, "message on the pan field").toBeTruthy();
  const undeclared = await call(ctx, "POST", "/api/shops/registration-draft/pan", { pan: scenarioPan("P"), declaration: false, consent: true });
  expect(undeclared.status, "no declaration").toBe(422);
  expect(undeclared.body?.error?.details?.fields?.declaration).toBe("Please confirm that the shop is not registered under GST.");
  expect(await draftRow(owner.id), "nothing opened").toBeNull();
  return `ABCD12345F → 422 "${bad.body.error.details.fields.pan}"; declaration false → 422 "${undeclared.body.error.details.fields.declaration}"`;
}, local);

qa("TC-ONB-052", "a referral link's code is applied by itself: “✓ Applied. Only one code can be used, so it cannot be changed.” and read-only while shop referrals are on (“✓ Applied”, editable, while off)", async ({ browser }) => {
  const code = await localReferralCode();
  const notes: string[] = [];
  await withRule("shopReferrals", { enabled: true }, async () => {
    const { owner } = await freshOwner("onb052on");
    const { context, page } = await pageFor(browser, owner);
    try {
      await page.goto(`/shop/register?ref=${code}`);
      const field = page.getByTestId("wizard-referral-code");
      await expect(page.getByText("✓ Applied. Only one code can be used, so it cannot be changed.", { exact: true })).toBeVisible();
      await expect(field).toHaveValue(code);
      await expect(field, "read-only").not.toBeEditable();
      await field.focus();
      await page.keyboard.type("ZZ");
      await expect(field, "typing changes nothing").toHaveValue(code);
      expect((await draftRow(owner.id))?.referral_code, "the code is saved on the registration").toBe(code);
      notes.push(`rule on: ${code} applied, read-only with the reason`);
    } finally {
      await context.close();
    }
  });
  await withRule("shopReferrals", { enabled: false }, async () => {
    const { owner } = await freshOwner("onb052off");
    const { context, page } = await pageFor(browser, owner);
    try {
      await page.goto(`/shop/register?ref=${code}`);
      await expect(page.getByText("✓ Applied", { exact: true })).toBeVisible();
      await expect(page.getByTestId("wizard-referral-code")).toBeEditable();
      notes.push("rule off: “✓ Applied”, field editable");
    } finally {
      await context.close();
    }
  });
  return notes.join("; ");
}, local);

qa("TC-ONB-053", "referral code refusals: NOSUCH99 and an expired code with their messages under both settings; a mandatory code keeps Verify disabled under 3 characters and the server refuses an empty one; “Request a referral code” while empty or in error", async ({ browser }) => {
  await needPanStorage();
  const expired = await localReferralCode({ expiresAt: "2026-01-01", prefix: "QAEXP" });
  const { owner, ctx } = await freshOwner("onb053");
  const { gstin } = scenarioGstin("P");
  const { context, page } = await pageFor(browser, owner);
  const notes: string[] = [];
  try {
    const code = page.getByTestId("wizard-referral-code");
    const verify = page.getByTestId("verify-identity");
    const request = page.getByTestId("request-referral-code");
    const refuse = async (typed: string, message: string) => {
      await code.fill(typed);
      const answer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/shops/registration-draft/referral");
      await verify.click();
      expect((await answer).status(), `${typed}: HTTP`).toBe(422);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(request, `link while ${typed} is in error`).toBeVisible();
    };
    await withShopReferralSetting("MANDATORY", async () => {
      await page.goto("/shop/register");
      await expect(page.getByText("Referral code", { exact: true })).toBeVisible();
      await expect(page.getByText("Referral code (optional)", { exact: true })).toHaveCount(0);
      await expect(request, "link while empty").toBeVisible();
      await page.getByTestId("gstin-input").fill(gstin);
      await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
      await expect(verify, "empty").toBeDisabled();
      await code.fill("AB");
      await expect(verify, "2 characters").toBeDisabled();
      await code.fill("ABC");
      await expect(verify, "3 characters").toBeEnabled();
      await expect(request, "no link while a code is typed").toHaveCount(0);
      await refuse("NOSUCH99", "Referral code NOSUCH99 does not exist. Check the code, or request one.");
      await expect(page.getByText("Referral code NOSUCH99 does not exist.", { exact: true }), "under the field").toBeVisible();
      await refuse(expired, `Referral code ${expired} expired on 2026-01-01. Check the code, or request one.`);
      const empty = await call(ctx, "POST", "/api/shops/registration-draft/referral", { referralCode: null });
      expect(empty.status).toBe(422);
      expect(empty.body?.error?.message).toBe("Enter your referral code, or request one.");
      notes.push("mandatory: Verify disabled empty / 2 chars, enabled at 3; NOSUCH99 and expired refused (…or request one.); empty → 422 “Enter your referral code, or request one.”");
    });
    await withShopReferralSetting("OPTIONAL", async () => {
      await page.goto("/shop/register");
      await expect(page.getByText("Referral code (optional)", { exact: true })).toBeVisible();
      await page.getByTestId("gstin-input").fill(gstin);
      await page.getByRole("checkbox", { name: IDENTITY.consent }).check();
      await refuse("NOSUCH99", "Referral code NOSUCH99 does not exist. Check the code, or leave it empty.");
      await refuse(expired, `Referral code ${expired} expired on 2026-01-01. Check the code, or leave it empty.`);
      notes.push("optional: …Check the code, or leave it empty.");
    });
    const row = await draftRow(owner.id);
    expect(row?.gst_status ?? "NOT_SUBMITTED", "the GSTIN was never checked").toBe("NOT_SUBMITTED");
  } finally {
    await context.close();
  }
  return notes.join("; ");
}, local);

qa("TC-ONB-054", "Referral code stops at 32 characters and is upper-cased; “Employee ID or name” shows only with the dealer programme on and stops at 120", async ({ browser }) => {
  const { owner } = await freshOwner("onb054");
  const { context, page } = await pageFor(browser, owner);
  try {
    await withFeatureFlag("dealer_programme_enabled", true, async () => {
      await page.goto("/shop/register");
      const code = page.getByTestId("wizard-referral-code");
      await code.pressSequentially("ab12cd");
      await expect(code).toHaveValue("AB12CD");
      await code.fill("");
      await code.pressSequentially("Q".repeat(33));
      await expect(code, "32 at most").toHaveValue("Q".repeat(32));
      await page.getByText("Employee ID or name (optional)", { exact: true }).click();
      const employee = page.getByLabel("Employee ID or name", { exact: true });
      await employee.pressSequentially("E".repeat(121));
      await expect(employee, "120 at most").toHaveValue("E".repeat(120));
    });
    await withFeatureFlag("dealer_programme_enabled", false, async () => {
      await page.reload();
      await expect(page.getByRole("heading", { name: IDENTITY.heading, exact: true })).toBeVisible();
      await expect(page.getByText("Employee ID or name (optional)", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("wizard-employee-id")).toHaveCount(0);
    });
  } finally {
    await context.close();
  }
  return "33 → 32, ab12cd → AB12CD; programme on: Employee ID 121 → 120; off: field gone";
}, local);

qa("TC-ONB-056", "hourly cap on paid checks (sellerVerification.maxChecksPerShopPerHour set to 2): the third number gets “Too many checks in the last hour. Please try again later.” and no check is made", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner } = await freshOwner("onb056");
  return withRule("sellerVerification", { maxChecksPerShopPerHour: 2 }, async () => {
    const { context, page } = await pageFor(browser, owner);
    try {
      await page.goto("/shop/register");
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push(await verifyOnScreen(page, scenarioGstin("P", "0000").gstin, { code }));
      expect(statuses, "two checks, then refused").toEqual([200, 200, 429]);
      await expect(page.getByText(OUTCOME.tooMany, { exact: true })).toBeVisible();
      const row = await draftRow(owner.id);
      expect(row?.checks_in_window, "checks counted this hour").toBe(2);
      expect(await checksAudited(row!.id), "checks made (audit)").toBe(2);
      return `HTTP ${statuses.join(", ")}; "${OUTCOME.tooMany}"; ${row?.checks_in_window} checks counted and audited`;
    } finally {
      await context.close();
    }
  });
}, local);

/* ------------------------------------------------------ outcomes (TS-ONB-13) */

qa("TC-ONB-057", "government service down: “The government service is not answering right now. Please try again in a few minutes.”, “Not verified yet”, no way on; the check stays PENDING with an error code, never FAILED", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner } = await freshOwner("onb057");
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    expect(await verifyOnScreen(page, scenarioGstin("P", "9999").gstin, { code }), "the check answers").toBe(200);
    await expect(page.getByText(OUTCOME.pending, { exact: true })).toBeVisible();
    await expect(page.getByText("Not verified yet", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: IDENTITY.heading, exact: true }), "still on the identity step after a reload").toBeVisible();
    const row = await draftRow(owner.id);
    expect(row?.gst_status).toBe("PENDING");
    expect(row?.gst_error_code ?? "", "an error code").toMatch(/^vendor_/);
    return `"${OUTCOME.pending}"; stored PENDING / ${row?.gst_error_code}`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-059", "not-found, cancelled and inactive numbers are refused with their own messages and “Not verified”; the owner cannot continue", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner } = await freshOwner("onb059");
  const { context, page } = await pageFor(browser, owner);
  const seen: string[] = [];
  try {
    await page.goto("/shop/register");
    const cases: [string, string, boolean][] = [
      [scenarioGstin("P", "0000").gstin, OUTCOME.notFound, false],
      [scenarioGstin("P", "8888").gstin, OUTCOME.cancelled, false],
      [scenarioPan("P", "8888"), OUTCOME.inactive, true],
    ];
    for (const [number, message, pan] of cases) {
      expect(await verifyOnScreen(page, number, { code, pan }), `${number}: HTTP`).toBe(200);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByText("Not verified", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: IDENTITY.heading, exact: true })).toBeVisible();
      seen.push(`${pan ? "PAN" : "GSTIN"} …${number.slice(pan ? 5 : 7, pan ? 9 : 11)} → "${message}"`);
    }
    const row = await draftRow(owner.id);
    expect([row?.pan_status, row?.pan_error_code]).toEqual(["FAILED", "document_inactive"]);
  } finally {
    await context.close();
  }
  return seen.join("; ");
}, { ...local, partial: "a suspended GSTIN (“The government record shows this GSTIN as suspended.”) and an inactive GSTIN cannot be produced with the local mock vendor (its inactive record is a PAN)" });

qa("TC-ONB-061", "Udyam, FSSAI and Shop Act numbers the vendor cannot check go to “Under review”, never “Not verified”; Seller verification review lists them and the admin approves or rejects each", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const owner = await freshAccount("onb061");
  const ctx = await ctxFor(owner);
  const { shop } = await registerShop(ctx, {
    shopType: "DAIRY",
    categoryIds: [await shopCategoryId("Dairy Shop")],
    shopActNumber: null,
    panNumber: scenarioPan("P"),
    panHolderName: "QA Seller Owner",
    annualTurnoverRupees: 500_000,
    referralCode: code,
  });
  const stamp = String(Date.now());
  // The mock vendor cannot check numbers ending 5555, nor any Maharashtra Shop Act (as Sandbox.co.in checks only PAN and GSTIN).
  const numbers: Record<string, string> = { UDYAM: `UDYAM-MH-26-${stamp.slice(-3)}5555`, FSSAI: `1${stamp.slice(-9)}5555`, SHOP_ACT: uniqueShopAct() };
  const ids: Record<string, string> = {};
  for (const [docType, number] of Object.entries(numbers)) {
    const res = await call(ctx, "POST", `/api/shops/${shop.id}/verifications`, { docType, number, consent: true });
    expectStatus(res, 200, `submit ${docType}`);
    expect([res.body.status, res.body.lastErrorCode], `${docType} after the check`).toEqual(["MANUAL_REVIEW", "vendor_unsupported"]);
    ids[docType] = res.body.id;
  }
  const notes: string[] = [];
  const own = await pageFor(browser, owner);
  try {
    await own.page.goto(`/shop/verification?shop=${shop.id}`);
    for (const docType of Object.keys(numbers)) {
      const card = own.page.getByTestId(`verification-${docType}`);
      await expect(card.getByText("Under review", { exact: true }), `${docType} badge`).toBeVisible();
      await expect(card.getByText("This document can't be checked online. Our team will review it.", { exact: true })).toBeVisible();
      await expect(card.getByText("Not verified", { exact: true })).toHaveCount(0);
    }
    notes.push("owner: Udyam, FSSAI, Shop Act “Under review” — can't be checked online");
  } finally {
    await own.context.close();
  }
  const admin = await pageAs(browser, "admin");
  try {
    await admin.page.goto("/admin/seller-verification");
    await expect(admin.page.getByRole("heading", { name: "Seller verification review" })).toBeVisible();
    const cards = admin.page.getByTestId("seller-verification-review").filter({ hasText: shop.name });
    if ((await cards.count()) >= 3) {
      for (const card of await cards.all()) {
        for (const button of ["Approve", "Ask for more info", "Reject"]) await expect(card.getByRole("button", { name: button, exact: true })).toBeVisible();
      }
      await cards.filter({ hasText: "Udyam registration" }).getByRole("button", { name: "Approve", exact: true }).click();
      const fssai = cards.filter({ hasText: "FSSAI licence" });
      await fssai.getByRole("button", { name: "Reject", exact: true }).click();
      await fssai.getByPlaceholder(/Reason shown to the seller/).fill("QA: the FSSAI certificate does not match the number");
      await fssai.getByRole("button", { name: "Confirm reject" }).click();
      notes.push("admin: 3 cards with Approve / Ask for more info / Reject; Udyam approved, FSSAI rejected on the page");
    } else {
      // The queue shows the 200 oldest items; a busy local database may push these off the page.
      const admin2 = await as("admin");
      expectStatus(await call(admin2, "POST", `/api/admin/seller-verifications/${ids.UDYAM}/decision`, { decision: "approve", reason: "" }), 200, "approve Udyam");
      expectStatus(await call(admin2, "POST", `/api/admin/seller-verifications/${ids.FSSAI}/decision`, { decision: "reject", reason: "QA: the FSSAI certificate does not match the number" }), 200, "reject FSSAI");
      notes.push(`admin: the shop's cards were not on the first 200 of the queue (${await cards.count()} shown) — decided through the same API`);
    }
  } finally {
    await admin.context.close();
  }
  await expect
    .poll(async () => {
      const [u, f, s] = await Promise.all(["UDYAM", "FSSAI", "SHOP_ACT"].map((t) => db()<{ status: string }[]>`select status from seller_verifications where id = ${ids[t]}`));
      return [u[0]?.status, f[0]?.status, s[0]?.status];
    }, { timeout: 15_000 })
    .toEqual(["VERIFIED", "FAILED", "MANUAL_REVIEW"]);
  notes.push("after the decisions: Udyam VERIFIED, FSSAI FAILED (rejected), Shop Act still under review");
  return notes.join("; ");
}, { ...local, partial: "on the local mock vendor numbers ending 5555 stand in for Sandbox.co.in's “cannot check” on Udyam and FSSAI (any Maharashtra Shop Act is one); the numbers are submitted through the shop's verification API — the Shop Act card on the screen also asks for the certificate" });

/* ------------------------------------------------ owner → review (TS-ONB-14) */

qa("TC-ONB-062", "Owner name step only when the record names no owner: a company's GSTIN asks for it (“A” keeps Continue disabled, the server says “Enter the owner's name.”); a proprietor's GSTIN skips it", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const company = await freshOwner("onb062c");
  const notes: string[] = [];
  {
    const { context, page } = await pageFor(browser, company.owner);
    try {
      await page.goto("/shop/register");
      expect(await verifyOnScreen(page, scenarioGstin("C").gstin, { code })).toBe(200);
      await expect(page.getByRole("heading", { name: "Owner name", exact: true })).toBeVisible();
      await expect(page.getByText("Your GST record is for TEST SELLER (Private Limited Company) and names no owner. Who owns or runs the shop?", { exact: true })).toBeVisible();
      const name = page.getByTestId("owner-name");
      const go = page.getByRole("button", { name: "Continue", exact: true });
      await name.fill("A");
      await expect(go, "one letter").toBeDisabled();
      const one = await call(company.ctx, "POST", "/api/shops/registration-draft/owner", { ownerName: "A" });
      expect(one.status).toBe(422);
      expect(one.body?.error?.details?.fields?.ownerName).toBe("Enter the owner's name.");
      await name.fill("Asha Patil");
      await go.click();
      await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
      await expect(page.getByTestId("owner-line")).toContainText("Owner: Asha Patil");
      await expect(page.getByTestId("owner-line").getByTestId("verified-from")).toHaveCount(0);
      notes.push("company GSTIN → Owner name; “A” disabled (API 422 “Enter the owner's name.”); Asha Patil → address");
    } finally {
      await context.close();
    }
  }
  const proprietor = await freshOwner("onb062p");
  {
    const { context, page } = await pageFor(browser, proprietor.owner);
    try {
      await page.goto("/shop/register");
      expect(await verifyOnScreen(page, scenarioGstin("P").gstin, { code })).toBe(200);
      await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Owner name", exact: true })).toHaveCount(0);
      await expect(page.getByTestId("owner-line").getByTestId("verified-from")).toHaveText("✓ Verified from GST");
      notes.push("proprietor GSTIN → straight to the address, owner from the record");
    } finally {
      await context.close();
    }
  }
  return notes.join("; ");
}, local);

qa("TC-ONB-063", "address step: the record's address with ✓ Verified from GST; an empty Address or PIN code is flagged and nothing is saved; with State, line 2, Area and Landmark empty it moves on to the map", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner, ctx } = await freshOwner("onb063");
  await fastForward(ctx, "ADDRESS", { gstin: scenarioGstin("P").gstin, referralCode: code });
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Address\s*✓ Verified from GST$/)).toHaveValue(/Shivajinagar, Pune, Maharashtra, 411001/);
    await expect(page.getByTestId("address-city")).toHaveValue("Pune");
    await expect(page.getByTestId("address-pincode")).toHaveValue("411001");
    const posts = countWizardPosts(page);
    await page.getByTestId("address-line1").fill("");
    await page.getByTestId("address-pincode").fill("");
    await page.getByTestId("address-continue").click();
    expect(await invalid(page, "address-line1", "valueMissing"), "Address flagged").toBe(true);
    expect(await invalid(page, "address-pincode", "valueMissing"), "PIN code flagged").toBe(true);
    await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
    expect(posts.paths, "nothing saved").toEqual([]);
    const line = `7 QA Address Lane ${RUN}, Paud Road`;
    await page.getByTestId("address-line1").fill(line);
    await page.getByTestId("address-pincode").fill("411038");
    await page.getByLabel("State", { exact: true }).fill("");
    await page.getByTestId("address-continue").click();
    await expect(page.getByRole("heading", { name: PIN_HEADING, exact: true })).toBeVisible();
    const details = (await draftRow(owner.id))?.details ?? {};
    expect({ addressLine1: details.addressLine1, addressLine2: details.addressLine2, area: details.area, landmark: details.landmark, state: details.state, pincode: details.pincode }).toEqual({
      addressLine1: line,
      addressLine2: null,
      area: null,
      landmark: null,
      state: null,
      pincode: "411038",
    });
    const zero = await call(ctx, "POST", "/api/shops/registration-draft/address", { addressLine1: line, city: "Pune", pincode: "012345" });
    expect(zero.status).toBe(422);
    expect(zero.body?.error?.details?.fields?.pincode).toBe("PIN code must be 6 digits and not start with 0.");
    return "record address ✓ Verified from GST; empty Address / PIN flagged, nothing sent; optional fields empty → map step; server refuses PIN 012345";
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-064", "map pin before payment: coordinates outside India are refused with “Please place the pin on your shop in India.”; 18.5204, 73.8567 is saved and the wizard goes on to the shop details — no shop yet", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner, ctx } = await freshOwner("onb064");
  await fastForward(ctx, "PIN", { gstin: scenarioGstin("P").gstin, referralCode: code });
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: PIN_HEADING, exact: true })).toBeVisible();
    await page.getByText("Map not loading? Enter the coordinates", { exact: true }).click();
    await page.getByTestId("pin-latitude").fill("51.5");
    await page.getByTestId("pin-longitude").fill("-0.12");
    await page.getByTestId("pin-save").click();
    await expect(page.getByText(OUTCOME.outsideIndia, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: PIN_HEADING, exact: true })).toBeVisible();
    expect((await draftRow(owner.id))?.location_confirmed_at ?? null, "nothing saved for London").toBeNull();
    await page.getByTestId("pin-latitude").fill("18.5204");
    await page.getByTestId("pin-longitude").fill("73.8567");
    await page.getByTestId("pin-save").click();
    await expect(page.getByRole("heading", { name: SHOP_HEADING, exact: true })).toBeVisible();
    const row = await draftRow(owner.id);
    expect([Number(row?.latitude), Number(row?.longitude)]).toEqual([18.5204, 73.8567]);
    expect(row?.location_confirmed_at, "pin confirmed").not.toBeNull();
    const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from shops where owner_id = ${owner.id}`;
    expect(n, "no shop before the payment step").toBe(0);
    return "51.5, -0.12 → refused; 18.5204, 73.8567 saved on the registration → shop details; no shop created yet";
  } finally {
    await context.close();
  }
}, { ...local, partial: "dragging the pin on the Google map is not automated (no Maps key on the local server); the coordinates fallback is" });

/** Fills the shop step with valid values except what `skip` names. */
async function fillShop(page: Page, name: string, skip: { type?: boolean; slab?: boolean } = {}) {
  await page.getByTestId("shop-name").fill(name);
  await page.getByTestId("shop-phone").fill(uniqueMobile());
  if (!skip.type) await page.getByTestId("shop-type").selectOption("STATIONERY_STORE");
  if (!skip.slab) await page.getByRole("radio", { name: /Up to ₹2 crore/ }).click();
}

qa("TC-ONB-065", "shop details: name pre-filled from the GST record, 10-digit contact 6–9, shop type and turnover slab required, the sign-in email with Change, optional coupon (max 40); Continue to payment", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner, ctx } = await freshOwner("onb065");
  await fastForward(ctx, "SHOP", { gstin: scenarioGstin("P").gstin, referralCode: code });
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: SHOP_HEADING, exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Shop name\s*✓ Verified from GST$/)).toHaveValue("TEST SELLER");
    const name = page.getByTestId("shop-name");
    await expect(name).toHaveAttribute("minlength", "2");
    await expect(name).toHaveAttribute("maxlength", "120");
    const phone = page.getByTestId("shop-phone");
    await expect(phone).toHaveAttribute("pattern", "[6-9][0-9]{9}");
    await expect(phone).toHaveAttribute("maxlength", "10");
    const emailLine = page.getByTestId("shop-email-line");
    await expect(emailLine).toContainText(`Shop email: ${owner.email}`);
    await expect(emailLine.getByRole("button", { name: "Change" })).toBeVisible();
    await page.getByText("Coupon code (optional)", { exact: true }).first().click();
    await expect(page.getByLabel("Coupon code (optional)", { exact: true })).toHaveAttribute("maxlength", "40");
    const go = page.getByTestId("shop-continue");
    await expect(go).toHaveText("Continue to payment");
    const shopName = `QA Details ${RUN}`;
    await fillShop(page, shopName, { slab: true });
    await expect(go, "no turnover slab").toBeDisabled();
    await page.getByRole("radio", { name: /Up to ₹2 crore/ }).click();
    await page.getByTestId("shop-type").selectOption("");
    const posts = countWizardPosts(page);
    await go.click();
    expect(await invalid(page, "shop-type", "valueMissing"), "shop type flagged").toBe(true);
    expect(posts.paths, "nothing saved without a shop type").toEqual([]);
    await page.getByTestId("shop-type").selectOption("STATIONERY_STORE");
    await go.click();
    await expect(page.getByRole("heading", { name: REVIEW_HEADING, exact: true })).toBeVisible();
    const d = (await draftRow(owner.id))?.details ?? {};
    expect({ name: d.name, shopType: d.shopType, turnover: d.annualTurnoverRupees, coupon: d.couponCode ?? null, email: d.email }).toEqual({
      name: shopName,
      shopType: "STATIONERY_STORE",
      turnover: 2_00_00_000,
      coupon: null,
      email: owner.email,
    });
    return `name pre-filled "TEST SELLER" ✓ Verified from GST (2–120); phone pattern [6-9][0-9]{9}; slab and type required; "Shop email: ${owner.email}" + Change; coupon max 40, left empty → Payment`;
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-066", "registration fee by turnover (default rule): Fee ₹999, ₹4,999 and ₹9,999 + GST; the Payment step repeats the chosen fee; after Create my shop and pay the button reads “Pay ₹1,178.82 now”", async ({ browser }) => {
  const rule = (await getRule("registrationFeeByTurnover")).value as { enabled?: boolean; slabs?: { upToRupees: number | null; feePaise: number }[] };
  const slabs = (rule.slabs ?? []).map((s) => `${s.upToRupees}:${s.feePaise}`).join(",");
  if (!rule.enabled || slabs !== "20000000:99900,100000000:499900,null:999900") blocked(`the fee rule is not the default on this server (${rule.enabled ? slabs : "off"})`);
  await needPanStorage();
  const code = await localReferralCode();
  const { owner, ctx } = await freshOwner("onb066");
  await fastForward(ctx, "SHOP", { gstin: scenarioGstin("P").gstin, referralCode: code });
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: SHOP_HEADING, exact: true })).toBeVisible();
    const slabsShown: [RegExp, string][] = [
      [/Up to ₹2 crore/, "Fee ₹999 + GST"],
      [/₹2 crore – ₹10 crore/, "Fee ₹4,999 + GST"],
      [/Above ₹10 crore/, "Fee ₹9,999 + GST"],
    ];
    for (const [label, fee] of slabsShown) {
      const radio = page.getByRole("radio", { name: label });
      await expect(radio).toContainText(fee);
      await radio.click();
      await expect(radio).toHaveAttribute("aria-checked", "true");
    }
    await fillShop(page, `QA Fee ${RUN}`);
    await page.getByTestId("shop-continue").click();
    await expect(page.getByRole("heading", { name: REVIEW_HEADING, exact: true })).toBeVisible();
    await expect(page.getByText("Up to ₹2 crore — fee ₹999 + GST", { exact: true })).toBeVisible();
    await expect(page.getByTestId("what-you-pay")).toContainText("Registration fee ₹999 + GST");
    // The payment itself is not opened: the gateway call is stopped in the browser.
    await page.route("**/api/shops/*/registration-fee", (route) => route.abort());
    await page.getByTestId("accept-seller-terms").check();
    await page.getByTestId("accept-seller-undertaking").check();
    await page.getByTestId("create-and-pay").click();
    await expect(page.getByRole("heading", { name: "Pay the registration fee", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Pay ₹1,178.82 now" })).toBeVisible();
    const [shop] = await db()<{ id: string }[]>`select id from shops where owner_id = ${owner.id}`;
    const row = await shopRow(shop.id);
    expect(Number(row.registration_fee_paise), "fee + 18 % GST").toBe(117_882);
    return "slabs Fee ₹999 / ₹4,999 / ₹9,999 + GST; review “Up to ₹2 crore — fee ₹999 + GST”; Pay ₹1,178.82 now (117882 paise on the shop)";
  } finally {
    await context.close();
  }
}, local);

qa("TC-ONB-067", "contact number and shop name limits: 5123456789, “98765 4321” and 98765abcde are refused, a 1-character name is refused and the name stops at 120 — on the screen and by the server", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner, ctx } = await freshOwner("onb067");
  await fastForward(ctx, "SHOP", { gstin: scenarioGstin("P").gstin, referralCode: code });
  const { context, page } = await pageFor(browser, owner);
  const notes: string[] = [];
  try {
    await page.goto("/shop/register");
    await expect(page.getByRole("heading", { name: SHOP_HEADING, exact: true })).toBeVisible();
    await fillShop(page, `QA Limits ${RUN}`);
    const posts = countWizardPosts(page);
    const go = page.getByTestId("shop-continue");
    for (const bad of ["5123456789", "98765 4321", "98765abcde"]) {
      await page.getByTestId("shop-phone").fill(bad);
      await go.click();
      expect(await invalid(page, "shop-phone", "patternMismatch"), `${bad} flagged`).toBe(true);
    }
    await page.getByTestId("shop-phone").fill(uniqueMobile());
    const name = page.getByTestId("shop-name");
    await name.fill("");
    await name.pressSequentially("A");
    await go.click();
    expect(await invalid(page, "shop-name", "tooShort"), "1-character name flagged").toBe(true);
    expect(posts.paths, "nothing saved").toEqual([]);
    await name.fill("");
    await name.pressSequentially("N".repeat(121));
    await expect(name, "120 at most").toHaveValue("N".repeat(120));
    notes.push("screen: three bad numbers and a 1-letter name flagged, nothing sent; 121 typed → 120");
    const base = { ownerName: null, email: null, shopType: "STATIONERY_STORE", categoryIds: [], annualTurnoverRupees: 2_00_00_000, couponCode: null, referralCode: null, employeeId: null };
    for (const bad of ["5123456789", "98765 4321", "98765abcde"]) {
      const res = await call(ctx, "POST", "/api/shops/registration-draft/details", { ...base, name: `QA Limits ${RUN}`, phone: bad });
      expect(res.status, `${bad}: HTTP`).toBe(422);
      expect(res.body?.error?.details?.fields?.phone).toBe("Enter a valid 10-digit mobile number");
    }
    for (const bad of ["A", "N".repeat(121)]) {
      const res = await call(ctx, "POST", "/api/shops/registration-draft/details", { ...base, name: bad, phone: uniqueMobile() });
      expect(res.status, `name of ${bad.length}: HTTP`).toBe(422);
      expect(res.body?.error?.details?.fields?.name, `name of ${bad.length}: field message`).toBeTruthy();
    }
    notes.push("server: 422 “Enter a valid 10-digit mobile number” ×3; names of 1 and 121 characters → 422 on name");
  } finally {
    await context.close();
  }
  return notes.join("; ");
}, local);

qa("TC-ONB-068", "Payment (review) step: every value with Change, kept after going back; “Your GSTIN is verified: your shop goes live as soon as the payment is confirmed.”; button “Create my shop and pay”", async ({ browser }) => {
  await needPanStorage();
  const code = await localReferralCode();
  const { owner, ctx } = await freshOwner("onb068");
  const shopName = `QA Review ${RUN}`;
  const line = `9 QA Review Lane ${RUN}, Paud Road`;
  await fastForward(ctx, "REVIEW", { gstin: scenarioGstin("P").gstin, referralCode: code, shopName, addressLine1: line });
  const { context, page } = await pageFor(browser, owner);
  try {
    await page.goto("/shop/register");
    const review = async () => {
      await expect(page.getByRole("heading", { name: REVIEW_HEADING, exact: true })).toBeVisible();
      for (const label of ["GSTIN", "Referral code", "Owner", "Shop address", "Map pin", "Shop", "Turnover"]) await expect(page.getByText(label, { exact: true }), label).toBeVisible();
      await expect(page.getByText("Verified", { exact: true })).toBeVisible();
      await expect(page.getByText(code, { exact: true })).toBeVisible();
      await expect(page.getByText("TEST SELLER", { exact: true })).toBeVisible();
      await expect(page.getByText(`${line}, Pune 411038`, { exact: true })).toBeVisible();
      await expect(page.getByText("Placed", { exact: true })).toBeVisible();
      await expect(page.getByText(`${shopName} · ${owner.email}`, { exact: true })).toBeVisible();
      await expect(page.getByText("Up to ₹2 crore — fee ₹999 + GST", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Change" })).toHaveCount(7);
      await expect(page.getByText("Your GSTIN is verified: your shop goes live as soon as the payment is confirmed.", { exact: true })).toBeVisible();
      await expect(page.getByTestId("create-and-pay")).toHaveText("Create my shop and pay");
      // docs/seller-undertaking-2026-11: Seller Terms and the undertaking start unticked; pay waits for both.
      await expect(page.getByTestId("accept-seller-terms")).not.toBeChecked();
      await expect(page.getByTestId("accept-seller-undertaking")).not.toBeChecked();
      await expect(page.getByTestId("create-and-pay")).toBeDisabled();
      await page.getByTestId("accept-seller-terms").check();
      await page.getByTestId("accept-seller-undertaking").check();
      await expect(page.getByTestId("create-and-pay")).toBeEnabled();
    };
    await review();
    // Rows in order: GSTIN, Referral code, Owner, Shop address, Map pin, Shop, Turnover — "Change" on Shop.
    await page.getByRole("button", { name: "Change" }).nth(5).click();
    await expect(page.getByRole("heading", { name: SHOP_HEADING, exact: true })).toBeVisible();
    await expect(page.getByTestId("shop-name")).toHaveValue(shopName);
    await expect(page.getByTestId("shop-type")).toHaveValue("STATIONERY_STORE");
    await expect(page.getByRole("radio", { name: /Up to ₹2 crore/ })).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("shop-continue").click();
    await review();
    // "Change" on Shop address, confirmed as it is.
    await page.getByRole("button", { name: "Change" }).nth(3).click();
    await expect(page.getByRole("heading", { name: ADDRESS_HEADING, exact: true })).toBeVisible();
    await expect(page.getByTestId("address-line1")).toHaveValue(line);
    await page.getByTestId("address-continue").click();
    await review();
    const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from shops where owner_id = ${owner.id}`;
    expect(n, "nothing created by looking").toBe(0);
    return "all seven rows with Change; values kept after Change → Shop and → Shop address; verified-GSTIN message; “Create my shop and pay” (not clicked)";
  } finally {
    await context.close();
  }
}, local);

/* ------------------------------------------------------------------ manual */

manual(
  "TC-ONB-058",
  "GSTIN linked to a different PAN: “The government record links this GSTIN to a different PAN. Please check the number, or enter your PAN instead.”",
  "needs a vendor answer whose GSTIN record names another PAN: the local mock vendor always links a GSTIN to its own PAN (src/server/kyc/adapters/mock.ts), and no Sandbox.co.in test GSTIN for it is known; the service path is covered by tests/integration/onboarding-wizard-step1.test.ts",
);

manual(
  "TC-ONB-060",
  "GSTIN verified but its PAN not confirmed: the owner carries on with a warning and the PAN goes to Seller verification review",
  "needs a vendor answer where the GSTIN verifies and the PAN inside it does not: the local mock vendor decides both by the same four digits, so one never differs from the other; needs Sandbox.co.in test data agreed with the owner",
);
