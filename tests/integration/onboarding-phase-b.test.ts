/**
 * Shop onboarding Phase B, Phase 1 "quick wins" (docs/onboarding-benchmark, owner 05-Nov-2026):
 *
 *   - the gateway brings a paid wizard shop back into the wizard (G13)
 *   - the funnel records when each registration first reached each step (B3)
 *   - "Finish set-up" on Seller Central lists what a live shop still has to do (G20, D4)
 *   - the starter shelf: products in the shop's categories, MRP as price, stock 100 (D2)
 *   - notices: paid-but-pending to admins (G14); first products to the owner (B2)
 *   - the "ready" email does not claim a GST / PAN check on an "add documents later" shop (G10)
 *   - payouts need a verified bank account by default (D4)
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { db } from "@/server/db";
import { notifications, products, shopCategories, shopOnboardingSteps, shopProducts, shops } from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { getOnboardingFunnel } from "@/server/services/onboarding-funnel";
import { finishFeeCapture } from "@/server/services/operator-limited";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { clearRuleCache, getRule } from "@/server/services/settings";
import { notifyFirstProducts } from "@/server/services/shop-onboarding-events";
import { submitDraftGstin } from "@/server/services/shop-registration-draft";
import {
  answerDraftReferral,
  getWizardDraft,
  saveDraftDetails,
  saveDraftLocation,
  submitDraftForPayment,
  wizardContinuePath,
  type DraftShopDetails,
} from "@/server/services/shop-registration-wizard";
import { getShopSetupChecklist } from "@/server/services/shop-setup-checklist";
import { getStarterShelf, publishStarterShelf } from "@/server/services/starter-shelf";
import { createCategory, createProduct, createShop, createUser, linkShopCategory, resetDatabase } from "../helpers/fixtures";

const gstinFor = (pan: string) => {
  const first14 = `27${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

let owner: { id: string; role: "CUSTOMER"; email: string; name: string | null };
let admin: { id: string; role: "ADMIN"; email: string };

beforeEach(async () => {
  state.outbox = [];
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
  await db.insert(shopCategories).values({ name: `Phase B ${tag}`, slug: `phase-b-${tag}` });
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

function details(overrides: Partial<DraftShopDetails> = {}): DraftShopDetails {
  return {
    name: "Phase B Kirana",
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

async function payInSandbox(shopId: string) {
  const checkout = await startRegistrationFeeCheckout(shopId, owner);
  await simulateSandboxCheckout({ ref: checkout.intentId, viewerId: owner.id, outcome: "SUCCESS" });
  await finishFeeCapture(shopId, checkout.intentId);
}

/**
 * Owner brief 08-Nov-2026 (no "upload later"): referral + a proprietor's GSTIN → address → map pin
 * → shop → shop created (fee due).
 */
async function registerLater() {
  await answerDraftReferral({ actor: owner, referralCode: null });
  await submitDraftGstin({ gstin: gstinFor("ABCPK5678L"), consentGiven: true, actor: owner });
  await saveDraftDetails({ actor: owner, details: details() });
  await saveDraftLocation({ actor: owner, latitude: 18.5308, longitude: 73.8475 });
  const submitted = await submitDraftForPayment({ actor: owner });
  return submitted.shop!.id;
}

describe("payment returns into the wizard (G13)", () => {
  it("a paid wizard shop continues at /shop/register; one still owing, or not from the wizard, does not", async () => {
    const shopId = await registerLater();
    expect(await wizardContinuePath(owner.id, shopId)).toBeNull(); // still PAYMENT: the fee page is right
    await payInSandbox(shopId);
    expect(await wizardContinuePath(owner.id, shopId)).toBe("/shop/register");
    const other = await createShop(owner.id);
    expect(await wizardContinuePath(owner.id, other.id)).toBeNull();
  });
});

describe("the onboarding funnel (B3)", () => {
  it("records each step once when first reached, and counts started → paid → live", async () => {
    const shopId = await registerLater();
    await payInSandbox(shopId);
    await getWizardDraft(owner); // read again: no second row for the same step
    const steps = await db.select({ step: shopOnboardingSteps.step }).from(shopOnboardingSteps);
    const names = steps.map((s) => s.step);
    expect(names).toEqual(expect.arrayContaining(["IDENTITY", "PIN", "REVIEW", "PAYMENT", "LIVE"]));
    expect(new Set(names).size).toBe(names.length);

    const funnel = await getOnboardingFunnel(30);
    const all = funnel.rows.find((r) => r.source === "ALL")!;
    expect(all.counts).toMatchObject({ started: 1, verified: 1, paid: 1, live: 1, firstProduct: 0, firstOrder: 0 });
    expect(funnel.rows.find((r) => r.source === "SELF")!.counts.started).toBe(1);
    expect(funnel.medianMinutesToLive).not.toBeNull();
  });
});

describe("Finish set-up and the bank rule (G20, D4)", () => {
  it("payouts need a verified bank by default; the checklist shows what a live shop still lacks", async () => {
    const bank = await getRule("bankAccounts");
    expect(bank).toMatchObject({ enabled: true, requireVerifiedForShopPayouts: true });

    const shop = await createShop(owner.id, { latitude: 18.53, longitude: 73.84, deliveryAvailable: false });
    const checklist = (await getShopSetupChecklist(shop))!;
    const byKey = Object.fromEntries(checklist.items.map((i) => [i.key, i]));
    expect(byKey.pin.done).toBe(true);
    expect(byKey.bank.done).toBe(false);
    expect(byKey.delivery.done).toBe(false);
    expect(byKey.products).toMatchObject({ done: false, progress: { have: 0, target: 10 } });
    expect(byKey.documents.done).toBe(true); // not an "add documents later" shop
    expect(checklist.complete).toBe(false);

    const pending = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "Waiting Shop" });
    expect(await getShopSetupChecklist(pending)).toBeNull();
  });
});

describe("starter shelf (D2: 100 products, stock 100)", () => {
  it("offers the shop's category products not yet listed, and publishes the ticked ones at the given price and stock", async () => {
    const shop = await createShop(owner.id);
    const category = await createCategory({ name: `Grocery ${randomUUID().slice(0, 6)}` });
    await linkShopCategory(shop.id, category.id);
    const atta = await createProduct(category.id, { name: "Atta 5 kg", unit: "pack" });
    const dal = await createProduct(category.id, { name: "Toor Dal 1 kg", unit: "pack" });
    await db.update(products).set({ mrpPaise: 30_000 }).where(eq(products.id, atta.id));
    await db.update(products).set({ mrpPaise: 18_000 }).where(eq(products.id, dal.id));
    const elsewhere = await createCategory({ name: `Hardware ${randomUUID().slice(0, 6)}`, department: "GENERAL_TRADING" });
    await createProduct(elsewhere.id, { name: "Hammer" });

    const shelf = await getStarterShelf(shop.id);
    expect(shelf).toMatchObject({ enabled: true, defaultStock: 100, listed: 0 });
    expect(shelf.items.map((i) => i.name).sort()).toEqual(["Atta 5 kg", "Toor Dal 1 kg"]);
    expect(shelf.items.find((i) => i.productId === atta.id)!.mrpPaise).toBe(30_000);

    const result = await publishStarterShelf(
      shop.id,
      [
        { productId: atta.id, pricePaise: 29_000, stock: 100 },
        // Above the MRP: refused on its own, the other one is still listed.
        { productId: dal.id, pricePaise: 19_000, stock: 40 },
      ],
      { id: owner.id, role: "SHOP_OWNER" },
    );
    expect(result.added).toBe(1);
    expect(result.firstProducts).toBe(true);
    expect(result.failed).toEqual([{ productId: dal.id, reason: expect.stringMatching(/MRP/i) }]);
    const [listing] = await db.select().from(shopProducts).where(and(eq(shopProducts.shopId, shop.id), eq(shopProducts.productId, atta.id)));
    expect(listing).toMatchObject({ onlinePricePaise: 29_000, offlinePricePaise: 29_000, onlineSaleEnabled: true });
    expect(Number(listing.onlineStock)).toBe(100);
    // Listed products are not offered again.
    expect((await getStarterShelf(shop.id)).items.map((i) => i.productId)).toEqual([dal.id]);
  });
});

describe("notices (G14, B2, G10)", () => {
  it("a paid shop that is not approved automatically is sent to the admins", async () => {
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    await emitEvent({
      type: "shop.registration_fee_paid",
      subjectId: shop.id,
      payload: { shopName: shop.name, ownerId: owner.id, operatorId: null, amountPaise: 99_900, approved: false },
      idempotencyKey: `test-fee-paid:${shop.id}`,
    });
    const toAdmin = await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, NOTIFICATION_TYPES.SUPPORT_SHOP_PAID_PENDING)));
    expect(toAdmin.length).toBeGreaterThan(0);
    expect(toAdmin[0].body).toContain(shop.name);
  });

  it("the shop's first products are announced to the owner", async () => {
    const shop = await createShop(owner.id);
    await notifyFirstProducts(shop.id, 12);
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.SHOP_FIRST_PRODUCTS_LIVE)));
    expect(notice.title).toBe(`12 products are live in ${shop.name}`);
  });

  it("the ready email says the GST / PAN was verified and asks for products (owner brief 08-Nov-2026)", async () => {
    const shopId = await registerLater();
    await payInSandbox(shopId);
    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop.status).toBe("APPROVED");
    const [ready] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.SHOP_READY_FOR_PRODUCT_UPLOAD)));
    expect(ready.body).toMatch(/GST\/PAN was verified/);
    expect(ready.body).toMatch(/Your onboarding is complete/);
    expect(ready.body).not.toMatch(/before your first payout/);
  });

  it("a GSTIN check goes on from the document window, never to the old documents question", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    await submitDraftGstin({ gstin: gstinFor("AABCG1234K"), consentGiven: true, actor: owner });
    const view = (await getWizardDraft(owner))!;
    expect(view.nextStep).not.toBe("DOCS_READY");
  });
});
