/**
 * Onboarding wizard step 2 (docs/shop-onboarding-wizard-2026-10): after the
 * GSTIN / PAN step — shop details, Udyam, FSSAI, Shop Act, the map pin, then
 * the shop created from the draft and paid for.
 *
 *   - each step with its check statuses and "may continue", resumed where left
 *   - draft → shop: GSTIN, PAN, Udyam, FSSAI and Shop Act copied to
 *     seller_verifications with the vendor's reference; numbers never in clear
 *   - payment (sandbox gateway) → live in a district the instant-approval flag
 *     does not cover (owner decision B), Shop Act left for an admin's review,
 *     onboarding complete, "ready for product upload" email
 *   - the no-GSTIN route: PAN + declaration → live, declaration in review
 *   - a food shop cannot skip FSSAI; FSSAI not yet verified holds the approval
 *   - failures: not found, expired, vendor down, steps out of order, a pin
 *     outside India, a failed payment, a shop outside the wizard keeps today's rule
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
import { POST as documentsRoute } from "@/app/api/shops/registration-draft/documents/route";
import { POST as gstinRoute } from "@/app/api/shops/registration-draft/gstin/route";
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
import { setFeatureFlag } from "@/server/services/feature-flags";
import { finishFeeCapture } from "@/server/services/operator-limited";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { submitSellerDocument } from "@/server/services/seller-verification";
import { clearRuleCache } from "@/server/services/settings";
import { promiseShopDocuments, shopDocumentGate } from "@/server/services/shop-document-gate";
import { submitDraftGstin, submitDraftPan } from "@/server/services/shop-registration-draft";
import {
  answerDraftDocument,
  getWizardDraft,
  saveDraftDetails,
  saveDraftLocation,
  submitDraftDocument,
  submitDraftForPayment,
  type DraftShopDetails,
} from "@/server/services/shop-registration-wizard";
import { registerShop } from "@/server/services/shops";
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
/** A Shop Act the mock vendor can check: VERIFIED. */
const SHOP_ACT_OK = "KA/SHOP/2026/2222";

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

/** GSTIN → details → Udyam → FSSAI → Shop Act → pin: everything before payment. */
async function walkToReview(opts: { shopType?: string; fssai?: string | false; udyam?: string | false; shopAct?: string; pan?: boolean } = {}) {
  if (opts.pan) await submitDraftPan({ pan: PROPRIETOR_PAN, declarationAccepted: true, consentGiven: true, actor: owner });
  else await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
  await saveDraftDetails({ actor: owner, details: details({ shopType: opts.shopType ?? "GENERAL_TRADING" }) });
  if (opts.udyam === false) await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
  else await doc("UDYAM", opts.udyam ?? UDYAM);
  if (opts.fssai === false) await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
  else await doc("FSSAI", opts.fssai ?? FSSAI);
  await doc("SHOP_ACT", opts.shopAct ?? SHOP_ACT);
  return saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475, address: "Shivajinagar, Pune" });
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

describe("each step, resumed where the owner left off", () => {
  it("walks GSTIN → details → Udyam → FSSAI → Shop Act → map → review, and every answer says where to resume", async () => {
    expect(await getWizardDraft(owner)).toBeNull();
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    let view = (await getWizardDraft(owner))!;
    expect(view.nextStep).toBe("DETAILS");
    // The details step starts from the GST record.
    expect(view.prefill.shopName).toBeTruthy();
    expect(view.prefill.address).toContain("Pune");

    view = await saveDraftDetails({ actor: owner, details: details() });
    expect(view).toMatchObject({ nextStep: "UDYAM", foodShop: false, details: { shopType: "GENERAL_TRADING", pincode: "411001" } });

    view = await doc("UDYAM", UDYAM);
    expect(view.udyam).toMatchObject({ has: true, done: true, check: { status: "VERIFIED", message: null } });
    expect(view.udyam.check!.numberMasked).not.toBe(UDYAM);
    expect(view.nextStep).toBe("FSSAI");

    view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view.fssai).toMatchObject({ has: false, done: true, required: false });
    expect(view.nextStep).toBe("SHOP_ACT");

    // Maharashtra has no online Shop Act check: an admin reviews it, and the owner carries on.
    view = await doc("SHOP_ACT", SHOP_ACT);
    expect(view.shopAct).toMatchObject({ done: true, check: { status: "MANUAL_REVIEW", errorCode: "vendor_unsupported" } });
    expect(view.shopAct.check!.message).toMatch(/upload your Shop Act certificate/);
    expect(view.nextStep).toBe("LOCATION");

    // A new session (another device) resumes at the same place.
    expect((await getWizardDraft({ id: owner.id }))!.nextStep).toBe("LOCATION");

    view = await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475, address: "Shivajinagar, Pune" });
    expect(view.location).toEqual({ latitude: "18.5308000", longitude: "73.8475000", address: "Shivajinagar, Pune" });
    expect(view.nextStep).toBe("REVIEW");
  });

  it("refuses a later step before the GSTIN / PAN step is done, and payment before every step", async () => {
    await expect(saveDraftDetails({ actor: owner, details: details() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // GSTIN not found: the draft exists but cannot go on.
    await submitDraftGstin({ gstin: gstinFor("AABCG0000K"), consentGiven: true, actor: owner });
    await expect(saveDraftDetails({ actor: owner, details: details() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(doc("UDYAM", UDYAM)).rejects.toMatchObject({ code: "CONFLICT" });

    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details() });
    await expect(submitDraftForPayment({ actor: owner })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "STEP_OPEN", nextStep: "UDYAM" } });
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
  });

  it("a pin outside India is refused", async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await expect(saveDraftLocation({ actor: owner, latitude: 51.5, longitude: -0.12 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("Udyam, FSSAI and Shop Act checks", () => {
  beforeEach(async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details() });
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

  it("a Shop Act the source can check is VERIFIED, and the step is done", async () => {
    const view = await doc("SHOP_ACT", SHOP_ACT_OK);
    expect(view.shopAct.check).toMatchObject({ status: "VERIFIED" });
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

describe("a food shop may promise FSSAI, but is not approved without it", () => {
  it("a dairy answers FSSAI 'not now': the review lists it missing and asks for the 30-day promise", async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    let view = await saveDraftDetails({ actor: owner, details: details({ shopType: "DAIRY" }) });
    expect(view).toMatchObject({ foodShop: true, fssai: { has: true, required: true, done: false } });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view).toMatchObject({ fssai: { has: false, required: true, done: true }, nextStep: "SHOP_ACT" });
    await doc("SHOP_ACT", SHOP_ACT_OK);
    view = await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
    expect(view.documents).toMatchObject({ missing: ["FSSAI"], inReview: [], canSubmit: true, needsTeamApproval: true, promised: false, promiseDays: 30 });
    expect(view.documents.verified.sort()).toEqual(["GSTIN", "PAN", "SHOP_ACT"]);

    await expect(submitDraftForPayment({ actor: owner })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "DOCUMENTS_PROMISE_REQUIRED", missing: ["FSSAI"] },
    });
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);

    const submitted = await submitDraftForPayment({ actor: owner, promiseDocuments: true });
    const shopId = submitted.shop!.id;
    await payInSandbox(shopId);
    const shop = await shopRow(shopId);
    expect(shop).toMatchObject({ status: "PENDING_APPROVAL", fssaiLicenseNumber: null });
    expect(shop.documentsPromisedAt).not.toBeNull();
    expect((await getWizardDraft(owner))!.nextStep).toBe("WAITING");
  });

  it("a food shop answering FSSAI 'no' as a general shop, then switching to dairy, is sent back to FSSAI", async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details() });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    const view = await saveDraftDetails({ actor: owner, details: details({ shopType: "BAKERY" }) });
    expect(view.nextStep).toBe("FSSAI");
  });

  it("a dairy with every document verified goes live after payment", async () => {
    await walkToReview({ shopType: "DAIRY", udyam: false, shopAct: SHOP_ACT_OK });
    const view = await submitDraftForPayment({ actor: owner });
    await payInSandbox(view.shop!.id);
    const shop = await shopRow(view.shop!.id);
    expect(shop).toMatchObject({ status: "APPROVED", fssaiLicenseNumber: FSSAI, documentsPromisedAt: null });
    // The Shop Act number reaches the shop as the owner typed it.
    expect(shop.shopActNumber).toBe(SHOP_ACT_OK);
  });

  it("a dairy whose FSSAI check is still pending promises it, pays, and waits — not live", async () => {
    await walkToReview({ shopType: "DAIRY", udyam: false, fssai: "11521998009999", shopAct: SHOP_ACT_OK });
    const view = await submitDraftForPayment({ actor: owner, promiseDocuments: true });
    await payInSandbox(view.shop!.id);
    expect((await shopRow(view.shop!.id)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("WAITING");
    const [log] = await db.select().from(shopAutoApprovalLog).where(eq(shopAutoApprovalLog.shopId, view.shop!.id));
    expect(log.reasons.join(" ")).toMatch(/FSSAI/);
  });
});

describe("draft → shop → payment (owner decision 29 Oct 2026: documents before the fee)", () => {
  it("every document verified: copies every check to seller_verifications, then goes live after the sandbox payment", async () => {
    await walkToReview({ shopAct: SHOP_ACT_OK });
    expect((await getWizardDraft(owner))!.documents).toMatchObject({ missing: [], needsTeamApproval: false });
    const submitted = await submitDraftForPayment({ actor: owner });
    expect(submitted).toMatchObject({ status: "SUBMITTED", nextStep: "PAYMENT", shop: { status: "PENDING_APPROVAL", feePaymentStatus: "PENDING" } });
    expect(submitted.shop!.feeDuePaise).toBeGreaterThan(0);
    const shopId = submitted.shop!.id;

    // The shop as the details step and the GST record described it.
    const shop = await shopRow(shopId);
    expect(shop).toMatchObject({ ownerId: owner.id, name: "Test Seller Mart", pincode: "411001", latitude: "18.5308000", gstStatus: "REGISTERED", gstVerificationSource: "PROVIDER_VERIFIED" });
    expect(shop.gstin).toBe(gstinFor(COMPANY_PAN));
    expect(shop.lifecycleStatus).toBe("PAYMENT_PENDING");
    expect(shop.documentsPromisedAt).toBeNull();

    const rows = await verifications(shopId);
    const by = (t: string) => rows.find((r) => r.docType === t)!;
    expect(by("GSTIN")).toMatchObject({ status: "VERIFIED", providerId: "mock", reviewerId: null });
    expect(by("GSTIN").providerRef).toMatch(/^mock-/);
    expect(by("PAN")).toMatchObject({ status: "VERIFIED", providerId: "mock" });
    expect(by("UDYAM")).toMatchObject({ status: "VERIFIED", providerId: "mock" });
    expect(by("FSSAI")).toMatchObject({ status: "VERIFIED" });
    expect(by("SHOP_ACT")).toMatchObject({ status: "VERIFIED" });
    for (const r of rows) {
      expect(r.numberEncrypted).toBeTruthy();
      expect(r.consentVersion).toBeTruthy();
      expect(r.details).toMatchObject({ source: "ONBOARDING_WIZARD" });
    }
    expect(JSON.stringify(rows.map((r) => ({ ...r, numberEncrypted: null })))).not.toContain(COMPANY_PAN);
    // Nothing goes live "for review later" any more.
    expect(await db.select().from(shopDeferredDocumentReviews).where(eq(shopDeferredDocumentReviews.shopId, shopId))).toHaveLength(0);

    // Submitting again (a double tap) changes nothing.
    const again = await submitDraftForPayment({ actor: owner });
    expect(again.shop!.id).toBe(shopId);
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(1);

    await payInSandbox(shopId);
    const live = await shopRow(shopId);
    expect(live).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID", lifecycleStatus: "ACTIVE" });

    const [log] = await db.select().from(shopAutoApprovalLog).where(and(eq(shopAutoApprovalLog.shopId, shopId), eq(shopAutoApprovalLog.outcome, "APPROVED")));
    expect(log.evidence).toMatchObject({ documentsMissing: [], gstin: { status: "VERIFIED", provider: "mock" } });

    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.shopId, shopId));
    expect(draft.status).toBe("COMPLETED");
    expect(draft.completedAt).not.toBeNull();
    expect((await getWizardDraft(owner))!.nextStep).toBe("DONE");

    const [ready] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.ready_for_product_upload")));
    expect(ready.title).toMatch(/Registration successful/);
  });

  it("Shop Act still in review: payment needs the 30-day promise, then the shop waits for GoKesari's team", async () => {
    const view = await walkToReview();
    expect(view.documents).toMatchObject({ missing: ["SHOP_ACT"], canSubmit: true, needsTeamApproval: true });
    await expect(submitDraftForPayment({ actor: owner })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "DOCUMENTS_PROMISE_REQUIRED" } });

    const before = Date.now();
    const submitted = await submitDraftForPayment({ actor: owner, promiseDocuments: true });
    const shopId = submitted.shop!.id;
    const shop = await shopRow(shopId);
    expect(shop.documentsPromisedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const days = (shop.documentsDueAt!.getTime() - shop.documentsPromisedAt!.getTime()) / 86_400_000;
    expect(days).toBe(30);
    expect((await verifications(shopId)).find((r) => r.docType === "SHOP_ACT")).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "vendor_unsupported" });
    expect(await db.select().from(shopDeferredDocumentReviews).where(eq(shopDeferredDocumentReviews.shopId, shopId))).toHaveLength(0);
    const [promise] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "shop.documents_promised"), eq(auditLogs.entityId, shopId)));
    expect(promise.newValue).toMatchObject({ missing: ["SHOP_ACT"], source: "ONBOARDING_WIZARD" });
    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.shopId, shopId));
    expect(draft.documentsPromisedAt).not.toBeNull();
    expect((await getWizardDraft(owner))!.documents.promised).toBe(true);

    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "PENDING_APPROVAL", feePaymentStatus: "PAID" });
    expect((await getWizardDraft(owner))!.nextStep).toBe("WAITING");
  });

  it("Shop Act 'I don't have it now' after a checked number: the number is dropped and promised instead", async () => {
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details() });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    await doc("SHOP_ACT", SHOP_ACT_OK);
    let view = await answerDraftDocument({ actor: owner, docType: "SHOP_ACT", has: false });
    expect(view).toMatchObject({ shopAct: { has: false, done: true }, nextStep: "LOCATION" });
    view = await saveDraftLocation({ actor: owner, latitude: 18.53, longitude: 73.84 });
    expect(view.documents.missing).toEqual(["SHOP_ACT"]);
    const submitted = await submitDraftForPayment({ actor: owner, promiseDocuments: true });
    expect((await shopRow(submitted.shop!.id)).shopActNumber).toBeNull();
    expect((await verifications(submitted.shop!.id)).map((r) => r.docType)).not.toContain("SHOP_ACT");
  });

  it("no verified document at all: payment is refused even with the promise", async () => {
    // PAN name does not match the owner (manual review), and the Shop Act cannot be checked online.
    await submitDraftPan({ pan: "ABCPK7777L", declarationAccepted: true, consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details({ ownerName: "Ramesh Kulkarni", name: "Kulkarni Stores" }) });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    await doc("SHOP_ACT", SHOP_ACT);
    const view = await saveDraftLocation({ actor: owner, latitude: 18.53, longitude: 73.84 });
    expect(view.documents).toMatchObject({ verified: [], canSubmit: false });
    await expect(submitDraftForPayment({ actor: owner, promiseDocuments: true })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "NO_VERIFIED_DOCUMENT" },
    });
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
  });

  it("two taps at once (two tabs) create one shop, and both get the payment step", async () => {
    await walkToReview({ shopAct: SHOP_ACT_OK });
    const [a, b] = await Promise.all([submitDraftForPayment({ actor: owner }), submitDraftForPayment({ actor: owner })]);
    expect(a.shop!.id).toBe(b.shop!.id);
    expect([a.nextStep, b.nextStep]).toEqual(["PAYMENT", "PAYMENT"]);
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(1);
  });

  it("the no-GSTIN route: PAN + declaration needs no promise, but the declaration waits for review", async () => {
    const view = await walkToReview({ pan: true, udyam: false, fssai: false, shopAct: SHOP_ACT_OK });
    expect(view.documents).toMatchObject({ missing: [], inReview: ["GSTIN"], needsTeamApproval: true });
    const submitted = await submitDraftForPayment({ actor: owner });
    const shopId = submitted.shop!.id;
    const rows = await verifications(shopId);
    expect(rows.find((r) => r.docType === "GSTIN")).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "gst_declaration_review", details: { declaredNotRegistered: true } });
    expect(rows.find((r) => r.docType === "PAN")).toMatchObject({ status: "VERIFIED" });
    expect(await shopRow(shopId)).toMatchObject({ gstStatus: "NOT_REGISTERED", documentsPromisedAt: null });

    await payInSandbox(shopId);
    expect((await shopRow(shopId)).status).toBe("PENDING_APPROVAL");
  });

  it("a PAN name that does not match the owner on the no-GSTIN route is promised and waits for an admin", async () => {
    await submitDraftPan({ pan: "ABCPK7777L", declarationAccepted: true, consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details({ ownerName: "Ramesh Kulkarni", name: "Kulkarni Stores" }) });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    await doc("SHOP_ACT", SHOP_ACT_OK);
    await saveDraftLocation({ actor: owner, latitude: 18.53, longitude: 73.84 });
    const submitted = await submitDraftForPayment({ actor: owner, promiseDocuments: true });
    const pan = (await verifications(submitted.shop!.id)).find((r) => r.docType === "PAN")!;
    expect(pan).toMatchObject({ status: "MANUAL_REVIEW", lastErrorCode: "name_mismatch" });
    await payInSandbox(submitted.shop!.id);
    expect((await shopRow(submitted.shop!.id)).status).toBe("PENDING_APPROVAL");
  });

  it("a failed payment leaves the shop pending at the payment step; a retry that succeeds makes it live", async () => {
    await walkToReview({ shopAct: SHOP_ACT_OK });
    const { shop } = await submitDraftForPayment({ actor: owner });
    await payInSandbox(shop!.id, "FAILURE");
    expect((await shopRow(shop!.id)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("PAYMENT");
    await payInSandbox(shop!.id);
    expect((await shopRow(shop!.id)).status).toBe("APPROVED");
  });

  it("a Shop Act licence registered meanwhile by someone else stops the shop being created", async () => {
    await walkToReview();
    const other = await createUser({ role: "CUSTOMER" });
    await registerShop(
      { name: "Other Mart", ownerName: "Other", phone: "9123456780", addressLine1: "1 Other Road", city: "Pune", pincode: "411001", shopType: "GENERAL_TRADING", shopActNumber: SHOP_ACT, annualTurnoverRupees: 15_00_000 },
      { id: other.id, role: "CUSTOMER" },
    );
    await expect(submitDraftForPayment({ actor: owner, promiseDocuments: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
    expect((await getWizardDraft(owner))!.status).toBe("OPEN");
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

    // Only the owner may promise.
    const stranger = await createUser({ role: "CUSTOMER" });
    await expect(promiseShopDocuments(shop.id, { id: stranger.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const promised = await promiseShopDocuments(shop.id, owner);
    expect(promised).toMatchObject({ canPay: true, canPromise: false });
    // A second tick keeps the first date.
    const again = await promiseShopDocuments(shop.id, owner);
    expect(again.promisedAt!.getTime()).toBe(promised.promisedAt!.getTime());

    await payInSandbox(shop.id);
    const row = await shopRow(shop.id);
    expect(row.status).toBe("PENDING_APPROVAL");
    expect(row.lifecycleStatus).toBe("KYC_PENDING");
  });
});

describe("HTTP routes", () => {
  const signIn = () => {
    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: "CUSTOMER", status: "ACTIVE" } };
  };
  const wizardFlag = async (enabled: boolean) => {
    const admin = await createUser({ role: "ADMIN" });
    await setFeatureFlag("shop_onboarding_wizard_enabled", { enabled, districtCodes: null }, "wizard test", { id: admin.id, role: "ADMIN" });
  };

  it("with the wizard switched off every wizard route answers 404, whatever the URL", async () => {
    signIn();
    const off = await call(draftRoute, "/api/shops/registration-draft");
    expect(off.status).toBe(404);
    expect(off.body.error.details).toMatchObject({ reason: "FEATURE_NOT_AVAILABLE", feature: "shop_onboarding_wizard_enabled" });
    expect((await call(documentsRoute, "/api/shops/registration-draft/documents", { method: "POST", body: { docType: "UDYAM", has: false } })).status).toBe(404);
    expect((await call(submitRoute, "/api/shops/registration-draft/submit", { method: "POST" })).status).toBe(404);
    expect((await call(gstinRoute, "/api/shops/registration-draft/gstin", { method: "POST", body: { gstin: gstinFor(COMPANY_PAN), consent: true } })).status).toBe(404);
    // Nothing was checked with the vendor or stored.
    expect(await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id))).toHaveLength(0);
  });

  it("GET resumes the wizard; documents and submit answer with the next step; signed-out is refused", async () => {
    await wizardFlag(true);
    expect((await call(draftRoute, "/api/shops/registration-draft")).status).toBe(401);
    signIn();
    expect((await call(draftRoute, "/api/shops/registration-draft")).body).toBeNull();
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await saveDraftDetails({ actor: owner, details: details() });

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
    expect(resumed.body.nextStep).toBe("SHOP_ACT");
  });
});
