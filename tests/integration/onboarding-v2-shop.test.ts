/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11). With the flag onboarding_v2 on a new
 * registration follows: identity → referral → GST / PAN → owner name → fee (Shop / Wholesale, paid on the draft)
 * → shop type → licences (enter / upload / scan / later) → address → pin → seller agreement → live.
 *
 *   - flag off: a new draft is the original wizard (flow_version null, no v2 view)
 *   - identity: Terms + e-mail code + mobile (SMS code, or saved unverified with no SMS — DEFAULT #8); skipped for
 *     a verified customer
 *   - fee by kind from rule onboardingV2 (+GST when feeGstExtra); wholesale fixes the type; pending payment resumes
 *   - each licence option; MUST_HAVE refuses "Upload later"; the promise reaches the document follow-up
 *   - go-live: GST verified + fee paid → live after the agreement (never before); else the team's review, with the
 *     operator queue for a licence waiting on the team
 *   - background: wallet + role history; return-to only for same-site paths
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outbox: [] as { to: string; subject: string; text: string }[] }));

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
  onboardingRoleHistory,
  outboundTestMessages,
  registrationLicenceEntries,
  registrationLicenceFiles,
  shopPayments,
  shopRegistrationDrafts,
  shops,
  users,
  wallets,
} from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import {
  acceptV2Agreement,
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
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { runShopDocumentFollowUp } from "@/server/services/shop-document-follow-up";
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

async function payFee(kind: "SHOP" | "WHOLESALE", outcome: "SUCCESS" | "FAILURE" = "SUCCESS", who: Owner = owner) {
  const started = await startDraftFeeCheckout(who, { kind, shopName: "V2 Test Mart" });
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

describe("step 4: the fee, paid on the draft", () => {
  it("charges the rule's amount by kind, with GST on top when feeGstExtra is on", async () => {
    await setRule("onboardingV2", { shopFeePaise: 100_000, wholesaleFeePaise: 250_000, feeGstExtra: true }, admin);
    const v = await walkToFee();
    expect(v.nextStep).toBe("FEE");
    expect(v.v2?.names.shopName).toBeTruthy();
    const shopQuote = await v2FeeQuote("SHOP");
    expect(shopQuote.basePaise).toBe(100_000);
    expect(shopQuote.totalPaise).toBe(100_000 + shopQuote.gstPaise);
    expect(shopQuote.gstPaise).toBeGreaterThan(0);
    const started = await startDraftFeeCheckout(owner, { kind: "WHOLESALE", shopName: "V2 Wholesale" });
    const wholesale = await v2FeeQuote("WHOLESALE");
    expect(wholesale.basePaise).toBe(250_000);
    expect(started.amountPaise).toBe(wholesale.totalPaise);

    await setRule("onboardingV2", { feeGstExtra: false }, admin);
    expect((await v2FeeQuote("SHOP")).totalPaise).toBe(100_000);
  });

  it("wholesale fixes the shop type to Wholesale store and skips the type step", async () => {
    await walkToFee();
    await payFee("WHOLESALE");
    const v = await view();
    expect(v.v2?.fee).toMatchObject({ paid: true, chosen: "WHOLESALE" });
    expect(v.shopType).toBe("WHOLESALE_STORE");
    expect(v.nextStep).toBe("V2_LICENCES");
    await expect(saveDraftShopType({ actor: owner, shopType: "GENERAL_TRADING" })).rejects.toMatchObject({ details: { reason: "SHOP_TYPE_FIXED_BY_FEE" } });
  });

  it("a failed payment leaves the draft pending payment; the owner resumes and pays", async () => {
    await walkToFee();
    await payFee("SHOP", "FAILURE");
    let v = await view();
    expect(v.status).toBe("OPEN");
    expect(v.nextStep).toBe("FEE");
    expect(v.v2?.fee).toMatchObject({ paid: false, lastFailed: true });
    expect((await draftRow()).feePaidAt).toBeNull();
    // No shop exists yet: the owner is still only a customer.
    expect(await db.select().from(shops).where(eq(shops.ownerId, owner.id))).toHaveLength(0);

    await payFee("SHOP");
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
    await payFee("SHOP");
    return saveDraftShopType({ actor: owner, shopType });
  }

  it("lists what the admin's rules require and records each option", async () => {
    let v = await toLicences("GROCERY_KIRANA");
    expect(v.nextStep).toBe("V2_LICENCES");
    const keys = v.v2!.licences.map((l) => l.key).sort();
    expect(keys).toEqual(["FSSAI", "SHOP_ACT"]);
    expect(v.v2!.licences.find((l) => l.key === "FSSAI")).toMatchObject({ level: "MUST_HAVE", laterAllowed: false });

    // MUST_HAVE: no "Upload later" (DEFAULT #12).
    await expect(saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "LATER", promise: true })).rejects.toMatchObject({ details: { reason: "LICENCE_MUST_HAVE" } });

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
    await payFee("SHOP");
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

  it("goes to the team's review when a must-have licence waits for an operator; the operator decides it", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await walkToFee();
    await payFee("SHOP");
    await saveDraftShopType({ actor: owner, shopType: "GROCERY_KIRANA" });
    await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "UPLOAD", file: { data: PNG, source: "FILE" } });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    await prepareV2Agreement(owner);
    const v = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(v.shop?.status).toBe("PENDING_APPROVAL");
    expect(v.nextStep).toBe("WAITING");

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
    await payFee("SHOP", "SUCCESS", other);
    expect((await view()).v2?.fee.paid).toBe(false);
    expect((await view(other)).v2?.fee.paid).toBe(true);
    expect(randomUUID()).toBeTruthy();
    expect(await db.select().from(registrationLicenceEntries).where(and(eq(registrationLicenceEntries.ownerUserId, owner.id)))).toHaveLength(0);
  });
});
