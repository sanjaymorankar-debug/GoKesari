/**
 * Flow spec v3, wave 3 (docs/flows-v3/wave3.md): F4 shop onboarding, F5 licence reminders, F6 shop subscription.
 * Every item is checked with its flag ON and OFF (OFF = exactly the behaviour before wave 3).
 *
 *   flow_f5  licences given at an onboarding v2 registration go into the shop's licence register (shop creation,
 *            the team's decision, the daily back-fill), count as on file, follow a decision made in the
 *            legal-documents queue, and a promised licence given later is marked given
 *   flow_f4  optional WhatsApp number + payment QR on the agreement step; the accepted agreement e-mailed in EN / MR / HI
 *   flow_f6  the first year starts at go-live; reminders and online renewal on whatever rule shopMembership says
 */
import { and, desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  documentEmails,
  invSettings,
  registrationLicenceEntries,
  shopLegalDocumentFiles,
  shopLegalDocuments,
  shopMembershipPeriods,
  shops,
  users,
} from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import {
  acceptV2Agreement,
  listRegistrationLicences,
  prepareV2Agreement,
  reviewRegistrationLicence,
  saveLicenceEntry,
  startDraftFeeCheckout,
  startV2Draft,
} from "@/server/onboarding-v2/shop-flow";
import { anchorAtGoLive } from "@/server/flows/f6-subscription";
import { backfillRegistrationLicences, registerSlotOf } from "@/server/flows/f5-licences";
import { parseWhatsappNumber, registrationContactView, saveRegistrationContact, sellerTermsAcceptedEmail } from "@/server/flows/f4-onboarding";
import { shopMembershipRuleForFlows } from "@/server/flows/wave3-rules";
import { qrSvg } from "@/server/shop-banner/render";
import { addMonths } from "@/server/services/shop-membership";
import { decideLegalDocument, submitLegalDocument } from "@/server/services/legal-documents";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { requirementsOnFile } from "@/server/services/shop-document-rules";
import { runShopDocumentFollowUp } from "@/server/services/shop-document-follow-up";
import { runRegistrationSubscriptionJob } from "@/server/services/shop-registration-subscription";
import { submitDraftGstin } from "@/server/services/shop-registration-draft";
import { answerDraftReferral, saveDraftAddress, saveDraftLocation, saveDraftOwner, saveDraftShopType } from "@/server/services/shop-registration-wizard";
import { createUser, resetDatabase } from "../helpers/fixtures";

const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const COMPANY_PAN = "AABCG1234K";
const DRUG = "MH-PZ1-123456";
/** A tiny valid PNG (1×1). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const DAY = 86_400_000;

type Owner = { id: string; role: "CUSTOMER"; email: string };
let admin: { id: string; role: "ADMIN" };
let owner: Owner;

async function flag(key: "onboarding_v2" | "flow_f4" | "flow_f5" | "flow_f6", enabled: boolean) {
  await setFeatureFlag(key, { enabled, districtCodes: null }, "Flows v3 wave 3 integration test", admin);
}

beforeEach(async () => {
  resetRateLimits();
  clearRuleCache();
  await resetDatabase();
  setKycAdapterForTests(createMockAdapter());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await flag("onboarding_v2", true);
  // These cases walk the v2 order (drafts started before 28-Nov-2026); the v3 order is onboarding-v3-shop.test.ts.
  await setRule("onboardingV2", { shopRegistrationOrder: "v2" }, admin);
  for (const f of ["flow_f4", "flow_f5", "flow_f6"] as const) await flag(f, false);
  const u = await createUser({ role: "CUSTOMER" });
  await db.update(users).set({ emailVerified: new Date(), phoneVerifiedAt: new Date() }).where(eq(users.id, u.id));
  owner = { id: u.id, role: "CUSTOMER", email: u.email };
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

/** A v2 registration up to the agreement step (the shop row exists, PENDING_APPROVAL). */
async function toAgreement(shopType: string, licences: (who: Owner) => Promise<void>): Promise<string> {
  await startV2Draft(owner);
  await answerDraftReferral({ actor: owner, referralCode: null });
  await submitDraftGstin({ gstin: gstinFor(COMPANY_PAN), consentGiven: true, actor: owner });
  await saveDraftOwner({ actor: owner, ownerName: "Test Seller" });
  const started = await startDraftFeeCheckout(owner, { slab: 1, shopName: "Wave3 Pharmacy" });
  await simulateSandboxCheckout({ ref: started.intentId!, viewerId: owner.id, outcome: "SUCCESS" });
  await saveDraftShopType({ actor: owner, shopType });
  await licences(owner);
  await saveDraftAddress({
    actor: owner,
    address: { addressLine1: "Shop No 4, Main Market", addressLine2: null, area: "Shivajinagar", city: "Pune", state: "Maharashtra", pincode: "411001", landmark: null },
  });
  await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
  const v = await prepareV2Agreement(owner);
  return v.shop!.id;
}

/** A pharmacy that uploaded its drug licence and its Shop Act at registration (both with the team). */
const pharmacy = () =>
  toAgreement("PHARMACY", async (who) => {
    await saveLicenceEntry(who, { licenceKey: "DRUG_LICENCE", option: "UPLOAD", number: DRUG, validUntil: "2030-03-31", file: { data: PNG, source: "FILE" } });
    // A file only (no number): no seller check is started — only the registration entry knows it was given.
    await saveLicenceEntry(who, { licenceKey: "SHOP_ACT", option: "UPLOAD", file: { data: PNG, source: "FILE" } });
  });

const register = (shopId: string) => db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shopId));
const entryOf = async (shopId: string, key: string) =>
  (await db.select().from(registrationLicenceEntries).where(and(eq(registrationLicenceEntries.shopId, shopId), eq(registrationLicenceEntries.licenceKey, key))))[0];
const shopRow = async (id: string) => (await db.select().from(shops).where(eq(shops.id, id)))[0];

/* ===================================================================== F5 */

describe("flow_f5: licences given at registration are in the shop's register", () => {
  it("ON: copied at shop creation (submitted, with its file and number), on file, and approved with the team's decision", async () => {
    await flag("flow_f5", true);
    const shopId = await pharmacy();
    const rows = await register(shopId);
    const drug = rows.find((r) => r.docType === "DRUG_LICENCE")!;
    expect(drug).toMatchObject({ status: "SUBMITTED", licenceKey: "", expiryDate: "2030-03-31", submittedBy: owner.id });
    expect(drug.numberLast4).toBe(DRUG.slice(-4));
    expect(drug.numberEncrypted).not.toContain(DRUG);
    expect(await db.select().from(shopLegalDocumentFiles).where(eq(shopLegalDocumentFiles.documentId, drug.id))).toHaveLength(1);
    // Shop Act is a seller document: no register row, but on file for every "what is missing" view.
    expect(rows.some((r) => r.docType === ("SHOP_ACT" as never))).toBe(false);
    const onFile = await requirementsOnFile((await shopRow(shopId))!);
    expect(onFile.filter((r) => r.level !== "OPTIONAL").every((r) => r.onFile)).toBe(true);
    expect(onFile.find((r) => r.key === "SHOP_ACT")).toMatchObject({ onFile: true, withTeam: true });

    const queued = (await listRegistrationLicences({ status: "PENDING_OPERATOR", shopId })).find((r) => r.licenceKey === "DRUG_LICENCE")!;
    await reviewRegistrationLicence(queued.id, { approve: true }, admin);
    expect((await register(shopId)).find((r) => r.docType === "DRUG_LICENCE")).toMatchObject({ status: "APPROVED", reviewedBy: admin.id });
  });

  it("OFF: nothing is copied and the register does not count the registration licences (as before)", async () => {
    const shopId = await pharmacy();
    expect(await register(shopId)).toHaveLength(0);
    const onFile = await requirementsOnFile((await shopRow(shopId))!);
    expect(onFile.find((r) => r.key === "DRUG_LICENCE")?.onFile).toBe(false);
    expect(onFile.find((r) => r.key === "SHOP_ACT")?.onFile).toBe(false);
    expect(await backfillRegistrationLicences()).toEqual({ shops: 0, copied: 0, promisesGiven: 0 });
  });

  it("ON: the team's rejection in the legal-documents queue reaches the registration entry", async () => {
    await flag("flow_f5", true);
    const shopId = await pharmacy();
    const drug = (await register(shopId)).find((r) => r.docType === "DRUG_LICENCE")!;
    await decideLegalDocument(drug.id, { decision: "reject", reason: "The photo is not readable." }, admin);
    expect(await entryOf(shopId, "DRUG_LICENCE")).toMatchObject({ status: "REJECTED", statusReason: "The photo is not readable." });
    // Rejected: no longer given — the follow-up chases it again.
    const { shopsMissingDocuments } = await import("@/server/services/shop-document-follow-up");
    const chased = (await shopsMissingDocuments({ statuses: ["PENDING_APPROVAL", "APPROVED"] })).find((c) => c.shop.id === shopId);
    expect([...(chased?.missingLicences ?? []), ...(chased?.upcoming.map((u) => u.label) ?? [])].join(" ")).toMatch(/Drug licence/i);
  });

  it("OFF: a decision in the legal-documents queue leaves the registration entry alone", async () => {
    const shopId = await pharmacy();
    await flag("flow_f5", true);
    await backfillRegistrationLicences();
    await flag("flow_f5", false);
    const drug = (await register(shopId)).find((r) => r.docType === "DRUG_LICENCE")!;
    await decideLegalDocument(drug.id, { decision: "approve" }, admin);
    expect((await entryOf(shopId, "DRUG_LICENCE")).status).toBe("PENDING_OPERATOR");
  });

  it("ON: the daily follow-up back-fills a shop created while the flag was off, once", async () => {
    const shopId = await pharmacy();
    expect(await register(shopId)).toHaveLength(0);
    await flag("flow_f5", true);
    await runShopDocumentFollowUp("2026-12-02" as never, new Date());
    expect((await register(shopId)).map((r) => [r.docType, r.status])).toEqual([["DRUG_LICENCE", "SUBMITTED"]]);
    const again = await backfillRegistrationLicences();
    expect(again.copied).toBe(0);
  });

  it("ON: never overwrites a licence the owner sent again from the Documents page", async () => {
    const shopId = await pharmacy();
    await submitLegalDocument({ shopId, docType: "DRUG_LICENCE", number: "MH-NEW-999999", expiryDate: "2031-01-31", file: PNG, actor: { id: owner.id, role: "SHOP_OWNER" } });
    await flag("flow_f5", true);
    await backfillRegistrationLicences();
    const rows = await register(shopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ numberLast4: "9999", expiryDate: "2031-01-31" });
  });

  it("ON / OFF: a licence promised at registration and given later is marked given only with the flag", async () => {
    const promise = () =>
      toAgreement("PHARMACY", async (who) => {
        await saveLicenceEntry(who, { licenceKey: "DRUG_LICENCE", option: "LATER", promise: true });
        await saveLicenceEntry(who, { licenceKey: "SHOP_ACT", option: "LATER", promise: true });
      });
    const shopId = await promise();
    const given = await submitLegalDocument({ shopId, docType: "DRUG_LICENCE", number: DRUG, expiryDate: "2030-03-31", file: PNG, actor: { id: owner.id, role: "SHOP_OWNER" } });
    expect((await entryOf(shopId, "DRUG_LICENCE")).status).toBe("PROMISED");
    expect((await entryOf(shopId, "DRUG_LICENCE")).statusReason).toBeNull();

    await flag("flow_f5", true);
    await backfillRegistrationLicences();
    expect(await entryOf(shopId, "DRUG_LICENCE")).toMatchObject({ status: "PROMISED", statusReason: expect.stringMatching(/Given after registration/) });
    await decideLegalDocument(given.id!, { decision: "approve" }, admin);
    expect((await entryOf(shopId, "DRUG_LICENCE")).status).toBe("VERIFIED");
    // The Shop Act is still only promised.
    expect((await entryOf(shopId, "SHOP_ACT")).status).toBe("PROMISED");
  });

  it("maps register slots: built-in licences by type, admin-added ones as Other licences, seller documents none", () => {
    expect(registerSlotOf("DRUG_LICENCE")).toEqual({ docType: "DRUG_LICENCE", licenceKey: "" });
    expect(registerSlotOf("DOC:PESTICIDE_PERMIT")).toEqual({ docType: "OTHER_LICENCE", licenceKey: "DOC:PESTICIDE_PERMIT" });
    expect(registerSlotOf("SHOP_ACT")).toBeNull();
    expect(registerSlotOf("UDYAM")).toBeNull();
  });
});

/* ===================================================================== F4 */

const qrPng = async (text: string) => sharp(Buffer.from(qrSvg(text, 400))).png().toBuffer();
const promisedGeneralShop = () => toAgreement("GENERAL_TRADING", async (who) => void (await saveLicenceEntry(who, { licenceKey: "SHOP_ACT", option: "LATER", promise: true })));

describe("flow_f4: WhatsApp number and payment QR at registration", () => {
  it("ON: offered on the agreement step; saved to the shop's settings; a bad number or a non-UPI image is refused", async () => {
    await flag("flow_f4", true);
    const shopId = await promisedGeneralShop();
    expect(await registrationContactView(shopId)).toEqual({ whatsappNumber: null, qrVpa: null, qrPayeeName: null });
    await expect(saveRegistrationContact(owner, { whatsappNumber: "12345" })).rejects.toThrow(/10-digit/);
    const saved = await saveRegistrationContact(owner, { whatsappNumber: "+91 98765 43210", qrImage: await qrPng("upi://pay?pa=wave3@ybl&pn=Wave3%20Pharmacy") });
    expect(saved).toEqual({ whatsappNumber: "9876543210", qrVpa: "wave3@ybl", qrPayeeName: "Wave3 Pharmacy" });
    expect((await shopRow(shopId)).whatsappNumber).toBe("9876543210");
    const [settings] = await db.select().from(invSettings).where(eq(invSettings.shopId, shopId));
    expect(settings.bannerUpiQr).toMatch(/^upi:\/\/pay\?pa=wave3@ybl/);
    await expect(saveRegistrationContact(owner, { qrImage: PNG })).rejects.toThrow(/QR/);
    // Optional: "" clears the number.
    expect((await saveRegistrationContact(owner, { whatsappNumber: "" })).whatsappNumber).toBeNull();
  });

  it("OFF: not offered, and the endpoint's service refuses", async () => {
    const shopId = await promisedGeneralShop();
    expect(await registrationContactView(shopId)).toBeNull();
    await expect(saveRegistrationContact(owner, { whatsappNumber: "9876543210" })).rejects.toThrow();
    expect((await shopRow(shopId)).whatsappNumber).toBeNull();
  });

  it("accepts the usual ways of writing an Indian mobile", () => {
    expect(parseWhatsappNumber("09876543210")).toEqual({ ok: true, value: "9876543210" });
    expect(parseWhatsappNumber("919876543210")).toEqual({ ok: true, value: "9876543210" });
    expect(parseWhatsappNumber("  ")).toEqual({ ok: true, value: null });
    expect(parseWhatsappNumber("5876543210").ok).toBe(false);
  });
});

describe("flow_f4: the accepted agreement e-mailed on acceptance (EN / MR / HI)", () => {
  const mails = (shopId: string) => db.select().from(documentEmails).where(and(eq(documentEmails.docId, shopId), eq(documentEmails.docType, "SELLER_TERMS_ACCEPTED")));

  it("ON: the tick path (no agreements engine) sends one e-mail in three languages with links", async () => {
    await flag("flow_f4", true);
    const shopId = await promisedGeneralShop();
    await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    const [mail] = await mails(shopId);
    expect(mail.userId).toBe(owner.id);
    expect(mail.body).toMatch(/English —/);
    expect(mail.body).toMatch(/मराठी —/);
    expect(mail.body).toMatch(/हिंदी —/);
    expect(mail.body).toMatch(/\/legal\/seller-terms/);
  });

  it("OFF: no such e-mail (as before)", async () => {
    const shopId = await promisedGeneralShop();
    await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    expect(await mails(shopId)).toHaveLength(0);
  });

  it("builds the body from the shop's name and the time accepted", () => {
    const m = sellerTermsAcceptedEmail({ shopName: "Ganesh Stores", acceptedAtIst: "27-Nov-2026, 14.35 IST", baseUrl: "https://example.test" });
    expect(m.title).toContain("Ganesh Stores");
    expect(m.body.split("https://example.test/legal/seller-terms")).toHaveLength(4);
  });
});

/* ===================================================================== F6 */

describe("flow_f6: the first year starts at go-live", () => {
  /** The fee was paid 20 days before go-live: the period opened then. */
  async function paidEarlier(shopId: string) {
    const [period] = await db.select().from(shopMembershipPeriods).where(eq(shopMembershipPeriods.shopId, shopId));
    const start = new Date(Date.now() - 20 * DAY);
    const end = addMonths(start, 12);
    await db.update(shopMembershipPeriods).set({ periodStart: start, periodEnd: end }).where(eq(shopMembershipPeriods.id, period.id));
    await db.update(shops).set({ membershipValidUntil: end, registrationStartDate: start }).where(eq(shops.id, shopId));
    return { start, end };
  }

  it("ON: go-live moves the only REGISTRATION period to start that day (12 months from go-live)", async () => {
    await flag("flow_f6", true);
    const shopId = await promisedGeneralShop();
    await paidEarlier(shopId);
    await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    const shop = await shopRow(shopId);
    expect(shop.status).toBe("APPROVED");
    const [period] = await db.select().from(shopMembershipPeriods).where(eq(shopMembershipPeriods.shopId, shopId));
    expect(period.periodStart.getTime()).toBe(shop.approvedAt!.getTime());
    expect(period.periodEnd.getTime()).toBe(addMonths(shop.approvedAt!, 12).getTime());
    expect(shop.membershipValidUntil!.getTime()).toBe(period.periodEnd.getTime());
    expect(shop.registrationStartDate!.getTime()).toBe(shop.approvedAt!.getTime());
  });

  it("OFF: the period keeps the payment date (as before)", async () => {
    const shopId = await promisedGeneralShop();
    const { start, end } = await paidEarlier(shopId);
    await acceptV2Agreement(owner, { acceptSellerTerms: true, acceptUndertaking: true });
    const shop = await shopRow(shopId);
    expect(shop.status).toBe("APPROVED");
    const [period] = await db.select().from(shopMembershipPeriods).where(eq(shopMembershipPeriods.shopId, shopId)).orderBy(desc(shopMembershipPeriods.createdAt));
    expect(period.periodStart.getTime()).toBe(start.getTime());
    expect(shop.membershipValidUntil!.getTime()).toBe(end.getTime());
  });

  it("moves nothing when the period already starts at or after go-live; keeps time added on top", () => {
    const goLive = new Date("2026-12-10T05:00:00Z");
    expect(anchorAtGoLive({ periodStart: goLive, periodEnd: addMonths(goLive, 12) }, null, goLive, 12)).toBeNull();
    const paid = new Date("2026-11-20T05:00:00Z");
    const end = addMonths(paid, 12);
    const moved = anchorAtGoLive({ periodStart: paid, periodEnd: end }, new Date(end.getTime() + 30 * DAY), goLive, 12)!;
    expect(moved.periodStart).toEqual(goLive);
    expect(moved.periodEnd).toEqual(addMonths(goLive, 12));
    expect(moved.validUntil.getTime()).toBe(addMonths(goLive, 12).getTime() + 30 * DAY);
  });
});

describe("flow_f6: expiry reminders and online renewal", () => {
  it("ON: on even when rule shopMembership has them off; OFF: the stored rule decides (as before)", async () => {
    await setRule("shopMembership", { remindersEnabled: false, renewalCheckoutEnabled: false }, admin);
    expect(await shopMembershipRuleForFlows()).toMatchObject({ remindersEnabled: false, renewalCheckoutEnabled: false });
    expect((await runRegistrationSubscriptionJob()).reminders).toMatch(/^off/);

    await flag("flow_f6", true);
    expect(await shopMembershipRuleForFlows()).toMatchObject({ remindersEnabled: true, renewalCheckoutEnabled: true });
    expect(String((await runRegistrationSubscriptionJob()).reminders)).not.toMatch(/^off/);

    // The admin switch in rule shopFlowsV3 hands them back to rule shopMembership.
    await setRule("shopFlowsV3", { remindersAndRenewalOn: false }, admin);
    expect(await shopMembershipRuleForFlows()).toMatchObject({ remindersEnabled: false, renewalCheckoutEnabled: false });
  });
});
