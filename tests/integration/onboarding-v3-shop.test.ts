/**
 * Shop onboarding, v3 order (owner, 28-Nov-2026; 0231; docs/onboarding-v2-2026-11/README.md "v3 order"). With the
 * flag onboarding_v2 on, a NEW registration follows: referral → identity (the login sheet; skipped when verified) →
 * seller agreement accepted early → GST / PAN → owner → fee → shop type → address + pin → shop created, agreement
 * applied, live → licences after go-live. Drafts started before keep the v2 order.
 *
 * Also the owner's rule of 28-Nov-2026 ~11.50 IST: an EXPIRED licence at a v2 / v3 registration is renewed after
 * go-live on a promise (never blocks); a live shop and an original-wizard (v1) registration keep the old rule.
 */
import { and, desc, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outbox: [] as { to: string; subject: string; text: string }[] }));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

// The personalised agreements are printed to PDF with Chromium; here a one-page PDF stands in (the hashes, files and
// certificates are still made from it).
vi.mock("@/server/legal-agreements/pdf/html-to-pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/legal-agreements/pdf/html-to-pdf")>();
  return {
    ...real,
    printHtmlToPdf: async (html: string) => {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      doc.setSubject(String(html.length));
      return Buffer.from(await doc.save());
    },
  };
});

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { encryptSecret } from "@/lib/pan-crypto";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  addresses,
  auditLogs,
  legalAcceptances,
  legalDocuments,
  registrationLicenceEntries,
  shopLegalDocuments,
  shopRegistrationDrafts,
  shopSuspensions,
  shops,
  users,
} from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { ensureBundledTemplates, publishTemplate } from "@/server/legal-agreements/registry";
import { acceptAgreementsAtRegistration } from "@/server/legal-agreements/signing";
import { getAgreementStatus, licenceBlockers } from "@/server/legal-agreements/requirements";
import {
  acceptV3EarlyAgreement,
  answerV3PostLiveLicences,
  applyGuestReferral,
  checkGuestShopReferral,
  checkLinkReferral,
  earlyAgreementHtml,
  saveShopAddressForOwner,
} from "@/server/onboarding-v2/early-agreement";
import { acceptV2Agreement, prepareV2Agreement, saveLicenceEntry, startDraftFeeCheckout, startV2Draft } from "@/server/onboarding-v2/shop-flow";
import { afterShopDocumentGiven } from "@/server/onboarding-v2/document-reactivation";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { createReferralCode } from "@/server/services/referrals";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { runShopDocumentFollowUp } from "@/server/services/shop-document-follow-up";
import { submitSellerDocument } from "@/server/services/seller-verification";
import { submitDraftGstin } from "@/server/services/shop-registration-draft";
import {
  answerDraftReferral,
  getWizardDraft,
  saveDraftAddress,
  saveDraftLocation,
  saveDraftOwner,
  saveDraftShopType,
} from "@/server/services/shop-registration-wizard";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const COMPANY_PAN = "AABCG1234K";
const FSSAI = "11521998000123";
/** The mock KYC adapter: a number ending 8888 is expired (valid until 10 days ago). */
const FSSAI_EXPIRED = "11521998008888";
const SHOP_ACT = "PMC/SHOP/2026/12345";

type Owner = { id: string; role: "CUSTOMER"; email: string };
let admin: { id: string; role: "ADMIN"; email: string };
let owner: Owner;

async function setV2(enabled: boolean) {
  await setFeatureFlag("onboarding_v2", { enabled, districtCodes: null }, "v3 integration test", admin);
}
const agreementsFlag = (enabled: boolean) => setFeatureFlag("seller_agreements_enabled", { enabled, districtCodes: null }, "v3 integration test", admin);

async function publishAgreements() {
  await ensureBundledTemplates(admin.id);
  for (const docType of ["SELLER_SLA", "MEDICAL_ONBOARDING"] as const) {
    const [row] = await db.select().from(legalDocuments).where(and(eq(legalDocuments.docType, docType), eq(legalDocuments.language, "en"))).limit(1);
    await publishTemplate(row.id, { id: admin.id, role: "ADMIN" }, { acknowledgeWarnings: true });
  }
}

/** A customer who already proved e-mail and mobile — as the login sheet leaves a guest. */
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
  admin = { id: a.id, role: "ADMIN", email: a.email };
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
const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];

async function acceptEarly(who: Owner = owner, ip = "203.0.113.9") {
  const v = await view(who);
  return acceptV3EarlyAgreement(who, {
    signerName: "Asha Early Signer",
    accepted: (v.v2?.early?.documents ?? []).map((d) => ({ docType: d.docType, version: d.version })),
    acceptPolicies: true,
    acceptUndertaking: true,
    acceptLicencePromise: true,
    ip,
    userAgent: "Mozilla/5.0 (v3 test)",
  });
}

async function payFee(who: Owner = owner) {
  const started = await startDraftFeeCheckout(who, { slab: 1, shopName: "V3 Test Mart" });
  await simulateSandboxCheckout({ ref: started.intentId!, viewerId: who.id, outcome: "SUCCESS" });
}

async function addressAndPin(who: Owner = owner) {
  await saveDraftAddress({
    actor: who,
    address: { addressLine1: "Shop No 7, Market Yard", addressLine2: null, area: "Gultekdi", city: "Pune", state: "Maharashtra", pincode: "411037", landmark: null },
  });
  return saveDraftLocation({ actor: who, latitude: 18.4869, longitude: 73.8655 });
}

/** The whole v3 order up to the last screen (the shop is not created yet). */
async function walkToCreate(who: Owner = owner, shopType = "GROCERY_KIRANA") {
  await startV2Draft(who);
  await answerDraftReferral({ actor: who, referralCode: null });
  await acceptEarly(who);
  await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: who });
  await saveDraftOwner({ actor: who, ownerName: "Test Seller" });
  await payFee(who);
  await saveDraftShopType({ actor: who, shopType });
  return addressAndPin(who);
}

describe("v3 order", () => {
  it("a new draft is v3; each step in the owner's order; the shop is created and live with no second agreement screen", async () => {
    // A customer whose mobile is not verified yet (the identity step is shown, not skipped).
    await db.update(users).set({ phoneVerifiedAt: null }).where(eq(users.id, owner.id));
    const first = (await startV2Draft(owner))!;
    expect((await draftRow()).flowOrder).toBe("v3");
    expect(first.v2?.order).toBe("v3");
    expect(first.nextStep).toBe("REFERRAL");
    expect((await answerDraftReferral({ actor: owner, referralCode: null })).nextStep).toBe("V2_IDENTITY");
    // The login sheet (or this screen) verifies the mobile: the identity step is done.
    await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, owner.id));
    const atAgreement = await view();
    expect(atAgreement.nextStep).toBe("V3_AGREEMENT");
    // Agreements switched off here: the Seller Terms / undertaking / licence-promise ticks and the name.
    expect(atAgreement.v2?.early?.agreementsEnabled).toBe(false);
    await expect(
      acceptV3EarlyAgreement(owner, { signerName: "Asha", accepted: [], acceptPolicies: true, acceptUndertaking: false, acceptLicencePromise: true }),
    ).rejects.toMatchObject({ details: { reason: "SELLER_ACCEPTANCE_REQUIRED" } });
    expect((await acceptEarly()).nextStep).toBe("IDENTITY");
    expect((await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner }).then(() => view())).nextStep).toBe("OWNER");
    expect((await saveDraftOwner({ actor: owner, ownerName: "Test Seller" })).nextStep).toBe("FEE");
    await payFee();
    expect((await view()).nextStep).toBe("TYPE");
    // No licences screen before go-live in v3.
    expect((await saveDraftShopType({ actor: owner, shopType: "GROCERY_KIRANA" })).nextStep).toBe("ADDRESS");
    expect((await addressAndPin()).nextStep).toBe("SLA");

    const done = await prepareV2Agreement(owner, { ip: "198.51.100.1" });
    expect(done.shop?.status).toBe("APPROVED");
    const draft = await draftRow();
    expect(draft.earlyAgreementAppliedAt).not.toBeNull();
    // Accepted at registration: the stored time, not the time the shop was created.
    expect(draft.slaAcceptedAt?.getTime()).toBe(draft.earlyAgreementAcceptedAt?.getTime());
    // After go-live: the licences screen (FSSAI, Shop Act promised), then products.
    expect(done.nextStep).toBe("V3_LICENCES");
    expect(done.v2?.postLive?.promisedLicences.map((l) => l.key)).toEqual(expect.arrayContaining(["FSSAI"]));
    const later = await answerV3PostLiveLicences(owner);
    expect(later.nextStep).toBe("LIVE");
    const applied = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.id), eq(auditLogs.action, "shop_registration_draft.early_agreement_applied")));
    expect(applied).toHaveLength(1);
    expect(applied[0].ipAddress).toBe("203.0.113.9");
  });

  it("go-live without any licence: every required licence promised, the shop's promise and due date set, the follow-up suspends and upload reactivates", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await walkToCreate();
    const live = await prepareV2Agreement(owner);
    const shopId = live.shop!.id;
    expect((await shopRow(shopId)).status).toBe("APPROVED");
    const entries = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.shopId, shopId));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) expect(e).toMatchObject({ option: "LATER", status: "PROMISED" });
    const shop = await shopRow(shopId);
    expect(shop.documentsPromisedAt).not.toBeNull();
    expect(shop.documentsDueAt).not.toBeNull();

    const at = new Date(Date.now() + 130 * 86_400_000);
    const day = `${at.toISOString().slice(0, 8)}01`;
    await runShopDocumentFollowUp(day as never, new Date(`${day}T00:30:00Z`));
    expect((await shopRow(shopId)).status).toBe("SUSPENDED");
    const asOwner = { id: owner.id, role: "SHOP_OWNER" as const };
    await submitSellerDocument({ shopId, docType: "FSSAI", number: FSSAI, consentGiven: true, actor: asOwner });
    await submitSellerDocument({ shopId, docType: "SHOP_ACT", number: SHOP_ACT, consentGiven: true, actor: asOwner });
    expect((await shopRow(shopId)).status).toBe("APPROVED");
  });

  it("with seller agreements on: the published text at step 2; the acceptance applied to the personalised agreement at creation (ticks + name, stored time and IP)", async () => {
    await publishAgreements();
    await agreementsFlag(true);
    await startV2Draft(owner);
    await answerDraftReferral({ actor: owner, referralCode: null });
    const at = await view();
    expect(at.v2?.early?.agreementsEnabled).toBe(true);
    // Only the documents every shop type signs (not the medical one): the shop type is chosen later.
    expect(at.v2?.early?.documents.map((d) => d.docType)).toEqual(["SELLER_SLA"]);
    const text = await earlyAgreementHtml("SELLER_SLA", "en");
    expect(text.html).toContain("[your shop");
    // A document not ticked is refused.
    await expect(
      acceptV3EarlyAgreement(owner, { signerName: "Asha Early Signer", accepted: [], acceptPolicies: true, acceptUndertaking: true, acceptLicencePromise: true }),
    ).rejects.toMatchObject({ details: { reason: "SELLER_ACCEPTANCE_REQUIRED" } });
    await acceptEarly(owner, "203.0.113.77");
    const stored = await draftRow();
    expect(stored.earlyAgreementName).toBe("Asha Early Signer");
    expect(stored.earlyAgreementIp).toBe("203.0.113.77");

    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
    await saveDraftOwner({ actor: owner, ownerName: "Test Seller" });
    await payFee();
    await saveDraftShopType({ actor: owner, shopType: "GROCERY_KIRANA" });
    await addressAndPin();
    const live = await prepareV2Agreement(owner);
    const shopId = live.shop!.id;
    expect(live.shop?.status).toBe("APPROVED");
    expect(live.nextStep).not.toBe("SLA");
    const rows = await db.select().from(legalAcceptances).where(eq(legalAcceptances.shopId, shopId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ docType: "SELLER_SLA", signatureMethod: "REGISTRATION_ACCEPT", signerName: "Asha Early Signer", ipAddress: "203.0.113.77" });
    expect(rows[0].acceptedAt.getTime()).toBe(stored.earlyAgreementAcceptedAt!.getTime());
    expect((await getAgreementStatus(shopId)).required).toBe(false);
  }, 180_000);

  it("a medical shop: the medical agreement not seen at step 2 is still asked on the agreement screen (the SLA is already applied)", async () => {
    await publishAgreements();
    await agreementsFlag(true);
    await walkToCreate(owner, "PHARMACY");
    const v = await prepareV2Agreement(owner);
    expect(v.shop?.status).toBe("PENDING_APPROVAL");
    expect(v.nextStep).toBe("SLA");
    const status = await getAgreementStatus(v.shop!.id);
    expect(status.documents.find((d) => d.docType === "SELLER_SLA")?.signed).toBe(true);
    expect(status.documents.find((d) => d.docType === "MEDICAL_ONBOARDING")?.signed).toBe(false);
  }, 180_000);
});

describe("guest entry: referral first, then the login sheet", () => {
  it("checks the guest's code with the referral step's rule; after the sheet the referral is saved and identity is done", async () => {
    await expect(checkGuestShopReferral("NOSUCHCODE")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await checkGuestShopReferral(null)).toEqual({ code: null });
    // Back from the sheet (signed in, e-mail and mobile verified): /shop/register?confirmed=1.
    await startV2Draft(owner);
    expect(await applyGuestReferral(owner, null)).toBe(true);
    const v = await view();
    expect(v.referral.answered).toBe(true);
    expect(v.v2?.identity.done).toBe(true);
    expect(v.nextStep).toBe("V3_AGREEMENT");
    // Not asked again, and never twice.
    expect(await applyGuestReferral(owner, null)).toBe(false);
  });
});

describe("shared referral link (owner, 28-Nov-2026 ~11.45 IST): no referral screen", () => {
  it("a valid link code is checked silently, saved on the draft as from a shared link; a verified customer goes straight to the agreement", async () => {
    await createReferralCode({ code: "LINKPN01", label: "dealer share link" }, admin);
    // Guest: the page checks the code silently and shows step 2 (identity), not the referral step.
    expect(await checkLinkReferral("linkpn01")).toEqual({ ok: true, code: "LINKPN01" });
    // Signed in (the sheet done, or already a verified customer): the draft's referral is answered from the link.
    await startV2Draft(owner);
    expect(await applyGuestReferral(owner, "LINKPN01", "SHARED_LINK")).toBe(true);
    const v = await view();
    expect(v.nextStep).toBe("V3_AGREEMENT");
    const draft = await draftRow();
    expect(draft.referralCode).toBe("LINKPN01");
    expect((draft.details as Record<string, unknown>).referralSource).toBe("SHARED_LINK");
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.id), eq(auditLogs.action, "shop_registration_draft.referral_auto_applied")));
    expect(audit[0]?.newValue).toMatchObject({ referralCode: "LINKPN01", source: "SHARED_LINK" });
  });

  it("a guest whose identity is not verified yet lands on the identity step (login sheet) after the link code is saved", async () => {
    await createReferralCode({ code: "LINKPN02", label: "dealer share link" }, admin);
    await db.update(users).set({ phoneVerifiedAt: null }).where(eq(users.id, owner.id));
    await startV2Draft(owner);
    expect(await applyGuestReferral(owner, "LINKPN02", "SHARED_LINK")).toBe(true);
    expect((await view()).nextStep).toBe("V2_IDENTITY");
  });

  it("an invalid or unknown link code: the referral step is shown, with a plain message", async () => {
    const link = await checkLinkReferral("BADCODE9");
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.message).toMatch(/The referral code in your link \(BADCODE9\) can't be used/);
    await startV2Draft(owner);
    expect(await applyGuestReferral(owner, "BADCODE9", "SHARED_LINK")).toBe(false);
    expect((await view()).nextStep).toBe("REFERRAL");
    // No code at all: nothing to say, the step simply asks.
    expect(await checkLinkReferral(null)).toEqual({ ok: false, message: null });
  });
});

describe("shop address = the owner's default delivery address", () => {
  it("saved as the default when the owner has none; idempotent", async () => {
    await walkToCreate();
    const live = await prepareV2Agreement(owner);
    const saved = await db.select().from(addresses).where(eq(addresses.userId, owner.id));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ label: "Shop", line1: "Shop No 7, Market Yard", pincode: "411037", isDefault: true });
    await saveShopAddressForOwner(await shopRow(live.shop!.id));
    expect(await db.select().from(addresses).where(eq(addresses.userId, owner.id))).toHaveLength(1);
  });

  it("not the default when the owner already has a default address", async () => {
    await db.insert(addresses).values({ userId: owner.id, label: "Home", line1: "Flat 2, Sai Residency", city: "Pune", pincode: "411001", isDefault: true });
    await walkToCreate();
    await prepareV2Agreement(owner);
    const saved = await db.select().from(addresses).where(eq(addresses.userId, owner.id));
    expect(saved).toHaveLength(2);
    expect(saved.find((a) => a.label === "Home")?.isDefault).toBe(true);
    expect(saved.find((a) => a.label === "Shop")?.isDefault).toBe(false);
  });
});

describe("drafts started before keep their order", () => {
  it("a v2 draft (no flow_order) stays on the v2 order; the order switch is a rule", async () => {
    await setRule("onboardingV2", { shopRegistrationOrder: "v2" }, admin);
    const other = await verifiedCustomer();
    await db.update(users).set({ phoneVerifiedAt: null }).where(eq(users.id, other.id));
    await startV2Draft(other);
    expect((await draftRow(other)).flowOrder).toBeNull();
    await setRule("onboardingV2", { shopRegistrationOrder: "v3" }, admin);
    // v2 order: identity first (before the referral), the licences screen before the address, no early agreement.
    const v = await view(other);
    expect(v.v2?.order).toBe("v2");
    expect(v.nextStep).toBe("V2_IDENTITY");
    await expect(acceptEarly(other)).rejects.toMatchObject({ details: { reason: "NOT_V3" } });
  });
});

describe("expired licence at a registration (owner, 28-Nov-2026 ~11.50 IST)", () => {
  async function v2Draft(who: Owner = owner) {
    await setRule("onboardingV2", { shopRegistrationOrder: "v2" }, admin);
    await startV2Draft(who);
    await answerDraftReferral({ actor: who, referralCode: null });
    await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: who });
    await saveDraftOwner({ actor: who, ownerName: "Test Seller" });
    await payFee(who);
    await saveDraftShopType({ actor: who, shopType: "GROCERY_KIRANA" });
  }

  it("v2: an expired FSSAI number asks for the renewal promise (the line names date and days); promised → live; chased, suspended, reinstated on a valid upload", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    await v2Draft();
    const refused = saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "ENTER", number: FSSAI_EXPIRED, consent: true });
    await expect(refused).rejects.toMatchObject({ details: { reason: "LICENCE_EXPIRED" } });
    await expect(refused).rejects.toThrow(/expired on .* — renew and upload the new one within 90 days or the shop will be paused\./);
    await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "ENTER", number: FSSAI_EXPIRED, consent: true, renewalPromise: true });
    const [entry] = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.licenceKey, "FSSAI"));
    expect(entry).toMatchObject({ status: "PROMISED" });
    expect(entry.expiredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.renewalPromisedAt).not.toBeNull();
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "shop_registration_draft.licence_renewal_promised"));
    expect(audit[0]?.newValue).toMatchObject({ licenceKey: "FSSAI", expiredOn: entry.expiredOn });

    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    await prepareV2Agreement(owner);
    const live = await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(live.shop?.status).toBe("APPROVED");
    const shopId = live.shop!.id;

    const at = new Date(Date.now() + 130 * 86_400_000);
    const day = `${at.toISOString().slice(0, 8)}01`;
    await runShopDocumentFollowUp(day as never, new Date(`${day}T00:30:00Z`));
    expect((await shopRow(shopId)).status).toBe("SUSPENDED");
    const asOwner = { id: owner.id, role: "SHOP_OWNER" as const };
    await submitSellerDocument({ shopId, docType: "FSSAI", number: FSSAI, consentGiven: true, actor: asOwner });
    await submitSellerDocument({ shopId, docType: "SHOP_ACT", number: SHOP_ACT, consentGiven: true, actor: asOwner });
    expect((await shopRow(shopId)).status).toBe("APPROVED");
    const [lifted] = await db.select().from(shopSuspensions).where(eq(shopSuspensions.shopId, shopId));
    expect(lifted.status).toBe("LIFTED");
  });

  it("an expired licence on file at the agreement step: no blocker, the renewal promise is required, recorded, chased; a valid renewed licence reinstates", async () => {
    await publishAgreements();
    await agreementsFlag(true);
    await v2Draft();
    await saveLicenceEntry(owner, { licenceKey: "FSSAI", option: "LATER", promise: true });
    await saveLicenceEntry(owner, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
    await addressAndPin();
    const prepared = await prepareV2Agreement(owner);
    const shopId = prepared.shop!.id;
    // The FSSAI licence on file has expired.
    await db.insert(shopLegalDocuments).values({ shopId, docType: "FSSAI", status: "APPROVED", numberEncrypted: encryptSecret(FSSAI), numberLast4: "0123", expiryDate: "2026-01-31", submittedAt: new Date() });
    const status = await getAgreementStatus(shopId);
    expect(status.blockers).toEqual([]);
    expect(status.renewals).toEqual([expect.objectContaining({ key: "FSSAI", expiredOn: "2026-01-31", days: 90 })]);
    expect(status.renewals[0].message).toBe("FSSAI licence expired on 31-Jan-2026 — renew and upload the new one within 90 days or the shop will be paused.".replace("FSSAI licence", status.renewals[0].label));

    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    const input = {
      signerName: "Asha Test Owner",
      designation: "DIRECTOR" as const,
      constitution: "COMPANY" as const,
      pharmacist: null,
      accepted: status.documents.map((d) => ({ docType: d.docType, version: d.version })),
      languageViewed: "en" as const,
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0",
      geo: null,
    };
    await expect(acceptAgreementsAtRegistration({ shopId, owner: u }, input)).rejects.toMatchObject({ details: { reason: "RENEWAL_PROMISE_REQUIRED" } });
    await acceptAgreementsAtRegistration({ shopId, owner: u }, { ...input, renewalPromise: true });
    const [renewal] = await db.select().from(registrationLicenceEntries).where(and(eq(registrationLicenceEntries.shopId, shopId), eq(registrationLicenceEntries.licenceKey, "FSSAI")));
    expect(renewal).toMatchObject({ status: "PROMISED", expiredOn: "2026-01-31" });
    expect(renewal.renewalPromisedAt).not.toBeNull();
    const live = await acceptV2Agreement(owner, { acceptUndertaking: true });
    expect(live.shop?.status).toBe("APPROVED");

    // Chased like a missing promised licence: suspended after the period even though an (expired) copy is on file.
    const at = new Date(Date.now() + 130 * 86_400_000);
    const day = `${at.toISOString().slice(0, 8)}01`;
    await submitSellerDocument({ shopId, docType: "SHOP_ACT", number: SHOP_ACT, consentGiven: true, actor: { id: owner.id, role: "SHOP_OWNER" } });
    await runShopDocumentFollowUp(day as never, new Date(`${day}T00:30:00Z`));
    expect((await shopRow(shopId)).status).toBe("SUSPENDED");
    // The renewed licence (valid) uploaded: reinstated automatically.
    await db.update(shopLegalDocuments).set({ expiryDate: "2031-01-31", updatedAt: new Date() }).where(and(eq(shopLegalDocuments.shopId, shopId), eq(shopLegalDocuments.docType, "FSSAI")));
    await db.insert((await import("@/server/db/schema")).sellerVerifications).values({ shopId, docType: "FSSAI", status: "VERIFIED" } as never);
    await afterShopDocumentGiven(shopId);
    expect((await shopRow(shopId)).status).toBe("APPROVED");
  }, 180_000);

  it("a shop already live keeps the current rule: an expired (or missing) licence blocks re-signing", async () => {
    await publishAgreements();
    await agreementsFlag(true);
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(shopOwner.id, { shopType: "GROCERY_KIRANA", name: "Live Shop" });
    await db.update(shops).set({ status: "APPROVED" }).where(eq(shops.id, shop.id));
    // Registered through v2 (and live now): no registration leniency any more.
    await db.insert(shopRegistrationDrafts).values({ ownerId: shopOwner.id, flowVersion: "v2", flowOrder: "v3", status: "COMPLETED", shopId: shop.id, slaAcceptedAt: new Date() });
    await db.insert(shopLegalDocuments).values({ shopId: shop.id, docType: "FSSAI", status: "APPROVED", numberEncrypted: encryptSecret(FSSAI), numberLast4: "0123", expiryDate: "2026-01-31", submittedAt: new Date() });
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    const blockers = await licenceBlockers({ id: shop.id, shopType: "GROCERY_KIRANA" });
    expect(blockers.some((b) => /expired on 31-Jan-2026 — upload the renewed licence first/.test(b))).toBe(true);
    const status = await getAgreementStatus(shop.id);
    expect(status.renewals).toEqual([]);
  });

  it("an original-wizard (v1) registration keeps FSSAI first: a missing FSSAI still blocks signing", async () => {
    await setRule("documentUpload", { fssaiMandatoryForFood: true }, admin);
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(shopOwner.id, { shopType: "GROCERY_KIRANA", name: "V1 Shop" });
    await db.update(shops).set({ status: "PENDING_APPROVAL" }).where(eq(shops.id, shop.id));
    await db.insert(shopRegistrationDrafts).values({ ownerId: shopOwner.id, flowVersion: null, status: "SUBMITTED", shopId: shop.id });
    const blockers = await licenceBlockers({ id: shop.id, shopType: "GROCERY_KIRANA" });
    expect(blockers.some((b) => /FSSAI/i.test(b))).toBe(true);
  });
});
