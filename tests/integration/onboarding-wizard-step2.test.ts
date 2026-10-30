/**
 * Onboarding wizard step 2, in the brief's order (owner decision 29 Oct 2026, "follow the
 * brief"; docs/shop-onboarding-wizard-2026-10/BRIEF_REDESIGN.md): after the GSTIN / PAN
 * step — Udyam, FSSAI, shop details & turnover slab, payment, approval, then the map pin,
 * categories and product list on the live shop.
 *
 *   - each step with its check statuses and "may continue", resumed where left
 *   - draft → shop: GSTIN, PAN, Udyam and FSSAI copied to seller_verifications with
 *     the vendor's reference; numbers never in clear
 *   - auto-approval: GSTIN (or PAN without one) VERIFIED + fee paid through the gateway →
 *     live, in any district, without the Shop Act; "ready for product upload" email
 *   - pending admin approval: no payment, a failed payment, a GSTIN / PAN not verified
 *     (vendor down, name mismatch), a food shop's FSSAI not verified
 *   - a food shop cannot skip FSSAI; the referral-code toggle (mandatory / optional)
 *   - failures: not found, expired, vendor down, steps out of order, a pin outside India;
 *     a shop outside the wizard keeps the 29 Oct documents gate
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { GET as draftRoute } from "@/app/api/shops/registration-draft/route";
import { POST as detailsRoute } from "@/app/api/shops/registration-draft/details/route";
import { POST as gstinRoute } from "@/app/api/shops/registration-draft/gstin/route";
import { POST as panRoute } from "@/app/api/shops/registration-draft/pan/route";
import { POST as documentsRoute } from "@/app/api/shops/registration-draft/documents/route";
import { POST as locationRoute } from "@/app/api/shops/registration-draft/location/route";
import { POST as submitRoute } from "@/app/api/shops/registration-draft/submit/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  notifications,
  sellerVerifications,
  shopAutoApprovalLog,
  shopCategories,
  shopDeferredDocumentReviews,
  shopRegistrationDraftChecks,
  shopRegistrationDrafts,
  shops,
} from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { finishFeeCapture } from "@/server/services/operator-limited";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { submitSellerDocument } from "@/server/services/seller-verification";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setReferralSetting } from "@/server/services/referral-settings";
import { setShopCategories } from "@/server/services/shop-categories";
import { clearRuleCache } from "@/server/services/settings";
import { promiseShopDocuments, shopDocumentGate } from "@/server/services/shop-document-gate";
import { submitDraftGstin, submitDraftPan } from "@/server/services/shop-registration-draft";
import {
  answerDraftDocument,
  getWizardDraft,
  requireWizardAvailable,
  saveDraftDetails,
  saveDraftLocation,
  showsWizard,
  submitDraftDocument,
  submitDraftForPayment,
  wizardAvailableFor,
  type DraftShopDetails,
} from "@/server/services/shop-registration-wizard";
import { registerShop, updateShop } from "@/server/services/shops";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

/** A GSTIN with a valid check character: state 27, the given PAN, entity 1, Z. */
const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const COMPANY_PAN = "AABCG1234K";
const PROPRIETOR_PAN = "ABCPK5678L";
const UDYAM = "UDYAM-MH-26-0012345";
const FSSAI = "11521998000123";
/** Maharashtra: no online Shop Act check, so it waits for an admin (MANUAL_REVIEW). */
const SHOP_ACT = "PMC/SHOP/2026/12345";

let owner: { id: string; role: "CUSTOMER"; email: string; name: string | null };
let categoryId: string;

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  // The built-in mock vendor, as on test.gokesari.com (scenario digits 0000 / 9999 / 8888 / 5555).
  setKycAdapterForTests(createMockAdapter());
  // No real geocoding call: the pin is kept as the owner placed it.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  const admin = await createUser({ role: "ADMIN" });
  await setRegistrationFee({ amountPaise: 99_900 }, { id: admin.id, role: "ADMIN" });
  const u = await createUser({ role: "CUSTOMER" });
  owner = { id: u.id, role: "CUSTOMER", email: u.email, name: u.name ?? null };
  const tag = randomUUID().slice(0, 8);
  const [category] = await db.insert(shopCategories).values({ name: `Wizard test ${tag}`, slug: `wizard-test-${tag}` }).returning();
  categoryId = category.id;
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

function details(overrides: Partial<DraftShopDetails> = {}): DraftShopDetails {
  return {
    name: "Test Seller Mart",
    ownerName: "Test Seller",
    phone: `98${String(Date.now()).slice(-8)}`,
    email: null,
    shopType: "GENERAL_TRADING",
    categoryIds: [categoryId],
    annualTurnoverRupees: 15_00_000,
    couponCode: null,
    referralCode: null,
    employeeId: null,
    addressLine1: "Shop No 4, Main Market",
    addressLine2: null,
    area: "Shivajinagar",
    city: "Pune",
    state: "Maharashtra",
    // The mock vendor's records sit at PIN 411001: FSSAI and Shop Act premises match.
    pincode: "411001",
    landmark: null,
    ...overrides,
  };
}

const doc = (docType: "UDYAM" | "FSSAI" | "SHOP_ACT", number: string, actor = owner) =>
  submitDraftDocument({ actor, docType, number, consentGiven: true });

/** GSTIN (or PAN) → Udyam → FSSAI → details & turnover slab: everything before payment. */
async function walkToReview(opts: { shopType?: string; fssai?: string | false; udyam?: string | false; pan?: string; gstin?: string; ownerName?: string } = {}) {
  if (opts.pan) await submitDraftPan({ pan: opts.pan, declarationAccepted: true, consentGiven: true, actor: owner });
  else await submitDraftGstin({ gstin: opts.gstin ?? gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
  if (opts.udyam === false) await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
  else await doc("UDYAM", opts.udyam ?? UDYAM);
  if (opts.fssai === false) await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
  else await doc("FSSAI", opts.fssai ?? FSSAI);
  // Categories are chosen after approval (CATEGORY step), as the brief orders it.
  await saveDraftDetails({ actor: owner, details: details({ shopType: opts.shopType ?? "GENERAL_TRADING", categoryIds: [], ...(opts.ownerName ? { ownerName: opts.ownerName } : {}) }) });
  // 0120: the map pin is placed before payment.
  return saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
}

/** The owner pays through the sandbox gateway; the webhook's after-commit step runs. */
async function payInSandbox(shopId: string, outcome: "SUCCESS" | "FAILURE" = "SUCCESS") {
  const checkout = await startRegistrationFeeCheckout(shopId, owner);
  await simulateSandboxCheckout({ ref: checkout.intentId, viewerId: owner.id, outcome });
  if (outcome === "SUCCESS") await finishFeeCapture(shopId, checkout.intentId);
  return checkout;
}

const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];
const verifications = async (shopId: string) => db.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, shopId));
const lastDecision = async (shopId: string) =>
  (await db.select().from(shopAutoApprovalLog).where(eq(shopAutoApprovalLog.shopId, shopId))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

describe("each step in the brief's order, resumed where the owner left off", () => {
  it("walks GSTIN → Udyam → FSSAI → details & turnover → review, and every answer says where to resume", async () => {
    expect(await getWizardDraft(owner)).toBeNull();
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    let view = (await getWizardDraft(owner))!;
    expect(view.nextStep).toBe("UDYAM");
    // The GST record filled in the shop name and address (edited later on the details step).
    expect(view.prefill.shopName).toBeTruthy();
    expect(view.prefill.address).toContain("Pune");
    // The admin's slab table is what the details step offers.
    expect(view.feeRule.slabs.length).toBeGreaterThan(0);

    view = await doc("UDYAM", UDYAM);
    expect(view.udyam).toMatchObject({ has: true, done: true, check: { status: "VERIFIED", message: null } });
    expect(view.udyam.check!.numberMasked).not.toBe(UDYAM);
    expect(view.nextStep).toBe("FSSAI");

    view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view.fssai).toMatchObject({ has: false, done: true, required: false });
    expect(view.nextStep).toBe("DETAILS");

    // A new session (another device) resumes at the same place.
    expect((await getWizardDraft({ id: owner.id }))!.nextStep).toBe("DETAILS");

    view = await saveDraftDetails({ actor: owner, details: details({ categoryIds: [] }) });
    // Owner brief 30 Oct 2026: straight to the fee; the map pin comes after payment.
    expect(view).toMatchObject({ nextStep: "REVIEW", foodShop: false, details: { shopType: "GENERAL_TRADING", pincode: "411001" } });
    expect(view.documents).toMatchObject({ missing: [], canSubmit: true, needsTeamApproval: false, promised: false });
  });

  it("refuses a later step before the GSTIN / PAN step is done, and payment before every step", async () => {
    await expect(saveDraftDetails({ actor: owner, details: details() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // GSTIN not found: the draft exists but cannot go on.
    await submitDraftGstin({ gstin: gstinFor("AABCG0000K"), consentGiven: true, actor: owner });
    await expect(saveDraftDetails({ actor: owner, details: details() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(doc("UDYAM", UDYAM)).rejects.toMatchObject({ code: "CONFLICT" });

    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await doc("UDYAM", UDYAM);
    await expect(submitDraftForPayment({ actor: owner })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "STEP_OPEN", nextStep: "FSSAI" } });
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
  });

  it("a pin outside India is refused", async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await expect(saveDraftLocation({ actor: owner, latitude: 51.5, longitude: -0.12 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("Udyam and FSSAI checks", () => {
  beforeEach(async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
  });

  it("not found at the source → FAILED with a message; the owner must correct it", async () => {
    const view = await doc("UDYAM", "UDYAM-MH-26-0010000");
    expect(view.udyam).toMatchObject({ done: false, check: { status: "FAILED", errorCode: "not_found_at_source" } });
    expect(view.udyam.check!.message).toMatch(/not found/);
    expect(view.nextStep).toBe("UDYAM");
  });

  it("an expired FSSAI licence → EXPIRED, cannot continue", async () => {
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    const view = await doc("FSSAI", "11521998008888");
    expect(view.fssai.check).toMatchObject({ status: "EXPIRED" });
    expect(view.fssai.check!.message).toMatch(/expired/);
    expect(view.nextStep).toBe("FSSAI");
  });

  it("government source down → PENDING, the owner may continue; a repeat within 30 s pays nothing", async () => {
    const view = await doc("UDYAM", "UDYAM-MH-26-0019999");
    expect(view.udyam).toMatchObject({ done: true, check: { status: "PENDING" } });
    expect(view.udyam.check!.message).toMatch(/keep checking/);
    expect(view.nextStep).toBe("FSSAI");
    const before = (await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id)))[0].checksInWindow;
    await doc("UDYAM", "UDYAM-MH-26-0019999");
    const after = (await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id)))[0].checksInWindow;
    expect(after).toBe(before);
  });

  it("a verified number submitted again is served from the stored result", async () => {
    await doc("UDYAM", UDYAM);
    const [row] = await db.select().from(shopRegistrationDraftChecks);
    await doc("UDYAM", UDYAM);
    const [again] = await db.select().from(shopRegistrationDraftChecks);
    expect(again.idempotencyKey).toBe(row.idempotencyKey);
  });

  it("a malformed number or no consent never reaches the vendor", async () => {
    await expect(doc("FSSAI", "12345")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(submitDraftDocument({ actor: owner, docType: "UDYAM", number: UDYAM, consentGiven: false })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await db.select().from(shopRegistrationDraftChecks)).toHaveLength(0);
  });

  it("numbers are stored as ciphertext and masked; the audit entry is masked", async () => {
    await doc("UDYAM", UDYAM);
    await doc("FSSAI", FSSAI);
    const stored = JSON.stringify(await db.select().from(shopRegistrationDraftChecks));
    expect(stored).not.toContain(UDYAM);
    expect(stored).not.toContain(FSSAI);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "shop_registration_draft.checked"));
    expect(JSON.stringify(audits)).not.toContain(FSSAI);
  });
});

describe("a food shop must give its FSSAI, and goes live only once it is verified", () => {
  it("FSSAI answered 'no', then a dairy chosen on the details step: sent back to FSSAI, no payment", async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    let view = await saveDraftDetails({ actor: owner, details: details({ shopType: "DAIRY" }) });
    expect(view).toMatchObject({ foodShop: true, fssai: { required: true, done: false }, nextStep: "FSSAI" });
    // "No" again does not get a food shop past the step.
    view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view.nextStep).toBe("FSSAI");
    await expect(submitDraftForPayment({ actor: owner })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "STEP_OPEN", nextStep: "FSSAI" } });
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
  });

  it("a dairy with GSTIN and FSSAI verified goes live after payment", async () => {
    await walkToReview({ shopType: "DAIRY", udyam: false });
    const view = await submitDraftForPayment({ actor: owner });
    await payInSandbox(view.shop!.id);
    expect(await shopRow(view.shop!.id)).toMatchObject({ status: "APPROVED", fssaiLicenseNumber: FSSAI, shopActNumber: null });
  });

  it("a dairy whose FSSAI check is still pending pays and waits for an admin — not live", async () => {
    await walkToReview({ shopType: "DAIRY", udyam: false, fssai: "11521998009999" });
    const view = await submitDraftForPayment({ actor: owner });
    expect(view.documents).toMatchObject({ missing: ["FSSAI"], needsTeamApproval: true });
    await payInSandbox(view.shop!.id);
    expect((await shopRow(view.shop!.id)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("WAITING");
    expect((await lastDecision(view.shop!.id)).reasons.join(" ")).toMatch(/FSSAI/);
  });
});

describe("auto-approval: GSTIN / PAN verified + fee paid (owner decision 29 Oct 2026, 'follow the brief')", () => {
  it("GSTIN verified + payment: copied to seller_verifications, live without the Shop Act, email sent, then map → categories → products", async () => {
    await walkToReview();
    const submitted = await submitDraftForPayment({ actor: owner });
    expect(submitted).toMatchObject({ status: "SUBMITTED", nextStep: "PAYMENT", shop: { status: "PENDING_APPROVAL", feePaymentStatus: "PENDING" } });
    expect(submitted.shop!.feeDuePaise).toBeGreaterThan(0);
    const shopId = submitted.shop!.id;

    const shop = await shopRow(shopId);
    expect(shop).toMatchObject({ ownerId: owner.id, name: "Test Seller Mart", pincode: "411001", latitude: "18.5308000", gstStatus: "REGISTERED", shopActNumber: null });
    expect(shop.gstin).toBe(gstinFor(COMPANY_PAN));
    expect(shop.documentsPromisedAt).toBeNull();
    // KYC complete on the GSTIN alone: only the fee is outstanding.
    expect(shop.lifecycleStatus).toBe("PAYMENT_PENDING");

    const rows = await verifications(shopId);
    const by = (t: string) => rows.find((r) => r.docType === t);
    expect(by("GSTIN")).toMatchObject({ status: "VERIFIED", providerId: "mock", reviewerId: null });
    expect(by("PAN")).toMatchObject({ status: "VERIFIED", providerId: "mock" });
    expect(by("UDYAM")).toMatchObject({ status: "VERIFIED" });
    expect(by("FSSAI")).toMatchObject({ status: "VERIFIED" });
    expect(by("SHOP_ACT")).toBeUndefined();
    for (const r of rows) {
      expect(r.numberEncrypted).toBeTruthy();
      expect(r.details).toMatchObject({ source: "ONBOARDING_WIZARD" });
    }
    expect(JSON.stringify(rows.map((r) => ({ ...r, numberEncrypted: null })))).not.toContain(COMPANY_PAN);
    expect(await db.select().from(shopDeferredDocumentReviews).where(eq(shopDeferredDocumentReviews.shopId, shopId))).toHaveLength(0);

    // Submitting again (a double tap) changes nothing.
    expect((await submitDraftForPayment({ actor: owner })).shop!.id).toBe(shopId);
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(1);

    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID", lifecycleStatus: "ACTIVE" });
    expect((await lastDecision(shopId))).toMatchObject({ outcome: "APPROVED" });
    expect((await lastDecision(shopId)).evidence).toMatchObject({ documentsMissing: [], gstin: { status: "VERIFIED", provider: "mock" } });
    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.shopId, shopId));
    expect(draft.status).toBe("COMPLETED");
    const [ready] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.ready_for_product_upload")));
    expect(ready.title).toMatch(/Registration successful/);

    // After approval: the map pin (placed before payment, 0120) is on the shop; then categories and the product list.
    let view = (await getWizardDraft(owner))!;
    expect(view).toMatchObject({ nextStep: "CATEGORY", setup: { location: true, categories: false, products: false } });
    await updateShop(shopId, { latitude: "18.5309", longitude: "73.8476" }, owner);
    view = (await getWizardDraft(owner))!;
    expect(view.nextStep).toBe("CATEGORY");
    await setShopCategories(shopId, [categoryId], owner);
    view = (await getWizardDraft(owner))!;
    expect(view).toMatchObject({ nextStep: "PRODUCTS", setup: { location: true, categories: true, products: false } });
  });

  it("the no-GSTIN route: PAN verified + declaration + payment → live automatically", async () => {
    const view = await walkToReview({ pan: PROPRIETOR_PAN, udyam: false, fssai: false });
    expect(view.documents).toMatchObject({ missing: [], canSubmit: true, needsTeamApproval: false });
    const submitted = await submitDraftForPayment({ actor: owner });
    const shopId = submitted.shop!.id;
    const rows = await verifications(shopId);
    expect(rows.find((r) => r.docType === "PAN")).toMatchObject({ status: "VERIFIED" });
    expect(rows.find((r) => r.docType === "GSTIN")).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "gst_declaration_review" });
    expect(await shopRow(shopId)).toMatchObject({ gstStatus: "NOT_REGISTERED", gstin: null });
    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED", lifecycleStatus: "ACTIVE" });
  });

  it("two taps at once (two tabs) create one shop, and both get the payment step", async () => {
    await walkToReview();
    const [a, b] = await Promise.all([submitDraftForPayment({ actor: owner }), submitDraftForPayment({ actor: owner })]);
    expect(a.shop!.id).toBe(b.shop!.id);
    expect([a.nextStep, b.nextStep]).toEqual(["PAYMENT", "PAYMENT"]);
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(1);
  });
});

describe("pending admin approval", () => {
  it("no payment: the shop is created but waits at the payment step, pending — and gets no orders (not live)", async () => {
    await walkToReview();
    const { shop } = await submitDraftForPayment({ actor: owner });
    expect(await shopRow(shop!.id)).toMatchObject({ status: "PENDING_APPROVAL", feePaymentStatus: "PENDING" });
    expect((await getWizardDraft(owner))!.nextStep).toBe("PAYMENT");
  });

  it("a failed payment leaves the shop pending at the payment step; a retry that succeeds makes it live", async () => {
    await walkToReview();
    const { shop } = await submitDraftForPayment({ actor: owner });
    await payInSandbox(shop!.id, "FAILURE");
    expect((await shopRow(shop!.id)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("PAYMENT");
    await payInSandbox(shop!.id);
    expect((await shopRow(shop!.id)).status).toBe("APPROVED");
  });

  it("GSTIN check still pending (government source down): may pay, then waits for an admin", async () => {
    const view = await walkToReview({ gstin: gstinFor("AABCG9999K") });
    expect(view.documents).toMatchObject({ canSubmit: true, missing: ["GSTIN"], needsTeamApproval: true });
    const { shop } = await submitDraftForPayment({ actor: owner });
    await payInSandbox(shop!.id);
    expect((await shopRow(shop!.id)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("WAITING");
    expect((await lastDecision(shop!.id)).reasons.join(" ")).toMatch(/GSTIN/);
  });

  it("a PAN name that does not match on the no-GSTIN route goes to review: may pay, then waits for an admin", async () => {
    const view = await walkToReview({ pan: "ABCPK7777L", udyam: false, fssai: false, ownerName: "Ramesh Kulkarni" });
    expect(view.documents).toMatchObject({ canSubmit: true, missing: ["PAN"] });
    const { shop } = await submitDraftForPayment({ actor: owner });
    expect((await verifications(shop!.id)).find((r) => r.docType === "PAN")).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "name_mismatch" });
    await payInSandbox(shop!.id);
    expect((await shopRow(shop!.id)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("WAITING");
  });
});

describe("referral code toggle (Admin → Referral settings, default optional)", () => {
  it("optional by default: no code is fine; mandatory: the details step asks for one; back to optional works", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const adminActor = { id: admin.id, role: "ADMIN" as const, email: admin.email };
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect((await saveDraftDetails({ actor: owner, details: details() })).nextStep).toBe("REVIEW");

    await setReferralSetting("referral_required_shop", "MANDATORY", adminActor);
    await expect(saveDraftDetails({ actor: owner, details: details() })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { referralCode: expect.stringMatching(/referral code is required/) } },
    });
    // Only an admin may switch it.
    await expect(setReferralSetting("referral_required_shop", "OPTIONAL", { id: owner.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await setReferralSetting("referral_required_shop", "OPTIONAL", adminActor);
    expect((await saveDraftDetails({ actor: owner, details: details() })).nextStep).toBe("REVIEW");
  });
});

describe("a shop outside the wizard: the fee waits for a verified document too", () => {
  it("no document → refused; PAN verified but the rest missing → refused until the promise; then paid but pending", async () => {
    const shop = await registerShop(
      { name: "Old Form Mart", ownerName: "Test Seller", phone: "9123456781", addressLine1: "2 Form Road", city: "Pune", pincode: "411001", shopType: "GENERAL_TRADING", annualTurnoverRupees: 15_00_000, shopActNumber: SHOP_ACT },
      owner,
    );
    await expect(startRegistrationFeeCheckout(shop.id, owner)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "NO_VERIFIED_DOCUMENT" } });
    await expect(promiseShopDocuments(shop.id, owner)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "NO_VERIFIED_DOCUMENT" } });

    await submitSellerDocument({ shopId: shop.id, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor: owner });
    await submitSellerDocument({ shopId: shop.id, docType: "SHOP_ACT", number: SHOP_ACT, consentGiven: true, actor: owner });
    await expect(startRegistrationFeeCheckout(shop.id, owner)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DOCUMENTS_MISSING" } });
    const gate = await shopDocumentGate(await shopRow(shop.id));
    expect(gate).toMatchObject({ verified: ["PAN"], canPay: false, canPromise: true });
    expect(gate.missing.sort()).toEqual(["GSTIN", "SHOP_ACT"]);

    const stranger = await createUser({ role: "CUSTOMER" });
    await expect(promiseShopDocuments(shop.id, { id: stranger.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const promised = await promiseShopDocuments(shop.id, owner);
    expect(promised).toMatchObject({ canPay: true, canPromise: false });
    const again = await promiseShopDocuments(shop.id, owner);
    expect(again.promisedAt!.getTime()).toBe(promised.promisedAt!.getTime());

    await payInSandbox(shop.id);
    const row = await shopRow(shop.id);
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(row.lifecycleStatus).toBe("KYC_PENDING");
  });
});

/** Switches the wizard flag, as an admin does on Admin → Feature flags. */
async function setWizardFlag(enabled: boolean) {
  const a = await createUser({ role: "ADMIN" });
  await setFeatureFlag("shop_onboarding_wizard_enabled", { enabled, districtCodes: null }, "wizard flag (test)", { id: a.id, email: a.email, role: "ADMIN" });
}

describe("HTTP routes", () => {
  const signIn = () => {
    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: "CUSTOMER", status: "ACTIVE" } };
  };

  it("GET resumes the wizard; documents and submit answer with the next step; signed-out is refused", async () => {
    await setWizardFlag(true);
    expect((await call(draftRoute, "/api/shops/registration-draft")).status).toBe(401);
    signIn();
    expect((await call(draftRoute, "/api/shops/registration-draft")).body).toBeNull();
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });

    const no = await call(documentsRoute, "/api/shops/registration-draft/documents", { method: "POST", body: { docType: "UDYAM", has: false } });
    expect(no.status).toBe(200);
    expect(no.body.nextStep).toBe("FSSAI");
    const noConsent = await call(documentsRoute, "/api/shops/registration-draft/documents", { method: "POST", body: { docType: "FSSAI", number: FSSAI } });
    expect(noConsent.status).toBe(422);
    const fssai = await call(documentsRoute, "/api/shops/registration-draft/documents", { method: "POST", body: { docType: "FSSAI", number: FSSAI, consent: true } });
    expect(fssai.body.fssai.check.status).toBe("VERIFIED");
    expect(JSON.stringify(fssai.body)).not.toContain(FSSAI);

    const early = await call(submitRoute, "/api/shops/registration-draft/submit", { method: "POST" });
    expect(early.status).toBe(409);
    const resumed = await call(draftRoute, "/api/shops/registration-draft");
    expect(resumed.body.nextStep).toBe("DETAILS");
    const saved = await call(detailsRoute, "/api/shops/registration-draft/details", { method: "POST", body: { ...details(), categoryIds: undefined } });
    expect(saved.status).toBe(200);
    expect(saved.body.nextStep).toBe("REVIEW");
    // A pin may still be saved on the draft (a draft from before 30 Oct 2026); it does not change the step.
    const pinned = await call(locationRoute, "/api/shops/registration-draft/location", { method: "POST", body: { latitude: 18.5308, longitude: 73.8475 } });
    expect(pinned.body.nextStep).toBe("REVIEW");
  });
});

describe("who may use the wizard (shop_onboarding_wizard_enabled)", () => {
  const as = (user: { id: string; email: string; name: string | null }, role: UserRole) => {
    state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
  };
  const routes = [
    () => call(detailsRoute, "/api/shops/registration-draft/details", { method: "POST", body: details() }),
    () => call(documentsRoute, "/api/shops/registration-draft/documents", { method: "POST", body: { docType: "UDYAM", has: false } }),
    () => call(locationRoute, "/api/shops/registration-draft/location", { method: "POST", body: { latitude: 18.53, longitude: 73.85 } }),
    () => call(submitRoute, "/api/shops/registration-draft/submit", { method: "POST" }),
  ];

  it("flag off, not an admin: ?wizard=1 shows the long form and every wizard step is refused (404), nothing saved", async () => {
    await setWizardFlag(false);
    expect(await showsWizard(owner, { wizard: "1" })).toBe(false);
    expect(await showsWizard(owner, {})).toBe(false);
    expect(await showsWizard({ role: "OPERATOR" }, { wizard: "1" })).toBe(false);
    expect(await wizardAvailableFor(owner)).toBe(false);
    await expect(requireWizardAvailable(owner)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    as(owner, "CUSTOMER");
    for (const r of routes) {
      const res = await r();
      expect(res.status).toBe(404);
      expect(res.body.error.details.reason).toBe("FEATURE_NOT_AVAILABLE");
    }
    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    expect(draft.details).not.toHaveProperty("name");
    expect(draft.status).toBe("OPEN");
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
  });

  it("flag off, not an admin: the step-1 GSTIN and PAN checks are refused too, before any government call (D-106)", async () => {
    await setWizardFlag(false);
    let sourceCalls = 0;
    const mock = createMockAdapter();
    setKycAdapterForTests({ ...mock, verify: async (req) => ((sourceCalls += 1), mock.verify(req)) });
    as(owner, "CUSTOMER");
    const gst = await call(gstinRoute, "/api/shops/registration-draft/gstin", { method: "POST", body: { gstin: gstinFor(COMPANY_PAN), consent: true } });
    const pan = await call(panRoute, "/api/shops/registration-draft/pan", { method: "POST", body: { pan: PROPRIETOR_PAN, declaration: true, consent: true } });
    for (const res of [gst, pan]) {
      expect(res.status).toBe(404);
      expect(res.body.error.details.reason).toBe("FEATURE_NOT_AVAILABLE");
    }
    expect(sourceCalls).toBe(0);
    expect(await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id))).toHaveLength(0);

    // An admin may still use them while the flag is off.
    const a = await createUser({ role: "ADMIN" });
    as({ id: a.id, email: a.email, name: a.name ?? null }, "ADMIN");
    const allowed = await call(gstinRoute, "/api/shops/registration-draft/gstin", { method: "POST", body: { gstin: gstinFor(COMPANY_PAN), consent: true } });
    expect(allowed.status).toBe(200);
    expect(sourceCalls).toBeGreaterThan(0);
  });

  it("flag off, an admin: ?wizard=1 opens the wizard (without it, the long form) and the steps work", async () => {
    await setWizardFlag(false);
    const a = await createUser({ role: "ADMIN" });
    const admin = { id: a.id, email: a.email, name: a.name ?? null, role: "ADMIN" as const };
    expect(await showsWizard(admin, { wizard: "1" })).toBe(true);
    expect(await showsWizard(admin, {})).toBe(false);
    expect(await showsWizard(admin, { wizard: "1", form: "1" })).toBe(false);

    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: admin });
    as(admin, "ADMIN");
    const saved = await routes[0]();
    expect(saved.status).toBe(200);
    expect(saved.body.nextStep).toBe("UDYAM");
    const udyam = await routes[1]();
    expect(udyam.status).toBe(200);
    expect(udyam.body.nextStep).toBe("FSSAI");
  });

  it("flag on: everyone gets the wizard (?form=1 still the long form) and the steps work", async () => {
    await setWizardFlag(true);
    expect(await showsWizard(owner, {})).toBe(true);
    expect(await showsWizard(owner, { wizard: "1" })).toBe(true);
    expect(await showsWizard(owner, { form: "1" })).toBe(false);
    expect(await wizardAvailableFor(owner)).toBe(true);

    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    as(owner, "CUSTOMER");
    const saved = await routes[0]();
    expect(saved.status).toBe(200);
    expect(saved.body.nextStep).toBe("UDYAM");
  });
});
