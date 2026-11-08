/**
 * Shop registration flow — owner brief 08-Nov-2026 (docs/shop-onboarding-identity-first-2026-11):
 *
 *   Flow 1  sign-in → "Verify your business" (referral code + GSTIN, or PAN without one) →
 *           owner name only if the record has none → confirm address → map pin → shop name →
 *           pay → live with "Add Products"
 *   Flow 2  an existing customer who clicks Sell starts at the same screen; a registration
 *           abandoned for a week is discarded, never resumed
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
import { notifications, shopCategories, shopRegistrationDrafts, shops } from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { finishFeeCapture } from "@/server/services/operator-limited";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { setReferralSetting } from "@/server/services/referral-settings";
import { clearRuleCache } from "@/server/services/settings";
import { ABANDONED_AFTER_MS, submitDraftGstin, submitDraftPan } from "@/server/services/shop-registration-draft";
import {
  answerDocumentsReady,
  answerDraftDocument,
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
    expect(view).toMatchObject({ nextStep: "ADDRESS", ownerName: "Ganesh Patil" });
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
    expect(view.nextStep).toBe("ADDRESS");
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
    const submitted = await submitDraftForPayment({ actor: owner });
    const shopId = submitted.shop!.id;
    expect(submitted.nextStep).toBe("PAYMENT");
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
    const view = await submitDraftForPayment({ actor: owner });
    expect(await shopRow(view.shop!.id)).toMatchObject({ email: "orders@kirana.example" });
  });

  it("a food shop is asked for its FSSAI after the shop step, and goes live once it is verified", async () => {
    await verifyGstin(gstinFor("ABCPK5678L"));
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    let view = await saveDraftDetails({ actor: owner, details: shopFields({ shopType: "DAIRY" }) });
    expect(view).toMatchObject({ foodShop: true, nextStep: "FSSAI" });
    view = await answerDraftDocument({ actor: owner, docType: "FSSAI", has: false });
    expect(view.nextStep).toBe("FSSAI");
    view = await submitDraftDocument({ actor: owner, docType: "FSSAI", number: FSSAI, consentGiven: true });
    expect(view).toMatchObject({ nextStep: "REVIEW", fssai: { check: { status: "VERIFIED" } } });
    const submitted = await submitDraftForPayment({ actor: owner });
    await payInSandbox(submitted.shop!.id);
    expect(await shopRow(submitted.shop!.id)).toMatchObject({ status: "APPROVED", fssaiLicenseNumber: FSSAI });
  });
});

describe("Flow 1 with a PAN only (no GST)", () => {
  it("address not returned by the PAN source: the owner name is filled, the address typed → pin → shop name typed → live", async () => {
    let view = await verifyPan("ABCPE1234F");
    expect(view).toMatchObject({ route: "PAN_ONLY", noGstDeclared: true, pan: { status: "VERIFIED" } });
    expect(view.ownerName).toBeTruthy();
    expect(view).toMatchObject({ nextStep: "ADDRESS", address: null, prefill: { shopName: null } });
    await saveDraftAddress({ actor: owner, address: ADDRESS });
    await saveDraftLocation({ actor: owner, ...PIN });
    view = await saveDraftDetails({ actor: owner, details: shopFields({ name: "Ekta Kirana" }) });
    expect(view.nextStep).toBe("REVIEW");
    const submitted = await submitDraftForPayment({ actor: owner });
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
    expect(view).toMatchObject({ nextStep: "ADDRESS", ownerName: "EKTA SHARMA", address: { addressLine1: "22, Laxmi Road, Pune, 411030", pincode: "411030", city: "Pune" } });
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
    await submitDraftForPayment({ actor: owner });
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
  it("starts at the GST / PAN screen (already signed in); a registration left for a week is discarded and starts afresh", async () => {
    // The customer started once and walked away.
    await verifyGstin();
    await saveDraftOwner({ actor: owner, ownerName: "Old Name" });
    const [old] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    await db.update(shopRegistrationDrafts).set({ updatedAt: new Date(Date.now() - ABANDONED_AFTER_MS - 60_000) }).where(eq(shopRegistrationDrafts.id, old.id));

    // Back on Sell: nothing of the old attempt is reused.
    expect(await getWizardDraft(owner)).toBeNull();
    const [abandoned] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, old.id));
    expect(abandoned.status).toBe("ABANDONED");
    const view = await answerDraftReferral({ actor: owner, referralCode: null });
    expect(view).toMatchObject({ nextStep: "IDENTITY", route: null, gstin: null, ownerName: null });
    expect(view.id).not.toBe(old.id);
  });

  it("within the week the same registration resumes where it was", async () => {
    await verifyGstin();
    await saveDraftOwner({ actor: owner, ownerName: "Ganesh Patil" });
    expect((await getWizardDraft(owner))!).toMatchObject({ nextStep: "ADDRESS", ownerName: "Ganesh Patil" });
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
