/**
 * Shop registration flow (owner brief, 30 Oct 2026; docs/shop-onboarding-wizard-2026-10/FLOW_2026-10-30.md,
 * migration 0120). Runs on both database layouts.
 *
 *   - a new registration opens with the referral code (mandatory / optional by the admin's
 *     setting), then the shop's email (the account's, or another one confirmed with an emailed
 *     code), then "Do you have your documents handy?"
 *   - Yes → the GSTIN / PAN checks as before, then shop details → map pin → payment
 *   - No, "upload later" → shop details → (FSSAI for a food shop) → map pin → payment → live, with
 *     no GSTIN / PAN; payouts held until the GSTIN or PAN is verified
 *   - a draft started before 0120 skips the new first steps
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
  outbox: [] as { to: string; subject: string; text: string }[],
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { POST as documentsReadyRoute } from "@/app/api/shops/registration-draft/documents-ready/route";
import { POST as emailRoute } from "@/app/api/shops/registration-draft/email/route";
import { POST as referralRoute } from "@/app/api/shops/registration-draft/referral/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { sellerVerifications, shopAutoApprovalLog, shopCategories, shopRegistrationDrafts, shopSettlements, shops } from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { decideShopSettlement } from "@/server/services/finance";
import { finishFeeCapture } from "@/server/services/operator-limited";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { setReferralSetting } from "@/server/services/referral-settings";
import { submitSellerDocument } from "@/server/services/seller-verification";
import { clearRuleCache } from "@/server/services/settings";
import { payoutHoldReason } from "@/server/services/shop-onboarding";
import { submitDraftGstin } from "@/server/services/shop-registration-draft";
import {
  answerDocumentsReady,
  answerDraftDocument,
  answerDraftReferral,
  confirmDraftEmailCode,
  getWizardDraft,
  requestDraftEmailCode,
  saveDraftDetails,
  saveDraftLocation,
  submitDraftDocument,
  submitDraftForPayment,
  useAccountEmailForShop,
  type DraftShopDetails,
} from "@/server/services/shop-registration-wizard";
import { createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const FSSAI = "11521998000123";

let owner: { id: string; role: "CUSTOMER"; email: string; name: string | null };
let admin: { id: string; role: "ADMIN"; email: string };

beforeEach(async () => {
  state.session = null;
  state.outbox = [];
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  setKycAdapterForTests(createMockAdapter());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN", email: a.email };
  await setRegistrationFee({ amountPaise: 99_900 }, admin);
  const u = await createUser({ role: "CUSTOMER" });
  owner = { id: u.id, role: "CUSTOMER", email: u.email, name: u.name ?? null };
  const tag = randomUUID().slice(0, 8);
  await db.insert(shopCategories).values({ name: `Flow test ${tag}`, slug: `flow-test-${tag}` });
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

function details(overrides: Partial<DraftShopDetails> = {}): DraftShopDetails {
  return {
    name: "Later Docs Kirana",
    ownerName: "Test Seller",
    phone: `97${String(Date.now()).slice(-8)}`,
    email: null,
    shopType: "GENERAL_TRADING",
    categoryIds: [],
    annualTurnoverRupees: 15_00_000,
    couponCode: null,
    referralCode: null,
    employeeId: null,
    addressLine1: "Shop No 7, Station Road",
    addressLine2: null,
    area: "Shivajinagar",
    city: "Pune",
    state: "Maharashtra",
    pincode: "411001",
    landmark: null,
    ...overrides,
  };
}

const lastCodeTo = (email: string) => {
  const message = [...state.outbox].reverse().find((m) => m.to === email);
  const code = message?.subject.match(/^(\d{4,8}) /)?.[1];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
};

async function payInSandbox(shopId: string) {
  const checkout = await startRegistrationFeeCheckout(shopId, owner);
  await simulateSandboxCheckout({ ref: checkout.intentId, viewerId: owner.id, outcome: "SUCCESS" });
  await finishFeeCapture(shopId, checkout.intentId);
}

const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];

/** Referral (none) → the account's email → the documents answer. */
async function start(later: boolean) {
  await answerDraftReferral({ actor: owner, referralCode: null });
  await useAccountEmailForShop({ actor: owner });
  return answerDocumentsReady({ actor: owner, later });
}

describe("the new first steps: referral code, shop email, documents handy?", () => {
  it("a new registration starts at the referral code, then the email, then the documents question", async () => {
    let view = await answerDraftReferral({ actor: owner, referralCode: null });
    expect(view).toMatchObject({ nextStep: "EMAIL", referral: { answered: true, code: null, required: false }, email: { account: owner.email, confirmed: false } });
    view = await useAccountEmailForShop({ actor: owner });
    expect(view).toMatchObject({ nextStep: "DOCS_READY", email: { shop: owner.email, confirmed: true }, documentsLater: null });
    view = await answerDocumentsReady({ actor: owner, later: false });
    expect(view).toMatchObject({ nextStep: "IDENTITY", documentsLater: false });
    // Resumed on another device at the same place.
    expect((await getWizardDraft({ id: owner.id }))!.nextStep).toBe("IDENTITY");
  });

  it("a mandatory referral code: empty or unknown is refused; optional again: empty is fine", async () => {
    await setReferralSetting("referral_required_shop", "MANDATORY", admin);
    await expect(answerDraftReferral({ actor: owner, referralCode: null })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { referralCode: expect.stringMatching(/required/) } },
    });
    await expect(answerDraftReferral({ actor: owner, referralCode: "NOSUCH99" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id))).toHaveLength(0);
    await setReferralSetting("referral_required_shop", "OPTIONAL", admin);
    expect((await answerDraftReferral({ actor: owner, referralCode: "" })).nextStep).toBe("EMAIL");
  });

  it("a different shop email is confirmed with an emailed code, bound to the owner", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    const sent = await requestDraftEmailCode({ actor: owner, email: "Shop.Owner@Example.com" });
    expect(sent.maskedEmail).not.toBe("shop.owner@example.com");
    const code = lastCodeTo("shop.owner@example.com");
    expect(state.outbox.at(-1)!.subject).toMatch(/confirm this email for your shop/);
    // Another account cannot use the code, and a wrong code is refused.
    const other = await createUser({ role: "CUSTOMER" });
    await expect(confirmDraftEmailCode({ actor: { id: other.id, role: "CUSTOMER" }, email: "shop.owner@example.com", code })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(confirmDraftEmailCode({ actor: owner, email: "shop.owner@example.com", code: code === "000000" ? "111111" : "000000" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const view = await confirmDraftEmailCode({ actor: owner, email: "shop.owner@example.com", code });
    expect(view).toMatchObject({ nextStep: "DOCS_READY", email: { shop: "shop.owner@example.com", confirmed: true } });
    // The code works once.
    await expect(confirmDraftEmailCode({ actor: owner, email: "shop.owner@example.com", code })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("the shop email goes to the shop when it is created", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    await requestDraftEmailCode({ actor: owner, email: "orders@kirana.example" });
    await confirmDraftEmailCode({ actor: owner, email: "orders@kirana.example", code: lastCodeTo("orders@kirana.example") });
    await answerDocumentsReady({ actor: owner, later: true });
    await saveDraftDetails({ actor: owner, details: details() });
    await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
    const view = await submitDraftForPayment({ actor: owner });
    expect(await shopRow(view.shop!.id)).toMatchObject({ email: "orders@kirana.example" });
  });

  it("a draft started before these steps (GSTIN already checked) carries on where it was", async () => {
    await submitDraftGstin({ gstin: gstinFor("AABCG1234K"), consentGiven: true, actor: owner });
    const view = (await getWizardDraft(owner))!;
    expect(view).toMatchObject({ nextStep: "UDYAM", referral: { answered: true }, email: { confirmed: true }, documentsLater: false });
  });
});

describe("documents handy: Yes", () => {
  it("GSTIN → Udyam → FSSAI → shop details → map pin → review", async () => {
    await start(false);
    await submitDraftGstin({ gstin: gstinFor("AABCG1234K"), consentGiven: true, actor: owner });
    await answerDraftDocument({ actor: owner, docType: "UDYAM", has: false });
    let view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view.nextStep).toBe("DETAILS");
    view = await saveDraftDetails({ actor: owner, details: details() });
    expect(view.nextStep).toBe("LOCATION");
    view = await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
    expect(view).toMatchObject({ nextStep: "REVIEW", documents: { canSubmit: true, missing: [] } });
  });
});

describe("documents handy: No, upload later", () => {
  it("shop details → map pin → pay → live with no GSTIN or PAN; payouts held until the PAN is verified", async () => {
    let view = await start(true);
    expect(view).toMatchObject({ nextStep: "DETAILS", documentsLater: true });
    view = await saveDraftDetails({ actor: owner, details: details() });
    expect(view.nextStep).toBe("LOCATION");
    view = await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475, address: "Station Road, Pune" });
    expect(view).toMatchObject({ nextStep: "REVIEW", documents: { canSubmit: true, missing: [], needsTeamApproval: false } });

    const submitted = await submitDraftForPayment({ actor: owner });
    const shopId = submitted.shop!.id;
    expect(submitted.nextStep).toBe("PAYMENT");
    expect(await shopRow(shopId)).toMatchObject({ gstin: null, status: "PENDING_APPROVAL", latitude: "18.5308000" });
    expect(await db.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, shopId))).toHaveLength(0);

    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID" });
    const [decision] = await db.select().from(shopAutoApprovalLog).where(eq(shopAutoApprovalLog.shopId, shopId));
    expect(decision).toMatchObject({ outcome: "APPROVED" });
    expect(decision.evidence).toMatchObject({ documentsLater: true, documentsMissing: [] });
    // The pin went to the shop: the next step is the categories.
    expect((await getWizardDraft(owner))!.nextStep).toBe("CATEGORY");

    // Payouts wait for a verified GSTIN or PAN.
    expect(await payoutHoldReason(shopId)).toMatch(/held until/);
    const [settlement] = await db
      .insert(shopSettlements)
      .values({ shopId, periodStart: "2026-10-19", periodEnd: "2026-10-25", orderCount: 1, goodsPaise: 10_000, commissionPaise: 1_000, refundsPaise: 0, adjustmentsPaise: 0, netPayablePaise: 9_000 })
      .returning();
    await expect(decideShopSettlement(settlement.id, "approve", admin)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "PAYOUT_HELD" } });

    const pan = await submitSellerDocument({ shopId, docType: "PAN", number: "ABCPE1234F", consentGiven: true, actor: owner });
    expect(pan.status).toBe("VERIFIED");
    expect(await payoutHoldReason(shopId)).toBeNull();
    expect((await decideShopSettlement(settlement.id, "approve", admin)).status).toBe("ELIGIBLE");
  });

  it("a food shop is still asked for its FSSAI, and goes live once it is verified", async () => {
    await start(true);
    let view = await saveDraftDetails({ actor: owner, details: details({ shopType: "DAIRY" }) });
    expect(view).toMatchObject({ foodShop: true, nextStep: "FSSAI" });
    // "No" does not get a food shop past it.
    view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view.nextStep).toBe("FSSAI");
    view = await submitDraftDocument({ actor: owner, docType: "FSSAI", number: FSSAI, consentGiven: true });
    expect(view).toMatchObject({ nextStep: "LOCATION", fssai: { check: { status: "VERIFIED" } } });
    await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
    const submitted = await submitDraftForPayment({ actor: owner });
    await payInSandbox(submitted.shop!.id);
    expect(await shopRow(submitted.shop!.id)).toMatchObject({ status: "APPROVED", fssaiLicenseNumber: FSSAI });
  });

  it("a GSTIN tried and refused before switching to 'later' is not carried to the shop", async () => {
    await start(false);
    await submitDraftGstin({ gstin: gstinFor("AABCG0000K"), consentGiven: true, actor: owner });
    await answerDocumentsReady({ actor: owner, later: true });
    await saveDraftDetails({ actor: owner, details: details() });
    const view = await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
    expect(view.nextStep).toBe("REVIEW");
    const submitted = await submitDraftForPayment({ actor: owner });
    expect(await shopRow(submitted.shop!.id)).toMatchObject({ gstin: null });
    expect(await db.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, submitted.shop!.id))).toHaveLength(0);
  });
});

describe("HTTP routes", () => {
  it("referral → email (account) → documents-ready, each answering with the next step", async () => {
    await setFeatureFlag("shop_onboarding_wizard_enabled", { enabled: true, districtCodes: null }, "wizard flag (test)", admin);
    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: "CUSTOMER", status: "ACTIVE" } };
    const referral = await call(referralRoute, "/api/shops/registration-draft/referral", { method: "POST", body: { referralCode: "" } });
    expect(referral.status).toBe(200);
    expect(referral.body.nextStep).toBe("EMAIL");
    const sent = await call(emailRoute, "/api/shops/registration-draft/email", { method: "POST", body: { email: "route@shop.example" } });
    expect(sent.status).toBe(200);
    expect(sent.body.codeSent.maskedEmail).toBeTruthy();
    const confirmed = await call(emailRoute, "/api/shops/registration-draft/email", { method: "POST", body: { email: "route@shop.example", code: lastCodeTo("route@shop.example") } });
    expect(confirmed.body).toMatchObject({ nextStep: "DOCS_READY", email: { shop: "route@shop.example" } });
    const ready = await call(documentsReadyRoute, "/api/shops/registration-draft/documents-ready", { method: "POST", body: { later: true } });
    expect(ready.body).toMatchObject({ nextStep: "DETAILS", documentsLater: true });

    state.session = null;
    expect((await call(referralRoute, "/api/shops/registration-draft/referral", { method: "POST", body: { referralCode: "" } })).status).toBe(401);
  });
});
