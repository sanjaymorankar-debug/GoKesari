/**
 * Shop registration flow — owner brief 08-Nov-2026 (docs/shop-onboarding-identity-first-2026-11):
 *
 *   Flow 1  sign-in → "Verify your business" (referral code + GSTIN, or PAN without one) →
 *           owner name only if the record has none → confirm address → map pin → shop name →
 *           pay → live with "Add Products"
 *   Flow 2  an existing customer who clicks Sell starts at the same screen; a registration
 *           left for a week (or more) resumes where it stopped (owner, 25-Nov-2026)
 *   - no "upload later": nothing goes on until the GSTIN or PAN is verified
 *   - a GSTIN or PAN already registered is refused with that shop's status, before any paid call
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
import { auditLogs, notifications, platformSettings, shopCategories, shopFssaiWaivers, shopLegalDocuments, shopRegistrationDrafts, shops, userConsents } from "@/server/db/schema";
import { SELLER_TERMS_VERSION, SELLER_UNDERTAKING_VERSION } from "@/lib/legal/seller-undertaking";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { findLikelyDuplicate } from "@/server/dealers/attribution";
import { finishFeeCapture } from "@/server/services/operator-limited";
import { promiseShopDocuments } from "@/server/services/shop-document-gate";
import { approveShop } from "@/server/services/shops";
import { fssaiBlocksRegistration, getDocumentChecklist } from "@/server/services/document-uploads";
import { submitLegalDocument } from "@/server/services/legal-documents";
import {
  addShopDocumentType,
  documentRequirementsFor,
  getDocumentRulesAdmin,
  removeDocumentRule,
  saveDocumentRule,
  updateShopDocumentType,
} from "@/server/services/shop-document-rules";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { setReferralSetting } from "@/server/services/referral-settings";
import { clearRuleCache } from "@/server/services/settings";
import { ABANDONED_AFTER_MS, submitDraftGstin, submitDraftPan } from "@/server/services/shop-registration-draft";
import {
  finishDraftDocumentsStep,
  answerDocumentsReady,
  answerDraftReferral,
  confirmDraftEmailCode,
  getWizardDraft,
  requestDraftEmailCode,
  saveDraftAddress,
  saveDraftDetails,
  saveDraftLocation,
  saveDraftOwner,
  submitDraftDocument,
  submitDraftForPayment,
  type DraftShopDetails,
} from "@/server/services/shop-registration-wizard";
import type { KycAdapter } from "@/server/kyc/types";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

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
  // DF-08: the documents screen's promise for what may follow go-live (Shop Act, licences).
  await promiseShopDocuments(shopId, owner, "SIGNUP_WIZARD").catch(() => undefined);
  const checkout = await startRegistrationFeeCheckout(shopId, owner);
  await simulateSandboxCheckout({ ref: checkout.intentId, viewerId: owner.id, outcome: "SUCCESS" });
  await finishFeeCapture(shopId, checkout.intentId);
}

const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];

const ADDRESS = { addressLine1: "Shop No 7, Station Road", addressLine2: null, area: "Shivajinagar", city: "Pune", state: "Maharashtra", pincode: "411001", landmark: null };
const PIN = { latitude: 18.5308, longitude: 73.8475 };
/** The shop step's own fields: the owner name and address come from their steps. */
const shopFields = (overrides: Partial<DraftShopDetails> = {}) => ({ ...details(overrides), ownerName: null, addressLine1: null, city: null, pincode: null });

/** The first screen: the referral code (none) sent before the GSTIN, as the screen sends them. */
async function verifyGstin(gstin = gstinFor("AABCG1234K")) {
  await answerDraftReferral({ actor: owner, referralCode: null });
  await submitDraftGstin({ gstin, consentGiven: true, actor: owner });
  return (await getWizardDraft(owner))!;
}
async function verifyPan(pan: string) {
  await answerDraftReferral({ actor: owner, referralCode: null });
  await submitDraftPan({ pan, declarationAccepted: true, consentGiven: true, actor: owner });
  return (await getWizardDraft(owner))!;
}

describe("Flow 1, the first screen: referral code with the GSTIN or PAN", () => {
  it("starts at 'Verify your business' with the account's email; there is no 'upload later'", async () => {
    let view = await answerDraftReferral({ actor: owner, referralCode: null });
    expect(view).toMatchObject({ nextStep: "IDENTITY", referral: { answered: true, code: null, required: false }, email: { account: owner.email, shop: owner.email, confirmed: true } });
    await expect(answerDocumentsReady({ actor: owner, later: true })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "IDENTITY_STEP_OPEN" } });
    // Saving shop details before the number is verified is refused.
    await expect(saveDraftDetails({ actor: owner, details: details() })).rejects.toMatchObject({ code: "CONFLICT" });
    view = (await getWizardDraft({ id: owner.id }))!;
    expect(view.nextStep).toBe("IDENTITY");
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
    expect((await answerDraftReferral({ actor: owner, referralCode: "" })).nextStep).toBe("IDENTITY");
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
    expect(view).toMatchObject({ nextStep: "IDENTITY", email: { shop: "shop.owner@example.com", confirmed: true } });
    // The code works once.
    await expect(confirmDraftEmailCode({ actor: owner, email: "shop.owner@example.com", code })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("an invalid GSTIN: refused with a message, the owner stays on the screen, and a retry with the right one goes on", async () => {
    // Mock vendor: digits 0000 → not found at the source.
    let view = await verifyGstin(gstinFor("AABCG0000K"));
    expect(view).toMatchObject({ nextStep: "IDENTITY", canContinue: false, gstin: { status: "FAILED", errorCode: "not_found_at_source" } });
    expect(view.gstin!.message).toMatch(/not found/);
    await submitDraftGstin({ gstin: gstinFor("AABCG1234K"), consentGiven: true, actor: owner });
    view = (await getWizardDraft(owner))!;
    expect(view).toMatchObject({ canContinue: true, gstin: { status: "VERIFIED" } });
    expect(view.nextStep).not.toBe("IDENTITY");
  });

  it("an invalid PAN: refused, then retried", async () => {
    // Mock vendor: digits 8888 → inactive.
    let view = await verifyPan("ABCPE8888F");
    expect(view).toMatchObject({ nextStep: "IDENTITY", canContinue: false, pan: { status: "FAILED" } });
    await submitDraftPan({ pan: "ABCPE1234F", declarationAccepted: true, consentGiven: true, actor: owner });
    view = (await getWizardDraft(owner))!;
    expect(view).toMatchObject({ canContinue: true, pan: { status: "VERIFIED" } });
  });
});

describe("Flow 1 with a GSTIN", () => {
  it("owner name not in the record (a company): asked alone → address pre-filled → pin → shop name pre-filled → review", async () => {
    let view = await verifyGstin();
    // The PAN is taken from the GSTIN and checked — never typed.
    expect(view.pan).toMatchObject({ status: "VERIFIED" });
    expect(view.pan!.numberMasked).toMatch(/234K$/);
    expect(view).toMatchObject({ nextStep: "OWNER", ownerName: null });
    expect(view.prefill.shopName).toBeTruthy();
    expect(view.address!.addressLine1).toContain("Pune");

    view = await saveDraftOwner({ actor: owner, ownerName: "Ganesh Patil" });
    expect(view).toMatchObject({ nextStep: "TYPE", ownerName: "Ganesh Patil" });
    // The shop is elsewhere than the registered address: the owner changes it.
    view = await saveDraftAddress({ actor: owner, address: ADDRESS });
    expect(view).toMatchObject({ nextStep: "PIN", address: { addressLine1: "Shop No 7, Station Road" } });
    view = await saveDraftLocation({ actor: owner, ...PIN });
    expect(view.nextStep).toBe("SHOP");
    view = await saveDraftDetails({ actor: owner, details: shopFields({ name: view.prefill.shopName! }) });
    expect(view).toMatchObject({ nextStep: "REVIEW", details: { ownerName: "Ganesh Patil", addressLine1: "Shop No 7, Station Road" }, documents: { canSubmit: true, missing: [] } });
  });

  it("owner name in the record (a proprietor): no owner screen — straight to the address", async () => {
    const view = await verifyGstin(gstinFor("ABCPK5678L"));
    expect(view.ownerName).toBeTruthy();
    expect(view.nextStep).toBe("TYPE");
  });

  it("back keeps what was verified and typed: an earlier step saved again moves on from where it was", async () => {
    await verifyGstin();
    await saveDraftOwner({ actor: owner, ownerName: "Ganesh Patil" });
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    // Back to the address (a correction): the pin and owner stay.
    const view = await saveDraftAddress({ actor: owner, address: { ...ADDRESS, landmark: "Near the station" } });
    expect(view).toMatchObject({ nextStep: "SHOP", ownerName: "Ganesh Patil", gstin: { status: "VERIFIED" }, address: { landmark: "Near the station" } });
    expect(view.location).not.toBeNull();
  });

  it("payment succeeds → live, with Add Products, and the same words by email; payment fails → pending", async () => {
    await verifyGstin(gstinFor("ABCPK5678L"));
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    await saveDraftDetails({ actor: owner, details: shopFields() });
    // docs/seller-undertaking-2026-11: no shop without both boxes ticked.
    for (const ticks of [{}, { acceptSellerTerms: true }, { acceptUndertaking: true }]) {
      await expect(submitDraftForPayment({ actor: owner, ...ticks })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "SELLER_ACCEPTANCE_REQUIRED" } });
    }
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);
    const submitted = await submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
    const shopId = submitted.shop!.id;
    expect(submitted.nextStep).toBe("DOCUMENTS");
    // Both consents recorded with the new shop, at the current versions.
    const consents = await db.select().from(userConsents).where(eq(userConsents.userId, owner.id));
    expect(consents.map((c) => [c.consentType, c.version, c.shopId]).sort()).toEqual(
      [
        ["SELLER_GOODS_UNDERTAKING", SELLER_UNDERTAKING_VERSION, shopId],
        ["SELLER_TERMS", SELLER_TERMS_VERSION, shopId],
      ].sort(),
    );
    expect(await finishDraftDocumentsStep({ actor: owner, promise: true })).toMatchObject({ nextStep: "PAYMENT" });
    // The pin placed before payment is on the shop.
    expect(await shopRow(shopId)).toMatchObject({ status: "PENDING_APPROVAL", latitude: expect.stringMatching(/^18\.53/) });

    const checkout = await startRegistrationFeeCheckout(shopId, owner);
    await simulateSandboxCheckout({ ref: checkout.intentId, viewerId: owner.id, outcome: "FAILURE" });
    expect((await shopRow(shopId)).status).toBe("PENDING_APPROVAL");
    expect((await getWizardDraft(owner))!.nextStep).toBe("PAYMENT");

    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID" });
    expect((await getWizardDraft(owner))!.nextStep).toBe("LIVE");
    const [ready] = await db.select().from(notifications).where(eq(notifications.type, "shop.ready_for_product_upload"));
    expect(ready.body).toContain("Your onboarding is complete. Your shop is now live and accepting orders.");
    expect(ready.body).toContain("Add your products now so customers can find them and place orders with you");
  });

  it("the shop email goes to the shop when it is created", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    await requestDraftEmailCode({ actor: owner, email: "orders@kirana.example" });
    await confirmDraftEmailCode({ actor: owner, email: "orders@kirana.example", code: lastCodeTo("orders@kirana.example") });
    await submitDraftGstin({ gstin: gstinFor("ABCPK5678L"), consentGiven: true, actor: owner });
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    await saveDraftDetails({ actor: owner, details: shopFields() });
    const view = await submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
    expect(await shopRow(view.shop!.id)).toMatchObject({ email: "orders@kirana.example" });
  });

  it("with the FSSAI rule switched off (Admin → Rules), a food shop is not held for it and gets no FSSAI grace notice", async () => {
    // resetDatabase switches documentUpload.fssaiMandatoryForFood off for older tests.
    await verifyGstin(gstinFor("ABCPK5678L"));
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    const view = await saveDraftDetails({ actor: owner, details: shopFields({ shopType: "DAIRY" }) });
    expect(view).toMatchObject({ foodShop: true, nextStep: "REVIEW", licenceGraceDays: 90 });
    const submitted = await submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
    await payInSandbox(submitted.shop!.id);
    expect(await shopRow(submitted.shop!.id)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID" });
    // DF-08: FSSAI is never "due within 90 days" any more.
    expect(await db.select().from(notifications).where(eq(notifications.type, "shop.licence_grace_notice"))).toHaveLength(0);
  });
});

describe("DF-08 (owner, 21-Nov-2026 night): GST/PAN and FSSAI are must-have; the rest on the owner's promise", () => {
  beforeEach(async () => {
    // resetDatabase switches documentUpload.fssaiMandatoryForFood off for older tests; here it is on, as shipped.
    await db.delete(platformSettings).where(eq(platformSettings.key, "documentUpload"));
    clearRuleCache();
  });

  async function dairyAtDocuments(opts: { fssai?: string } = {}) {
    await verifyGstin(gstinFor("ABCPK5678L"));
    if (opts.fssai) await submitDraftDocument({ actor: owner, docType: "FSSAI", number: opts.fssai, consentGiven: true });
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    await saveDraftDetails({ actor: owner, details: shopFields({ shopType: "DAIRY" }) });
    return submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
  }

  it("a food shop without its FSSAI licence cannot leave the documents screen or pay", async () => {
    const submitted = await dairyAtDocuments();
    const shopId = submitted.shop!.id;
    expect(submitted).toMatchObject({ nextStep: "DOCUMENTS", documentsStep: { fssaiNeeded: true, canContinue: false } });
    expect(submitted.documentsStep!.promiseCovers).toContain("Shop Act (Shops & Establishments) certificate");
    // The screen shows the owner's own upload cards for the new shop, FSSAI required.
    const checklist = await getDocumentChecklist(shopId, owner);
    expect(checklist.fssaiRequired).toBe(true);
    expect(checklist.items.map((i) => i.docType)).toEqual(expect.arrayContaining(["FSSAI", "SHOP_ACT", "UDYAM", "TRADE_LICENCE", "OTHER_LICENCE"]));
    await expect(finishDraftDocumentsStep({ actor: owner, promise: true })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "FSSAI_REQUIRED" } });
    expect((await getWizardDraft(owner))!.nextStep).toBe("DOCUMENTS");
    // Nor straight to the checkout, even with the promise given.
    await promiseShopDocuments(shopId, owner, "SIGNUP_WIZARD");
    await expect(startRegistrationFeeCheckout(shopId, owner)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "FSSAI_REQUIRED" } });
    expect(await shopRow(shopId)).toMatchObject({ status: "PENDING_APPROVAL" });
  });

  it("with FSSAI verified, the Shop Act is promised on the screen; the shop pays and goes live with the promise on record", async () => {
    const submitted = await dairyAtDocuments({ fssai: "11521998000123" });
    const shopId = submitted.shop!.id;
    expect(submitted).toMatchObject({ nextStep: "DOCUMENTS", documentsStep: { fssaiNeeded: false, canContinue: false, promisedBy: null, promiseDays: 90 } });
    // Without the tick the screen asks for it.
    await expect(finishDraftDocumentsStep({ actor: owner })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DOCUMENTS_PROMISE_NEEDED" } });
    await expect(startRegistrationFeeCheckout(shopId, owner)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DOCUMENTS_PROMISE_NEEDED" } });
    const after = await finishDraftDocumentsStep({ actor: owner, promise: true });
    expect(after).toMatchObject({ nextStep: "PAYMENT", documentsStep: { canContinue: true } });
    expect(after.documentsStep!.promisedBy).toBeTruthy();
    const promised = await shopRow(shopId);
    expect(promised.documentsDueAt!.getTime() - promised.documentsPromisedAt!.getTime()).toBe(90 * 86_400_000);
    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID" });
    // FSSAI was on file: no grace notice for it.
    expect(await db.select().from(notifications).where(eq(notifications.type, "shop.licence_grace_notice"))).toHaveLength(0);
  });

  it("a paid food shop still without FSSAI is not approved on a plain Approve; the admin's Approve without documents gives 30 days", async () => {
    const submitted = await dairyAtDocuments();
    const shopId = submitted.shop!.id;
    // As a shop held before this rule: paid, still waiting.
    await db.update(shops).set({ feePaymentStatus: "PAID", registrationFeePaise: 0 }).where(eq(shops.id, shopId));
    const admin = await createUser({ role: "ADMIN" });
    await expect(approveShop(shopId, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { fssaiRequired: true },
    });
    const approved = await approveShop(shopId, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" }, {
      waiveFssai: { reason: "Owner sent the licence by e-mail; uploading it" },
    });
    expect(approved.status).toBe("APPROVED");
    const [waiver] = await db.select().from(shopFssaiWaivers);
    expect(waiver).toBeTruthy();
    expect(waiver.dueAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // The owner hears the waiver's 30 days, never a 90-day FSSAI grace.
    const notices = await db.select().from(notifications).where(eq(notifications.type, "shop.licence_grace_notice"));
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("grace period of 30 days");
  });
});

describe("DF-09 (owner, 22-Nov-2026): the admin decides which documents each kind of shop needs", () => {
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  let adminActor: { id: string; role: "ADMIN" };
  beforeEach(async () => {
    // As shipped: the FSSAI-for-food switch on.
    await db.delete(platformSettings).where(eq(platformSettings.key, "documentUpload"));
    clearRuleCache();
    adminActor = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  });

  async function shopAtDocuments(shopType = "GENERAL_TRADING") {
    await verifyGstin(gstinFor("ABCPK5678L"));
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    await saveDraftDetails({ actor: owner, details: shopFields({ shopType }) });
    return submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
  }

  it("Shop Act made optional for all shops: nothing to promise, the owner goes on to payment", async () => {
    await saveDocumentRule({ docKey: "SHOP_ACT", scope: "ALL", level: "OPTIONAL" }, adminActor);
    const submitted = await shopAtDocuments();
    expect(submitted.documentsStep).toMatchObject({ mustHave: [], promiseCovers: [], canContinue: true });
    const checklist = await getDocumentChecklist(submitted.shop!.id, owner);
    expect(checklist.items.find((i) => i.docType === "SHOP_ACT")?.requirement).toBe("optional");
    expect((await finishDraftDocumentsStep({ actor: owner })).nextStep).toBe("PAYMENT");
  });

  it("Fire NOC made must-have for one shop type: uploaded before paying, never promised; the shop then goes live", async () => {
    await saveDocumentRule({ docKey: "FIRE_NOC", scope: "TYPE:GENERAL_TRADING", level: "MUST_HAVE" }, adminActor);
    const submitted = await shopAtDocuments();
    const shopId = submitted.shop!.id;
    expect(submitted.documentsStep).toMatchObject({ fssaiNeeded: false, mustHave: ["Fire NOC"], canContinue: false });
    const checklist = await getDocumentChecklist(shopId, owner);
    expect(checklist.items.find((i) => i.docType === "FIRE_NOC")?.requirement).toBe("required");
    await expect(finishDraftDocumentsStep({ actor: owner, promise: true })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "DOCUMENTS_REQUIRED", missing: ["Fire NOC"] },
    });
    await expect(startRegistrationFeeCheckout(shopId, owner)).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "DOCUMENTS_REQUIRED" } });
    await submitLegalDocument({ shopId, docType: "FIRE_NOC", number: "PMC/FIRE/2026/1234", file: PDF, actor: owner });
    const after = await finishDraftDocumentsStep({ actor: owner, promise: true });
    expect(after).toMatchObject({ nextStep: "PAYMENT", documentsStep: { mustHave: [] } });
    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID" });
    // Another shop type is not asked for it.
    const other = await documentRequirementsFor({ id: shopId, shopType: "BAKERY" });
    expect(other.map((r) => r.key)).not.toContain("FIRE_NOC");
  });

  it("an admin adds a document the law requires: shops of that type promise it, or upload it on its own form", async () => {
    const type = await addShopDocumentType(
      { label: "Pollution control NOC", lawNote: "State Pollution Control Board consent to operate", needsNumber: false, needsExpiry: false, needsAuthority: true },
      adminActor,
    );
    expect(type.key).toBe("DOC:POLLUTION-CONTROL-NOC");
    const submitted = await shopAtDocuments();
    const shopId = submitted.shop!.id;
    // No rule yet: not asked.
    expect(submitted.documentsStep!.promiseCovers).not.toContain("Pollution control NOC");
    await saveDocumentRule({ docKey: type.key, scope: "TYPE:GENERAL_TRADING", level: "PROMISE" }, adminActor);
    let view = (await getWizardDraft(owner))!;
    expect(view.documentsStep!.promiseCovers).toEqual(["Shop Act (Shops & Establishments) certificate", "Pollution control NOC"]);
    expect(view.documentsStep!.extraDocuments).toEqual([
      expect.objectContaining({ customKey: type.key, label: "Pollution control NOC", state: "MISSING", level: "PROMISE", customNeeds: { number: false, expiry: false, authority: true } }),
    ]);
    // It asks for the issuing authority; the number is optional for this one.
    await expect(
      submitLegalDocument({ shopId, docType: "OTHER_LICENCE", number: "", customKey: type.key, file: PDF, actor: owner }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { fields: { issuingCouncil: expect.any(String) } } });
    const uploaded = await submitLegalDocument({ shopId, docType: "OTHER_LICENCE", number: "", issuingCouncil: "MPCB Pune", customKey: type.key, file: PDF, actor: owner });
    expect(uploaded).toMatchObject({ docType: "OTHER_LICENCE", label: "Pollution control NOC", state: "SUBMITTED", numberMasked: null });
    view = (await getWizardDraft(owner))!;
    expect(view.documentsStep!.promiseCovers).toEqual(["Shop Act (Shops & Establishments) certificate"]);
    expect(view.documentsStep!.extraDocuments[0]).toMatchObject({ state: "SUBMITTED" });
    // Switched off: no longer asked; what was uploaded stays.
    await updateShopDocumentType(type.key, { status: "INACTIVE" }, adminActor);
    expect((await documentRequirementsFor({ id: shopId, shopType: "GENERAL_TRADING" })).map((r) => r.key)).not.toContain(type.key);
  });

  it("FSSAI on the promise for one food type: such a shop pays with FSSAI promised, and approval does not wait for it", async () => {
    await saveDocumentRule({ docKey: "FSSAI", scope: "TYPE:DAIRY", level: "PROMISE" }, adminActor);
    const submitted = await shopAtDocuments("DAIRY");
    const shopId = submitted.shop!.id;
    expect(submitted.documentsStep).toMatchObject({ fssaiNeeded: false, mustHave: [] });
    expect(submitted.documentsStep!.promiseCovers).toEqual(expect.arrayContaining(["FSSAI licence", "Shop Act (Shops & Establishments) certificate"]));
    expect(await fssaiBlocksRegistration(await shopRow(shopId))).toBeNull();
    expect((await finishDraftDocumentsStep({ actor: owner, promise: true })).nextStep).toBe("PAYMENT");
    await payInSandbox(shopId);
    expect(await shopRow(shopId)).toMatchObject({ status: "APPROVED" });
  });

  it("a paid shop missing an admin must-have is refused a plain Approve; Approve without documents covers it", async () => {
    const submitted = await shopAtDocuments();
    const shopId = submitted.shop!.id;
    await saveDocumentRule({ docKey: "TRADE_LICENCE", scope: "ALL", level: "MUST_HAVE" }, adminActor);
    await db.update(shops).set({ feePaymentStatus: "PAID", registrationFeePaise: 0 }).where(eq(shops.id, shopId));
    await expect(approveShop(shopId, { classification: "GREEN" }, adminActor)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { mustHaveDocuments: ["Trade licence (municipal)"] },
    });
    const approved = await approveShop(shopId, { classification: "GREEN" }, adminActor, { waiveFssai: { reason: "Trade licence applied for; owner will upload" } });
    expect(approved.status).toBe("APPROVED");
    expect(await db.select().from(shopFssaiWaivers).where(eq(shopFssaiWaivers.shopId, shopId))).toHaveLength(1);
    // Not a food shop: no FSSAI row is made for it.
    expect(await db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shopId))).toHaveLength(0);
  });

  it("only an admin changes the rules; raising a document gives shops already live the days given; every change is audited", async () => {
    const operatorActor = { id: (await createUser({ role: "OPERATOR" })).id, role: "OPERATOR" as const };
    await expect(saveDocumentRule({ docKey: "FIRE_NOC", scope: "ALL", level: "PROMISE" }, operatorActor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      addShopDocumentType({ label: "Explosives licence", lawNote: "Explosives Act 1884", needsNumber: true, needsExpiry: true, needsAuthority: false }, operatorActor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(saveDocumentRule({ docKey: "NOT_A_DOC", scope: "ALL", level: "PROMISE" }, adminActor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(saveDocumentRule({ docKey: "FIRE_NOC", scope: "TYPE:NO_SUCH_TYPE", level: "PROMISE" }, adminActor)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(saveDocumentRule({ docKey: "FIRE_NOC", scope: "everyone", level: "PROMISE" }, adminActor)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      addShopDocumentType({ label: "Fire NOC", lawNote: "Already in the list", needsNumber: true, needsExpiry: false, needsAuthority: false }, adminActor),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const saved = await saveDocumentRule({ docKey: "FIRE_NOC", scope: "ALL", level: "PROMISE", liveShopDays: 60 }, adminActor);
    const days = (saved.liveShopsDueAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
    // PROMISE → MUST_HAVE keeps the date; back to OPTIONAL and up again starts a new one.
    const raised = await saveDocumentRule({ docKey: "FIRE_NOC", scope: "ALL", level: "MUST_HAVE", liveShopDays: 200 }, adminActor);
    expect(raised.liveShopsDueAt).toEqual(saved.liveShopsDueAt);
    const admin = await getDocumentRulesAdmin();
    expect(admin.documents.find((d) => d.key === "FIRE_NOC")!.rules).toEqual([expect.objectContaining({ scope: "ALL", scopeLabel: "All shops", level: "MUST_HAVE" })]);
    expect(admin.documents.find((d) => d.key === "FSSAI")!.rules).toEqual([expect.objectContaining({ scope: "FOOD", level: "MUST_HAVE" })]);
    await removeDocumentRule(raised.id, adminActor);
    expect((await getDocumentRulesAdmin()).documents.find((d) => d.key === "FIRE_NOC")!.rules).toEqual([]);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityType, "shop_document_rule"));
    expect(audits.map((a) => a.action).sort()).toEqual(["shop_document_rule.removed", "shop_document_rule.saved", "shop_document_rule.saved"]);
  });
});

describe("Flow 1 with a PAN only (no GST)", () => {
  it("address not returned by the PAN source: the owner name is filled, the address typed → pin → shop name typed → live", async () => {
    let view = await verifyPan("ABCPE1234F");
    expect(view).toMatchObject({ route: "PAN_ONLY", noGstDeclared: true, pan: { status: "VERIFIED" } });
    expect(view.ownerName).toBeTruthy();
    expect(view).toMatchObject({ nextStep: "TYPE", address: null, prefill: { shopName: null } });
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    view = await saveDraftDetails({ actor: owner, details: shopFields({ name: "Ekta Kirana" }) });
    expect(view.nextStep).toBe("REVIEW");
    const submitted = await submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
    await payInSandbox(submitted.shop!.id);
    expect(await shopRow(submitted.shop!.id)).toMatchObject({ status: "APPROVED", gstin: null, gstStatus: "NOT_REGISTERED" });
  });

  it("address returned by the PAN source: it fills the address step", async () => {
    const adapter: KycAdapter = {
      id: "mock",
      verify: async () => ({
        kind: "found",
        providerRef: "pan-ref",
        record: { docStatus: "active", name: "EKTA SHARMA", address: "22, Laxmi Road, Pune, 411030", pincode: "411030" },
      }),
    };
    setKycAdapterForTests(adapter);
    const view = await verifyPan("ABCPE1234F");
    expect(view).toMatchObject({ nextStep: "TYPE", ownerName: "EKTA SHARMA", address: { addressLine1: "22, Laxmi Road, Pune, 411030", pincode: "411030", city: "Pune" } });
  });
});

describe("duplicates", () => {
  it("a GSTIN already registered by another account is refused with that shop's status, before any paid call", async () => {
    const other = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(other.id, { status: "APPROVED" });
    const gstin = gstinFor("AABCG1234K");
    await db.update(shops).set({ gstin }).where(eq(shops.id, shop.id));
    await expect(verifyGstin(gstin)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/live on GoKesari/), details: { reason: "DUPLICATE_SHOP", shopStatus: "APPROVED" } });
  });

  it("a PAN already registered is refused with that shop's status, before any paid call", async () => {
    await verifyPan("ABCPE1234F");
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    await saveDraftDetails({ actor: owner, details: shopFields() });
    await submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
    // Another account tries the same PAN.
    const u = await createUser({ role: "CUSTOMER" });
    const second = { id: u.id, role: "CUSTOMER" as const };
    await expect(submitDraftPan({ pan: "ABCPE1234F", declarationAccepted: true, consentGiven: true, actor: second })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/waiting for its registration fee or admin approval/),
      details: { reason: "DUPLICATE_SHOP", shopStatus: "PENDING_APPROVAL" },
    });
  });
});

describe("Flow 2: an existing customer clicks Sell", () => {
  it("starts at the GST / PAN screen (already signed in); a registration left for a week resumes where it stopped (owner, 25-Nov-2026)", async () => {
    // The customer started once and walked away.
    await verifyGstin();
    await saveDraftOwner({ actor: owner, ownerName: "Old Name" });
    const [old] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    await db.update(shopRegistrationDrafts).set({ updatedAt: new Date(Date.now() - ABANDONED_AFTER_MS - 60_000) }).where(eq(shopRegistrationDrafts.id, old.id));

    // Back on Sell: the same registration, at the step after the owner name (the shop type, 25-Nov-2026).
    const view = (await getWizardDraft(owner))!;
    expect(view).toMatchObject({ id: old.id, status: "OPEN", nextStep: "TYPE", ownerName: "Old Name", route: "GSTIN" });

    // One marked ABANDONED before 25-Nov-2026 opens again too, and nothing new is started.
    await db.update(shopRegistrationDrafts).set({ status: "ABANDONED" }).where(eq(shopRegistrationDrafts.id, old.id));
    const reopened = await answerDraftReferral({ actor: owner, referralCode: null });
    expect(reopened).toMatchObject({ id: old.id, status: "OPEN", ownerName: "Old Name" });
    expect(await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id))).toHaveLength(1);
  });

  it("verified and paid goes live even when another account has a shop of the same name and PIN (DI-13)", async () => {
    const other = await createUser({ role: "SHOP_OWNER" });
    const fields = shopFields();
    const twin = await createShop(other.id, { name: fields.name, status: "APPROVED" });
    await db.update(shops).set({ pincode: ADDRESS.pincode, latitude: null, longitude: null }).where(eq(shops.id, twin.id));
    await verifyGstin(gstinFor("ABCPK5678L"));
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    await saveDraftDetails({ actor: owner, details: fields });
    const submitted = await submitDraftForPayment({ actor: owner, acceptSellerTerms: true, acceptUndertaking: true });
    expect(await findLikelyDuplicate(submitted.shop!.id)).toMatchObject({ kind: "DUPLICATE", reasons: expect.arrayContaining(["NAME_SAME_PIN"]) });
    await payInSandbox(submitted.shop!.id);
    expect(await shopRow(submitted.shop!.id)).toMatchObject({ status: "APPROVED", feePaymentStatus: "PAID" });
  });

  it("within the week the same registration resumes where it was", async () => {
    await verifyGstin();
    await saveDraftOwner({ actor: owner, ownerName: "Ganesh Patil" });
    expect((await getWizardDraft(owner))!).toMatchObject({ nextStep: "TYPE", ownerName: "Ganesh Patil" });
  });
});

describe("HTTP routes", () => {
  it("referral → email (changed) answer with the next step; 'upload later' is refused", async () => {
    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: "CUSTOMER", status: "ACTIVE" } };
    const referral = await call(referralRoute, "/api/shops/registration-draft/referral", { method: "POST", body: { referralCode: "" } });
    expect(referral.status).toBe(200);
    expect(referral.body.nextStep).toBe("IDENTITY");
    const sent = await call(emailRoute, "/api/shops/registration-draft/email", { method: "POST", body: { email: "route@shop.example" } });
    expect(sent.status).toBe(200);
    expect(sent.body.codeSent.maskedEmail).toBeTruthy();
    const confirmed = await call(emailRoute, "/api/shops/registration-draft/email", { method: "POST", body: { email: "route@shop.example", code: lastCodeTo("route@shop.example") } });
    expect(confirmed.body).toMatchObject({ nextStep: "IDENTITY", email: { shop: "route@shop.example" } });
    const ready = await call(documentsReadyRoute, "/api/shops/registration-draft/documents-ready", { method: "POST", body: { later: true } });
    expect(ready.status).toBe(409);

    state.session = null;
    expect((await call(referralRoute, "/api/shops/registration-draft/referral", { method: "POST", body: { referralCode: "" } })).status).toBe(401);
  });
});
