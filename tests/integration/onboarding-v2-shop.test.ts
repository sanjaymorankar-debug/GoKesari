/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11). With the flag onboarding_v2 on a new
 * registration follows: identity → referral → GST / PAN → owner name → fee (turnover band, paid on the draft)
 * → shop type → licences (enter / upload / scan / later) → address → pin → seller agreement → live.
 *
 *   - flag off: a new draft is the original wizard (flow_version null, no v2 view)
 *   - identity: Terms + e-mail code + mobile (SMS code, or saved unverified with no SMS — DEFAULT #8); skipped for
 *     a verified customer
 *   - fee (owner 27-Nov-2026): the original turnover slab (₹999 / ₹4,999 / ₹9,999) + GST, or the flat fee with that
 *     rule off, with an optional registration-fee coupon; wholesale pays the same and picks its type; pending
 *     payment resumes
 *   - each licence option; every licence (MUST_HAVE / FSSAI too) may be uploaded later; the promise reaches the
 *     document follow-up, which suspends after the period and the shop is reinstated automatically once given
 *   - go-live: GST verified + fee paid → live after the agreement (never before); no licence or operator check holds it
 *   - background: wallet + role history; return-to only for same-site paths
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outbox: [] as { to: string; subject: string; text: string }[], failLedger: 0 }));

// Ledger failure injection: the next `failLedger` calls of the shop fee capture step throw (then it works again).
vi.mock("@/server/services/operator-limited", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/operator-limited")>();
  return {
    ...real,
    onShopRegistrationFeeCaptured: async (...args: Parameters<typeof real.onShopRegistrationFeeCaptured>) => {
      if (state.failLedger > 0) {
        state.failLedger -= 1;
        throw new Error("ledger write failed (test)");
      }
      return real.onShopRegistrationFeeCaptured(...args);
    },
  };
});

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  notifications,
  onboardingRoleHistory,
  sellerVerifications,
  shopSuspensions,
  paymentIntents,
  outboundTestMessages,
  registrationLicenceEntries,
  registrationLicenceFiles,
  shopPayments,
  shopRegistrationDrafts,
  shops,
  userConsents,
  users,
  wallets,
} from "@/server/db/schema";
import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { hasCurrentConsent } from "@/server/services/consents";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { licenceBlockers } from "@/server/legal-agreements/requirements";
import { createPaymentIntent, getPaymentIntent } from "@/server/payments/intents";
import {
  acceptV2Agreement,
  onDraftFeeCaptured,
  sweepV2FeeLedger,
  acceptV2Terms,
  confirmV2EmailCode,
  confirmV2MobileCode,
  listRegistrationLicences,
  prepareV2Agreement,
  requestV2EmailCode,
  requestV2MobileCode,
  reviewRegistrationLicence,
  saveLicenceEntry,
  startDraftFeeCheckout,
  startV2Draft,
} from "@/server/onboarding-v2/shop-flow";
import { v2FeeQuote } from "@/server/onboarding-v2/shop-view";
import { baseRegistrationFee, quoteRegistrationFee, registrationFeeGstRateBp, saveRegistrationFeeCoupon } from "@/server/services/registration-fee-coupons";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { runShopDocumentFollowUp } from "@/server/services/shop-document-follow-up";
import { suspendShopWithPolicy } from "@/server/services/shop-suspension";
import { submitSellerDocument } from "@/server/services/seller-verification";
import { reactivateIfDocumentsGiven } from "@/server/onboarding-v2/document-reactivation";
import { submitDraftGstin } from "@/server/services/shop-registration-draft";
import {
  answerDraftReferral,
  getWizardDraft,
  saveDraftAddress,
  saveDraftLocation,
  saveDraftOwner,
  saveDraftShopType,
} from "@/server/services/shop-registration-wizard";
import { autoApproveShopIfReady } from "@/server/services/shops";
import { createUser, resetDatabase } from "../helpers/fixtures";

const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const COMPANY_PAN = "AABCG1234K";
const FSSAI = "11521998000123";
/** Maharashtra: no online Shop Act check — it waits for GoKesari's team. */
const SHOP_ACT = "PMC/SHOP/2026/12345";
/** A tiny valid PNG (1×1). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

type Owner = { id: string; role: "CUSTOMER"; email: string };
let admin: { id: string; role: "ADMIN" };
let owner: Owner;

async function setV2(enabled: boolean) {
  await setFeatureFlag("onboarding_v2", { enabled, districtCodes: null }, "Flow 2 integration test", admin);
}

/** A customer who already proved e-mail and mobile (the identity screen is skipped). */
async function verifiedCustomer(): Promise<Owner> {
  const u = await createUser({ role: "CUSTOMER" });
  await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: new Date() }).where(eq(users.id, u.id));
  return { id: u.id, role: "CUSTOMER", email: u.email };
}

beforeEach(async () => {
  state.outbox = [];
  state.failLedger = 0;
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  setKycAdapterForTests(createMockAdapter());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setV2(true);
  owner = await verifiedCustomer();
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

const view = async (who: Owner = owner) => (await getWizardDraft(who))!;
const draftRow = async (who: Owner = owner) =>
  (await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, who.id)).orderBy(desc(shopRegistrationDrafts.createdAt)).limit(1))[0];

/** Identity (skipped) → referral → GSTIN → owner name: the fee screen. */
async function walkToFee(who: Owner = owner) {
  await startV2Draft(who);
  await answerDraftReferral({ actor: who, referralCode: null });
  await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: who });
  return saveDraftOwner({ actor: who, ownerName: "Test Seller" });
}

/** Pays the fee for a turnover band (1 = up to ₹2 crore, ₹999 + GST by default). */
async function payFee(slab: number | null = 1, outcome: "SUCCESS" | "FAILURE" = "SUCCESS", who: Owner = owner) {
  const started = await startDraftFeeCheckout(who, { slab, shopName: "V2 Test Mart" });
  expect(started.redirectUrl).toBeTruthy();
  await simulateSandboxCheckout({ ref: started.intentId!, viewerId: who.id, outcome });
  return started;
}

async function addressAndPin(who: Owner = owner) {
  await saveDraftAddress({
    actor: who,
    address: { addressLine1: "Shop No 4, Main Market", addressLine2: null, area: "Shivajinagar", city: "Pune", state: "Maharashtra", pincode: "411001", landmark: null },
  });
  return saveDraftLocation({ actor: who, latitude: 18.5308, longitude: 73.8475 });
}

describe("flag off: the original wizard, unchanged", () => {
  it("gives a new draft no flow version and no v2 view", async () => {
    await setV2(false);
    expect(await startV2Draft(owner)).toBeNull();
    const v = await answerDraftReferral({ actor: owner, referralCode: null });
    expect(v.v2).toBeNull();
    expect((await draftRow()).flowVersion).toBeNull();
    expect(v.nextStep).toBe("IDENTITY");
  });

  it("keeps a draft started before the flag on the original order", async () => {
    await setV2(false);
    await answerDraftReferral({ actor: owner, referralCode: null });
    await setV2(true);
    const v = await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner }).then(() => view());
    expect(v.v2).toBeNull();
    expect(v.nextStep).toBe("OWNER");
  });
});

describe("step 1: identity", () => {
  it("is skipped for a signed-in customer with a verified e-mail and mobile", async () => {
    const v = (await startV2Draft(owner))!;
    expect(v.v2?.identity).toMatchObject({ skipped: true, done: true });
    expect(v.nextStep).toBe("REFERRAL");
    expect((await draftRow()).identityVerifiedAt).not.toBeNull();
  });

  it("asks Terms, e-mail code and mobile SMS code, then goes on", async () => {
    const u = await createUser({ role: "CUSTOMER", mobile: null });
    const who: Owner = { id: u.id, role: "CUSTOMER", email: u.email };
    let v = (await startV2Draft(who))!;
    expect(v.nextStep).toBe("V2_IDENTITY");
    expect(v.v2?.identity).toMatchObject({ termsAccepted: false, emailVerified: false, mobileVerified: false, smsAvailable: true });

    v = await acceptV2Terms(who, { accept: true });
    expect(v.v2?.identity.termsAccepted).toBe(true);
    // QA D-168: one Terms version for the same consent — the one /signin and the checkout login sheet record.
    expect(v.v2?.identity.termsVersion).toBe(CURRENT_POLICY_VERSION);
    const [tick] = await db
      .select()
      .from(userConsents)
      .where(and(eq(userConsents.userId, who.id), eq(userConsents.consentType, "TERMS_AND_PRIVACY")))
      .orderBy(desc(userConsents.createdAt))
      .limit(1);
    expect(tick).toMatchObject({ version: CURRENT_POLICY_VERSION, granted: true });
    expect(await hasCurrentConsent(who.id, "TERMS_AND_PRIVACY")).toBe(true);
    await requestV2EmailCode(who, {});
    const emailed = [...state.outbox].reverse().find((m) => m.to === who.email)!;
    const code = emailed.text.match(/\b(\d{4,8})\b/)![1];
    v = await confirmV2EmailCode(who, { code });
    expect(v.v2?.identity.emailVerified).toBe(true);
    expect(v.nextStep).toBe("V2_IDENTITY");

    const mobile = `97${String(Date.now()).slice(-8)}`;
    const sent = await requestV2MobileCode(who, { mobile });
    expect(sent.sent).toBe(true);
    const [sms] = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.toAddress, `+91${mobile}`)).orderBy(desc(outboundTestMessages.createdAt)).limit(1);
    const smsCode = sms.body.match(/\b(\d{4,8})\b/)![1];
    v = await confirmV2MobileCode(who, { mobile, code: smsCode });
    expect(v.v2?.identity).toMatchObject({ mobileVerified: true, done: true });
    expect(v.nextStep).toBe("REFERRAL");
    const [account] = await db.select().from(users).where(eq(users.id, who.id));
    expect(account.phoneE164).toBe(`+91${mobile}`);
    expect(account.phoneVerifiedAt).not.toBeNull();
  });

  it("with no SMS saves the mobile unverified when the fallback rule is on, and refuses when it is off (DEFAULT #8)", async () => {
    await setRule("otp", { smsEnabled: false }, admin);
    const u = await createUser({ role: "CUSTOMER", mobile: null });
    await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, u.id));
    const who: Owner = { id: u.id, role: "CUSTOMER", email: u.email };
    await startV2Draft(who);
    await acceptV2Terms(who, { accept: true });

    await setRule("onboardingV2", { mobileOtpFallbackWhenNoSms: false }, admin);
    await expect(requestV2MobileCode(who, { mobile: "9876501234" })).rejects.toMatchObject({ details: { reason: "SMS_UNAVAILABLE" } });

    await setRule("onboardingV2", { mobileOtpFallbackWhenNoSms: true }, admin);
    const saved = await requestV2MobileCode(who, { mobile: "9876501234" });
    expect(saved.sent).toBe(false);
    expect(saved.view.v2?.identity).toMatchObject({ mobileSavedUnverified: true, mobileVerified: false, done: true });
    expect(saved.view.nextStep).toBe("REFERRAL");
  });
});

describe("step 4: the fee, paid on the draft (owner 27-Nov-2026: the original turnover slabs)", () => {
  it("charges the turnover slab + GST — ₹999 for the first band — exactly as the original fee", async () => {
    const v = await walkToFee();
    expect(v.nextStep).toBe("FEE");
    expect(v.v2?.names.shopName).toBeTruthy();
    expect(v.v2?.fee.byTurnover).toBe(true);
    expect(v.v2?.fee.slabs.map((s) => s.basePaise)).toEqual([99_900, 4_99_900, 9_99_900]);
    const gstRateBp = await registrationFeeGstRateBp();
    expect(gstRateBp).toBeGreaterThan(0);
    const first = await v2FeeQuote({ ownerId: owner.id, slab: 1 });
    expect(first).toMatchObject({ slab: 1, basePaise: 99_900, discountPaise: 0, gstRateBp });
    expect(first.gstPaise).toBe(Math.round((99_900 * gstRateBp) / 10_000));
    expect(first.totalPaise).toBe(99_900 + first.gstPaise);
    // The same figure the original registration charges for that turnover.
    const original = await quoteRegistrationFee({ ownerId: owner.id, turnoverRupees: first.turnoverRupees });
    expect(original.totalPaise).toBe(first.totalPaise);
    // A band must be chosen while fees by turnover are on.
    await expect(startDraftFeeCheckout(owner, { slab: null, shopName: "V2 Test Mart" })).rejects.toMatchObject({ details: { fields: { annualTurnover: expect.any(String) } } });

    const started = await startDraftFeeCheckout(owner, { slab: 2, shopName: "V2 Test Mart" });
    expect(started.amountPaise).toBe((await v2FeeQuote({ ownerId: owner.id, slab: 2 })).totalPaise);
    expect(started.amountPaise).toBeGreaterThan(4_99_900);
  });

  it("with fees by turnover off: the flat fee (+ GST), no band asked", async () => {
    await setRule("registrationFeeByTurnover", { enabled: false }, admin);
    const v = await walkToFee();
    expect(v.v2?.fee).toMatchObject({ byTurnover: false, slabs: [] });
    const flat = await baseRegistrationFee(null);
    expect(v.v2?.fee.flat?.basePaise).toBe(flat.basePaise);
    const started = await startDraftFeeCheckout(owner, { slab: null, shopName: "V2 Test Mart" });
    expect(started.amountPaise).toBe(v.v2!.fee.flat!.totalPaise);
  });

  it("a registration-fee coupon lowers the fee as in the original flow and is recorded on the shop", async () => {
    await saveRegistrationFeeCoupon({ code: "V2HALF", discountType: "PERCENT", percent: 50 }, admin);
    await walkToFee();
    const quote = await v2FeeQuote({ ownerId: owner.id, slab: 1, couponCode: "v2half" });
    expect(quote).toMatchObject({ couponCode: "V2HALF", discountPaise: 49_950 });
    await expect(v2FeeQuote({ ownerId: owner.id, slab: 1, couponCode: "NOSUCH" })).rejects.toThrow(/isn't valid/);
    const started = await startDraftFeeCheckout(owner, { slab: 1, couponCode: "V2HALF", shopName: "V2 Test Mart" });
    expect(started.amountPaise).toBe(quote.totalPaise);
    await simulateSandboxCheckout({ ref: started.intentId!, viewerId: owner.id, outcome: "SUCCESS" });
    await saveDraftShopType({ actor: owner, shopType: "GENERAL_TRADING" });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    const v = await prepareV2Agreement(owner);
    const [shop] = await db.select().from(shops).where(eq(shops.id, v.shop!.id));
    expect(shop).toMatchObject({ registrationFeePaise: quote.totalPaise, registrationFeeDiscountPaise: 49_950, registrationFeeCouponCode: "V2HALF" });
    expect(shop.registrationFeeCouponId).toBeTruthy();
    expect(shop.annualTurnoverRupees).toBe(quote.turnoverRupees);
  });

  it("wholesale pays the same slab and picks Wholesale store at the normal type step", async () => {
    await walkToFee();
    await payFee(1);
    let v = await view();
    expect(v.v2?.fee).toMatchObject({ paid: true, chosenSlab: 1, legacyWholesale: false });
    expect(v.v2?.fee.paidPaise).toBe((await v2FeeQuote({ ownerId: owner.id, slab: 1 })).totalPaise);
    expect(v.nextStep).toBe("TYPE");
    v = await saveDraftShopType({ actor: owner, shopType: "WHOLESALE_STORE" });
    expect(v.shopType).toBe("WHOLESALE_STORE");
    expect((await draftRow()).feeKind).toBeNull();
  });

  it("a failed payment leaves the draft pending payment; the owner resumes and pays", async () => {
    await walkToFee();
    await payFee(1, "FAILURE");
    let v = await view();
    expect(v.status).toBe("OPEN");
    expect(v.nextStep).toBe("FEE");
    expect(v.v2?.fee).toMatchObject({ paid: false, lastFailed: true });
    expect((await draftRow()).feePaidAt).toBeNull();
    // No shop exists yet: the owner is still only a customer.
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);

    await payFee(1);
    v = await view();
    expect(v.v2?.fee.paid).toBe(true);
    expect(v.nextStep).toBe("TYPE");
  });
});

describe("step 6: licences, four options", () => {
  async function toLicences(shopType: string) {
    // The FSSAI-for-food rule as it ships (on): FSSAI is MUST_HAVE for a food shop.
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await walkToFee();
    await payFee(1);
    return saveDraftShopType({ actor: owner, shopType });
  }

  it("lists what the admin's rules require and records each option", async () => {
    let v = await toLicences("GROCERY_KIRANA");
    expect(v.nextStep).toBe("V2_LICENCES");
    const keys = v.v2!.licences.map((l) => l.key).sort();
    expect(keys).toEqual(["FSSAI", "SHOP_ACT"]);
    // Owner, 27-Nov-2026: every licence may be uploaded later — FSSAI (MUST_HAVE) too.
    expect(v.v2!.licences.find((l) => l.key === "FSSAI")).toMatchObject({ level: "MUST_HAVE", laterAllowed: true });
    v = await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "LATER", promise: true });
    expect(v.v2!.licences.find((l) => l.key === "FSSAI")!.entry).toMatchObject({ option: "LATER", status: "PROMISED" });

    // Scan: the device read it, the owner confirmed, verified online like a typed number.
    v = await saveLicenceEntry(owner, {
      licenceKey: "FSSAI",
      option: "SCAN",
      number: FSSAI,
      holderName: "Test Seller",
      validUntil: "2030-03-31",
      issuingAuthority: "FSSAI",
      consent: true,
      ocr: { number: FSSAI, holderName: "TEST SELLER" },
      file: { data: PNG, source: "CAMERA" },
    });
    expect(v.v2!.licences.find((l) => l.key === "FSSAI")!.entry).toMatchObject({ option: "SCAN", status: "VERIFIED", hasFile: true });
    expect(v.nextStep).toBe("V2_LICENCES");

    // Upload later for a PROMISE licence: the checkbox is required.
    await expect(saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER" })).rejects.toThrow();
    v = await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    expect(v.v2!.licences.find((l) => l.key === "SHOP_ACT")!.entry).toMatchObject({ option: "LATER", status: "PROMISED" });
    expect((await draftRow()).documentsPromisedAt).not.toBeNull();
    expect(v.nextStep).toBe("ADDRESS");

    // Changed to Enter details: Maharashtra's Shop Act cannot be checked online → the team.
    v = await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "ENTER", number: SHOP_ACT, consent: true });
    expect(v.v2!.licences.find((l) => l.key === "SHOP_ACT")!.entry).toMatchObject({ option: "ENTER", status: "PENDING_OPERATOR" });
    expect((await draftRow()).documentsPromisedAt).toBeNull();

    // Upload file: kept encrypted, an operator checks it.
    v = await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "UPLOAD", file: { data: PNG, source: "FILE" } });
    expect(v.v2!.licences.find((l) => l.key === "SHOP_ACT")!.entry).toMatchObject({ option: "UPLOAD", status: "PENDING_OPERATOR", hasFile: true });
    const files = await db.select().from(registrationLicenceFiles).where(eq(registrationLicenceFiles.ownerUserId, owner.id));
    expect(files.length).toBe(2);
    expect(files.every((f) => !f.dataEncrypted.equals(PNG))).toBe(true);
  });

  it("refuses a file that is not a PDF / JPG / PNG", async () => {
    await toLicences("GENERAL_TRADING");
    await expect(saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "UPLOAD", file: { data: Buffer.from("hello"), source: "FILE" } })).rejects.toThrow(/PDF, JPG or PNG/);
  });
});

describe("steps 6b–8: agreement and go-live", () => {
  it("goes live automatically when GST is verified and the fee paid — only after the agreement", async () => {
    // The customer side first: an owner who never had a wallet gets one in the background.
    await db.delete(wallets).where(eq(wallets.userId, owner.id));
    await walkToFee();
    await payFee(1);
    await saveDraftShopType({ actor: owner, shopType: "GENERAL_TRADING" });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    let v = await addressAndPin();
    expect(v.nextStep).toBe("SLA");
    expect(v.shop).toBeNull();

    v = await prepareV2Agreement(owner);
    expect(v.shop).toMatchObject({ status: "PENDING_APPROVAL", name: "V2 Test Mart" });
    expect(v.nextStep).toBe("SLA");
    const shopId = v.shop!.id;
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    const draft = await draftRow();
    const quote = (draft.details as { v2Fee: { totalPaise: number } }).v2Fee;
    expect(shop.registrationFeePaise).toBe(quote.totalPaise);
    expect(shop.feePaymentStatus).toBe("PAID");
    const ledger = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shopId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ method: "ONLINE", paymentType: "REGISTRATION_FEE" });
    // Never live before the agreement, whoever asks.
    expect(await autoApproveShopIfReady(shopId)).toBe(false);
    expect((await db.select().from(shops).where(eq(shops.id, shopId)))[0].status).toBe("PENDING_APPROVAL");

    // Background: wallet, role history, licence entries on the shop, the promise on the shop.
    expect(await db.select().from(wallets).where(eq(wallets.userId, owner.id))).toHaveLength(1);
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, owner.id));
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ role: "shop_owner", action: "GRANTED", toValue: shopId })]));
    const entries = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.draftId, draft.id));
    expect(entries.every((e) => e.shopId === shopId)).toBe(true);
    expect(shop.documentsPromisedAt).not.toBeNull();

    await expect(acceptV2Agreement(owner, { acceptUndertaking: true })).rejects.toMatchObject({ details: { reason: "SELLER_ACCEPTANCE_REQUIRED" } });
    v = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(v.shop?.status).toBe("APPROVED");
    expect(v.v2?.sla.accepted).toBe(true);
    expect(["LIVE", "DONE", "LOCATION"]).toContain(v.nextStep);
    // The only fee the owner paid is the one on the draft.
    expect(await db.select().from(shopPayments).where(eq(shopPayments.shopId, shopId))).toHaveLength(1);

    // Upload later feeds the existing follow-up: on a reminder day the live shop is chased for its Shop Act.
    const result = await runShopDocumentFollowUp("2026-12-01", new Date("2026-12-01T00:30:00Z"));
    expect(result.acting).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.reminded + result.waiting).toBeGreaterThanOrEqual(1);
  });

  it("a must-have licence waiting for the team's check does not hold go-live; the team still checks it (owner 27-Nov-2026)", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await walkToFee();
    await payFee(1);
    await saveDraftShopType({ actor: owner, shopType: "GROCERY_KIRANA" });
    await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "UPLOAD", file: { data: PNG, source: "FILE" } });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    await prepareV2Agreement(owner);
    const v = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(v.shop?.status).toBe("APPROVED");
    // The FSSAI file given at registration is with the team: the follow-up does not chase it.
    const { shopsMissingDocuments } = await import("@/server/services/shop-document-follow-up");
    const chased = (await shopsMissingDocuments()).find((c) => c.shop.id === v.shop!.id);
    expect(chased?.missing ?? []).not.toContain("FSSAI");

    const queue = await listRegistrationLicences({ status: "PENDING_OPERATOR" });
    const fssai = queue.find((r) => r.licenceKey === "FSSAI" && r.shopId === v.shop!.id)!;
    expect(fssai).toMatchObject({ option: "UPLOAD", hasFile: true, shopName: "V2 Test Mart" });
    const promised = await listRegistrationLicences({ status: "PROMISED", shopId: v.shop!.id });
    expect(promised[0]?.promiseDueAt).toBeTruthy();

    await expect(reviewRegistrationLicence(fssai.id, { approve: false }, admin)).rejects.toThrow(/reason/);
    const decided = await reviewRegistrationLicence(fssai.id, { approve: true }, admin);
    expect(decided.status).toBe("VERIFIED");
  });
});

describe("owner 27-Nov-2026: licences after go-live, suspension and automatic reinstatement", () => {
  /** A live v2 food shop that promised FSSAI (MUST_HAVE) and the Shop Act at registration. */
  async function liveFoodShopWithPromises() {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await walkToFee();
    await payFee(1);
    await saveDraftShopType({ actor: owner, shopType: "GROCERY_KIRANA" });
    await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "LATER", promise: true });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    await prepareV2Agreement(owner);
    const v = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    // GST verified + fee paid: live at once, FSSAI and the Shop Act promised (no admin approval).
    expect(v.shop?.status).toBe("APPROVED");
    return v.shop!.id;
  }

  /** A reminder day well after the promise period (graceDays from go-live, 90 by default). */
  const afterThePeriod = () => {
    const at = new Date(Date.now() + 130 * 86_400_000);
    const day = `${at.toISOString().slice(0, 8)}01`;
    return { day, now: new Date(`${day}T00:30:00Z`) };
  };
  const shopStatus = async (id: string) => (await db.select({ status: shops.status }).from(shops).where(eq(shops.id, id)))[0].status;
  const asOwner = () => ({ id: owner.id, role: "SHOP_OWNER" as const });

  it("FSSAI upload later does not block signing the seller agreement (prod 28-Nov-2026: BKS-000022 stuck)", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await walkToFee();
    await payFee(1);
    await saveDraftShopType({ actor: owner, shopType: "GROCERY_KIRANA" });
    await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "LATER", promise: true });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    const v = await prepareV2Agreement(owner);
    const [shop] = await db.select().from(shops).where(eq(shops.id, v.shop!.id));
    expect(shop.status).toBe("PENDING_APPROVAL");
    // The licences are promised: nothing to upload before the owner can sign (an expired one would still block).
    expect(await licenceBlockers(shop)).toEqual([]);
  });

  it("FSSAI upload later → live; suspended after the period; reinstated automatically once every document is given", async () => {
    const shopId = await liveFoodShopWithPromises();
    const { day, now } = afterThePeriod();
    const run = await runShopDocumentFollowUp(day as never, now);
    expect(run.suspended).toBeGreaterThanOrEqual(1);
    expect(await shopStatus(shopId)).toBe("SUSPENDED");
    const [suspension] = await db.select().from(shopSuspensions).where(and(eq(shopSuspensions.shopId, shopId), eq(shopSuspensions.status, "ACTIVE")));
    expect(suspension.source).toBe("DOCUMENT_FOLLOW_UP");
    expect(suspension.suspendedBy).toBeNull();

    // FSSAI given (verified online); the Shop Act is still missing: still suspended.
    await submitSellerDocument({ shopId, docType: "FSSAI", number: FSSAI, consentGiven: true, actor: asOwner() });
    expect(await shopStatus(shopId)).toBe("SUSPENDED");
    // The Shop Act sent (Maharashtra: checked by the team — given): live again at once, no person.
    await submitSellerDocument({ shopId, docType: "SHOP_ACT", number: SHOP_ACT, consentGiven: true, actor: asOwner() });
    expect(await shopStatus(shopId)).toBe("APPROVED");
    const [lifted] = await db.select().from(shopSuspensions).where(eq(shopSuspensions.id, suspension.id));
    expect(lifted).toMatchObject({ status: "LIFTED", liftedBy: null });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shopId), eq(auditLogs.action, "shop.reactivated")));
    expect(audits.at(-1)?.newValue).toMatchObject({ automatic: true, source: "DOCUMENT_FOLLOW_UP" });
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.reactivated")));
    expect(told.length).toBeGreaterThanOrEqual(1);
  });

  it("the daily run is the safety net: a suspended shop whose documents arrived some other way comes back", async () => {
    const shopId = await liveFoodShopWithPromises();
    const { day, now } = afterThePeriod();
    await runShopDocumentFollowUp(day as never, now);
    expect(await shopStatus(shopId)).toBe("SUSPENDED");
    // Documents recorded without the upload hooks (e.g. a data fix): the next daily run reinstates the shop.
    await db.insert(sellerVerifications).values([
      { shopId, docType: "FSSAI", status: "VERIFIED" },
      { shopId, docType: "SHOP_ACT", status: "MANUAL_REVIEW" },
    ] as never);
    const next = await runShopDocumentFollowUp("2026-12-02" as never, new Date());
    expect(next.reactivated).toBe(1);
    expect(await shopStatus(shopId)).toBe("APPROVED");
  });

  it("a shop suspended for any other reason is never reinstated automatically", async () => {
    const shopId = await liveFoodShopWithPromises();
    await suspendShopWithPolicy(shopId, { reason: "Repeated customer complaints" }, admin);
    await db.insert(sellerVerifications).values([
      { shopId, docType: "FSSAI", status: "VERIFIED" },
      { shopId, docType: "SHOP_ACT", status: "VERIFIED" },
    ] as never);
    expect(await reactivateIfDocumentsGiven(shopId)).toBe(false);
    expect((await runShopDocumentFollowUp("2026-12-02" as never, new Date())).reactivated).toBe(0);
    expect(await shopStatus(shopId)).toBe("SUSPENDED");
  });

  it("flag off: a documents suspension waits for a person, as before", async () => {
    const shopId = await liveFoodShopWithPromises();
    const { day, now } = afterThePeriod();
    await runShopDocumentFollowUp(day as never, now);
    await setV2(false);
    await submitSellerDocument({ shopId, docType: "FSSAI", number: FSSAI, consentGiven: true, actor: asOwner() });
    await submitSellerDocument({ shopId, docType: "SHOP_ACT", number: SHOP_ACT, consentGiven: true, actor: asOwner() });
    expect(await shopStatus(shopId)).toBe("SUSPENDED");
  });
});

describe("return-to", () => {
  it("keeps a same-site path and ignores anything else", async () => {
    let v = (await startV2Draft(owner, { returnTo: "/franchise/join?zone=1" }))!;
    expect(v.v2?.returnTo).toBe("/franchise/join?zone=1");
    for (const bad of ["//evil.example", "https://evil.example/x", "/\\evil.example", "javascript:alert(1)"]) {
      const other = await verifiedCustomer();
      v = (await startV2Draft(other, { returnTo: bad }))!;
      expect(v.v2?.returnTo).toBeNull();
    }
  });
});

describe("one draft per owner", () => {
  it("a second owner's registration is independent", async () => {
    const other = await verifiedCustomer();
    await walkToFee();
    await walkToFee(other);
    await payFee(1, "SUCCESS", other);
    expect((await view()).v2?.fee.paid).toBe(false);
    expect((await view(other)).v2?.fee.paid).toBe(true);
    expect(randomUUID()).toBeTruthy();
    expect(await db.select().from(registrationLicenceEntries).where(and(eq(registrationLicenceEntries.ownerUserId, owner.id)))).toHaveLength(0);
  });
});

describe("fee money safety", () => {
  async function toAgreement() {
    await saveDraftShopType({ actor: owner, shopType: "WHOLESALE_STORE" }).catch(() => undefined);
    const v = await view();
    for (const l of v.v2!.licences) if (!l.done) await saveLicenceEntry(owner, { licenceKey: l.key, option: "LATER", promise: true });
    return addressAndPin();
  }

  it("switching the band ends the older checkout; paying it is not applied; the new one sets the band, snapshot and ledger", async () => {
    await walkToFee();
    const shopCheckout = await startDraftFeeCheckout(owner, { slab: 1, shopName: "V2 Test Mart" });
    const wholesaleCheckout = await startDraftFeeCheckout(owner, { slab: 2, shopName: "V2 Test Mart" });
    expect(wholesaleCheckout.intentId).not.toBe(shopCheckout.intentId);
    expect((await getPaymentIntent(shopCheckout.intentId!))!.status).toBe("EXPIRED");

    // The owner pays the old (shop) checkout anyway: the gateway's late capture is not applied to the draft.
    const late = await simulateSandboxCheckout({ ref: shopCheckout.intentId!, viewerId: owner.id, outcome: "SUCCESS" }).catch((e: Error) => e.message);
    expect(String(typeof late === "string" ? late : late.outcome)).toBe("LATE_CAPTURE");
    expect((await draftRow()).feePaidAt).toBeNull();

    await simulateSandboxCheckout({ ref: wholesaleCheckout.intentId!, viewerId: owner.id, outcome: "SUCCESS" });
    const paid = await draftRow();
    expect(paid.feePaidAt).not.toBeNull();
    expect((paid.details as { v2Fee: { slab: number } }).v2Fee.slab).toBe(2);
    expect(paid.feePaymentIntentId).toBe(wholesaleCheckout.intentId);
    // Locked once paid: no new checkout, whatever the band.
    await expect(startDraftFeeCheckout(owner, { slab: 1, shopName: "V2 Test Mart" })).rejects.toMatchObject({ details: { reason: "FEE_PAID" } });

    await toAgreement();
    const v = await prepareV2Agreement(owner);
    const [shop] = await db.select().from(shops).where(eq(shops.id, v.shop!.id));
    expect(shop.registrationFeePaise).toBe(wholesaleCheckout.amountPaise);
    const ledger = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shop.id));
    expect(ledger.reduce((sum, p) => sum + Number(p.amountPaise), 0)).toBe(wholesaleCheckout.amountPaise);
  });

  it("the band follows the checkout actually captured, even if the screen changed it meanwhile", async () => {
    await walkToFee();
    const shopCheckout = await startDraftFeeCheckout(owner, { slab: 1, shopName: "V2 Test Mart" });
    // The screen's band moves to 3 without a new checkout (e.g. a second tab before the switch).
    const before = await draftRow();
    const third = await v2FeeQuote({ ownerId: owner.id, slab: 3 });
    await db.update(shopRegistrationDrafts).set({ details: { ...(before.details as object), v2Fee: third } }).where(eq(shopRegistrationDrafts.id, before.id));
    await simulateSandboxCheckout({ ref: shopCheckout.intentId!, viewerId: owner.id, outcome: "SUCCESS" });
    const paid = await draftRow();
    expect((paid.details as { v2Fee: { slab: number } }).v2Fee.slab).toBe(1);
    expect((paid.details as { v2Fee: { totalPaise: number } }).v2Fee.totalPaise).toBe(shopCheckout.amountPaise);
  });

  it("a second capture, or a capture whose amount is not its quote, is not applied", async () => {
    await walkToFee();
    const draft = await draftRow();
    const quote = await v2FeeQuote({ ownerId: owner.id, slab: 1 });
    // Amount ≠ the checkout's quote.
    const wrong = await createPaymentIntent({
      purpose: "SHOP_REGISTRATION_DRAFT_FEE",
      referenceId: draft.id,
      userId: owner.id,
      amountPaise: quote.totalPaise + 100,
      customer: { id: owner.id },
      description: "test",
      idempotencyKey: `test-wrong-${draft.id}`,
      mode: "CHECKOUT",
      metadata: { v2Fee: quote },
    });
    await onDraftFeeCaptured((await getPaymentIntent(wrong.intent.id))!, db);
    expect((await draftRow()).feePaidAt).toBeNull();

    const first = await payFee(1);
    const second = await createPaymentIntent({
      purpose: "SHOP_REGISTRATION_DRAFT_FEE",
      referenceId: draft.id,
      userId: owner.id,
      amountPaise: quote.totalPaise,
      customer: { id: owner.id },
      description: "test",
      idempotencyKey: `test-second-${draft.id}`,
      mode: "CHECKOUT",
      metadata: { v2Fee: quote },
    });
    await onDraftFeeCaptured((await getPaymentIntent(second.intent.id))!, db);
    // Captured twice for the same intent (webhook + reconcile): still once.
    await onDraftFeeCaptured((await getPaymentIntent(first.intentId!))!, db);
    const after = await draftRow();
    expect(after.feePaymentIntentId).toBe(first.intentId);
    expect(await db.select().from(paymentIntents).where(eq(paymentIntents.referenceId, draft.id))).toHaveLength(3);
  });

  it("a failed ledger write is retried (safety net, go-live) and never doubles", async () => {
    await walkToFee();
    const paid = await payFee(1);
    await saveDraftShopType({ actor: owner, shopType: "GENERAL_TRADING" });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    state.failLedger = 1;
    const v = await prepareV2Agreement(owner);
    const shopId = v.shop!.id;
    expect(await db.select().from(shopPayments).where(eq(shopPayments.shopId, shopId))).toHaveLength(0);
    expect((await db.select().from(shops).where(eq(shops.id, shopId)))[0].feePaymentStatus).not.toBe("PAID");

    // The cron safety net puts it on the ledger; a second run finds nothing to do.
    expect(await sweepV2FeeLedger()).toMatchObject({ checked: 1, fixed: 1, failed: 0 });
    expect(await sweepV2FeeLedger()).toMatchObject({ checked: 0 });
    const ledger = await db.select().from(shopPayments).where(eq(shopPayments.shopId, shopId));
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amountPaise)).toBe(paid.amountPaise);

    const live = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(live.shop?.status).toBe("APPROVED");
    expect(await db.select().from(shopPayments).where(eq(shopPayments.shopId, shopId))).toHaveLength(1);
  });

  it("go-live itself retries the ledger write when the safety net has not run yet", async () => {
    await walkToFee();
    await payFee(1);
    await saveDraftShopType({ actor: owner, shopType: "GENERAL_TRADING" });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    state.failLedger = 1;
    const v = await prepareV2Agreement(owner);
    const live = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(live.shop?.status).toBe("APPROVED");
    expect(await db.select().from(shopPayments).where(eq(shopPayments.shopId, v.shop!.id))).toHaveLength(1);
  });
});

describe("0229: Pay later on the fee step (docs/fee-pay-later-2026-11)", () => {
  async function payLaterFlag(enabled: boolean) {
    await setFeatureFlag("shop_fee_pay_later_enabled", { enabled, districtCodes: null }, "pay-later integration test", admin);
  }
  /** Fee step → Pay later → type, licence promise, address and pin: the agreement step. */
  async function askAndFinish() {
    await walkToFee();
    const { requestDraftFeePayLater } = await import("@/server/onboarding-v2/shop-flow");
    const asked = await requestDraftFeePayLater(owner, { slab: 1, shopName: "V2 Test Mart", note: "will pay from first sales" });
    expect(asked.amountPaise).toBeGreaterThan(0);
    expect(asked.view.nextStep).toBe("TYPE");
    expect(asked.view.v2?.fee.payLater).toMatchObject({ status: "REQUESTED", amountPaise: asked.amountPaise });
    await saveDraftShopType({ actor: owner, shopType: "GENERAL_TRADING" });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    const v = await addressAndPin();
    expect(v.nextStep).toBe("SLA");
    return asked.amountPaise;
  }

  it("the owner finishes registering; the shop waits unpaid until an administrator approves, then goes live", async () => {
    await payLaterFlag(true);
    const fee = await askAndFinish();
    await prepareV2Agreement(owner);
    const v = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(v.shop?.status).toBe("PENDING_APPROVAL");
    expect(v.nextStep).toBe("WAITING");
    const shopId = v.shop!.id;
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop).toMatchObject({ registrationFeePaise: fee, feePaymentStatus: "PENDING", amountPaidPaise: 0 });
    const { shopFeePayLater } = await import("@/server/db/schema");
    const [req] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.ownerId, owner.id));
    expect(req).toMatchObject({ status: "REQUESTED", shopId, amountPaise: fee, ownerNote: "will pay from first sales" });

    const { decidePayLater } = await import("@/server/services/fee-pay-later");
    const decided = await decidePayLater(req.id, "APPROVE", null, admin);
    expect(decided).toMatchObject({ live: true, waitingFor: null });
    const [after] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(after).toMatchObject({ status: "APPROVED", feePaymentStatus: "PENDING" });
  });

  it("approved before the owner finishes: the shop goes live as soon as the agreement is accepted", async () => {
    await payLaterFlag(true);
    await askAndFinish();
    const { shopFeePayLater } = await import("@/server/db/schema");
    const [req] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.ownerId, owner.id));
    const { decidePayLater } = await import("@/server/services/fee-pay-later");
    const decided = await decidePayLater(req.id, "APPROVE", null, admin);
    expect(decided.live).toBe(false);
    expect(decided.waitingFor).toMatch(/finish registering/);
    await prepareV2Agreement(owner);
    const v = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(v.shop?.status).toBe("APPROVED");
  });

  it("rejected: the registration returns to the fee step and the owner must pay", async () => {
    await payLaterFlag(true);
    await askAndFinish();
    const { shopFeePayLater } = await import("@/server/db/schema");
    const [req] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.ownerId, owner.id));
    const { decidePayLater } = await import("@/server/services/fee-pay-later");
    await decidePayLater(req.id, "REJECT", "Please pay the fee first", admin);
    const v = await view();
    expect(v.nextStep).toBe("FEE");
    expect(v.v2?.fee.payLater).toMatchObject({ status: "REJECTED", decisionNote: "Please pay the fee first" });
    const { requestDraftFeePayLater } = await import("@/server/onboarding-v2/shop-flow");
    await expect(requestDraftFeePayLater(owner, { slab: 1, shopName: "V2 Test Mart" })).rejects.toMatchObject({ details: { reason: "PAY_LATER_REJECTED" } });
    // Paying works as before.
    await payFee(1);
    expect((await view()).nextStep).not.toBe("FEE");
  });

  it("paying online after asking ends the request; with the flag off the choice is refused", async () => {
    await payLaterFlag(true);
    await askAndFinish();
    await payFee(1);
    const { shopFeePayLater } = await import("@/server/db/schema");
    const [req] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.ownerId, owner.id));
    expect(req.status).toBe("CANCELLED");

    await payLaterFlag(false);
    const other = await verifiedCustomer();
    await walkToFee(other);
    const { requestDraftFeePayLater } = await import("@/server/onboarding-v2/shop-flow");
    await expect(requestDraftFeePayLater(other, { slab: 1, shopName: "Other Mart" })).rejects.toMatchObject({ details: { reason: "PAY_LATER_OFF" } });
    expect((await getWizardDraft(other))!.v2?.fee.payLaterOffered).toBe(false);
  });
});
