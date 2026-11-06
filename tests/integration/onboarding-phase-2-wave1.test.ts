/**
 * Shop onboarding Phase 2, Wave 1 (docs/onboarding-benchmark/phase-2, owner 05/06-Nov-2026):
 *
 *   - WP1 starter shelf: ranked by orders in the last 90 days (Q1); one-transaction publish with
 *     opening-stock ledger rows; bad rows refused on their own
 *   - WP2 barcode: a scanned GTIN finds the catalogue product in any stored form; an unknown code
 *     becomes the owner's own product, waiting for approval (Q9)
 *   - WP3 "How you deliver": pickup only turns delivery off and still completes the checklist line
 *   - WP4 reminders: each step moves the reminder 24 h ahead; sent at 24 h and 72 h (dealer told at
 *     72 h), then stops; paying cancels it (Q3)
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => undefined,
  EmailUnavailableError: class extends Error {},
}));

import { db } from "@/server/db";
import {
  inventoryMovements,
  notifications,
  orderItems,
  orders,
  products,
  scheduledNotices,
  shopProductCategories,
  shopProducts,
  shopRegistrationDrafts,
  shops,
} from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { findProductByBarcode } from "@/server/services/barcode-lookup";
import { createProductForShop } from "@/server/services/catalogue";
import { listIdleRegistrations } from "@/server/services/onboarding-funnel";
import { setRegistrationFee } from "@/server/services/registration-fees";
import { deliverDueScheduledNotices } from "@/server/services/scheduled-notices";
import { clearRuleCache } from "@/server/services/settings";
import { answerDraftReferral, getWizardDraft } from "@/server/services/shop-registration-wizard";
import { getShopSetupChecklist } from "@/server/services/shop-setup-checklist";
import { updateShop } from "@/server/services/shops";
import { getStarterShelf, publishStarterShelf } from "@/server/services/starter-shelf";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  linkShopCategory,
  resetDatabase,
} from "../helpers/fixtures";

const HOUR = 3_600_000;
let owner: { id: string; role: "CUSTOMER"; email: string };

beforeEach(async () => {
  clearRuleCache();
  await resetDatabase();
  setKycAdapterForTests(createMockAdapter());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  const admin = await createUser({ role: "ADMIN" });
  await setRegistrationFee({ amountPaise: 99_900 }, { id: admin.id, role: "ADMIN" });
  const u = await createUser({ role: "CUSTOMER" });
  owner = { id: u.id, role: "CUSTOMER", email: u.email };
});
afterEach(() => {
  setKycAdapterForTests(null);
  vi.unstubAllGlobals();
});

async function grocery() {
  const shop = await createShop(owner.id);
  const category = await createCategory({ name: `Grocery ${randomUUID().slice(0, 6)}` });
  await linkShopCategory(shop.id, category.id);
  return { shop, category };
}

/** One order of the product at another shop, `daysAgo` days ago. */
async function orderedElsewhere(productId: string, categoryId: string, daysAgo: number) {
  const seller = await createUser({ role: "SHOP_OWNER" });
  const other = await createShop(seller.id);
  await linkShopCategory(other.id, categoryId);
  const listing = await createShopProduct(other.id, productId, { onlinePricePaise: 1_000, onlineSaleEnabled: true });
  const buyer = await createUser({ role: "CUSTOMER" });
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000);
  const [order] = await db
    .insert(orders)
    .values({
      userId: buyer.id,
      shopId: other.id,
      status: "DELIVERED",
      orderNumber: `T-${randomUUID().slice(0, 8)}`,
      subtotalPaise: 1_000,
      totalPaise: 1_000,
      createdAt,
    } as never)
    .returning();
  await db.insert(orderItems).values({
    orderId: order.id,
    shopProductId: listing.id,
    productNameSnapshot: "x",
    unitSnapshot: "pack",
    unitPricePaise: 1_000,
    quantityMilli: 1_000,
    lineTotalPaise: 1_000,
  } as never);
}

describe("WP1 starter shelf", () => {
  it("ranks products ordered in the last 90 days first (owner's Q1); older orders do not count", async () => {
    const { shop, category } = await grocery();
    const a = await createProduct(category.id, { name: "A Atta", unit: "pack" });
    const b = await createProduct(category.id, { name: "B Besan", unit: "pack" });
    const c = await createProduct(category.id, { name: "C Chana", unit: "pack" });
    await orderedElsewhere(c.id, category.id, 10);
    await orderedElsewhere(c.id, category.id, 20);
    await orderedElsewhere(b.id, category.id, 5);
    await orderedElsewhere(a.id, category.id, 200); // outside the window
    const shelf = await getStarterShelf(shop.id);
    expect(shelf.items.map((i) => i.name)).toEqual(["C Chana", "B Besan", "A Atta"]);
  });

  it("publishes every good row in one go with opening stock in the ledger; bad rows come back with reasons", async () => {
    const { shop, category } = await grocery();
    const atta = await createProduct(category.id, { name: "Atta 5 kg", unit: "pack" });
    const dal = await createProduct(category.id, { name: "Toor Dal 1 kg", unit: "pack" });
    const oil = await createProduct(category.id, { name: "Oil 1 L", unit: "pack" });
    await db.update(products).set({ mrpPaise: 30_000 }).where(eq(products.id, atta.id));
    await db.update(products).set({ mrpPaise: 18_000 }).where(eq(products.id, dal.id));
    // A product from a category the shop does not carry yet (e.g. scanned): its category is linked.
    const other = await createCategory({ name: `Hardware ${randomUUID().slice(0, 6)}` });
    const hammer = await createProduct(other.id, { name: "Hammer", unit: "piece" });

    const result = await publishStarterShelf(
      shop.id,
      [
        { productId: atta.id, pricePaise: 29_000, stock: 100 },
        { productId: dal.id, pricePaise: 19_000, stock: 40 }, // above MRP
        { productId: oil.id, pricePaise: 15_000, stock: 2.5 }, // a pack cannot be half
        { productId: hammer.id, pricePaise: 25_000, stock: 0 },
        { productId: randomUUID(), pricePaise: 100, stock: 1 }, // unknown
      ],
      { id: owner.id, role: "SHOP_OWNER" },
    );
    expect(result.added).toBe(2);
    expect(result.firstProducts).toBe(true);
    expect(result.failed).toHaveLength(3);
    expect(result.failed.map((f) => f.productId)).toEqual(expect.arrayContaining([dal.id, oil.id]));
    expect(result.failed.find((f) => f.productId === dal.id)!.reason).toMatch(/MRP/);

    const listed = await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id));
    expect(listed).toHaveLength(2);
    const attaRow = listed.find((l) => l.productId === atta.id)!;
    expect(attaRow).toMatchObject({ onlinePricePaise: 29_000, offlinePricePaise: 29_000, onlineStock: 100, onlineSaleEnabled: true });
    const ledger = await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopProductId, attaRow.id));
    expect(ledger).toEqual([expect.objectContaining({ deltaUnits: 100, newUnits: 100, source: "starter_shelf", channel: "ONLINE" })]);
    // Stock 0: no ledger row.
    const hammerRow = listed.find((l) => l.productId === hammer.id)!;
    expect(await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopProductId, hammerRow.id))).toHaveLength(0);
    const carried = await db.select().from(shopProductCategories).where(and(eq(shopProductCategories.shopId, shop.id), eq(shopProductCategories.categoryId, other.id)));
    expect(carried).toHaveLength(1);

    // Publishing again: already listed, nothing added, not "first products".
    const again = await publishStarterShelf(shop.id, [{ productId: atta.id, pricePaise: 29_000, stock: 1 }], { id: owner.id, role: "SHOP_OWNER" });
    expect(again).toMatchObject({ added: 0, firstProducts: false, failed: [{ productId: atta.id, reason: "Already in your shop." }] });
  });
});

describe("WP2 barcode", () => {
  it("finds a product by its GTIN in any stored form and says whether the shop lists it", async () => {
    const { shop, category } = await grocery();
    const p = await createProduct(category.id, { name: "Biscuits 200 g", unit: "pack" });
    await db.update(products).set({ gtin: "8901234567897", mrpPaise: 3_000 }).where(eq(products.id, p.id));
    const found = await findProductByBarcode(shop.id, "08901234567897"); // GTIN-14 typed
    expect(found?.match).toMatchObject({ productId: p.id, mrpPaise: 3_000, approved: true, listed: false });
    await createShopProduct(shop.id, p.id);
    expect((await findProductByBarcode(shop.id, "8901234567897"))?.match?.listed).toBe(true);
    expect((await findProductByBarcode(shop.id, "1234567"))?.match).toBeNull();
    expect(await findProductByBarcode(shop.id, "12")).toBeNull();
  });

  it("an unknown code becomes the owner's own product, waiting for approval, found by the same code", async () => {
    const shop = await createShop(owner.id, { status: "APPROVED" });
    await db.update(shops).set({ ownerId: owner.id }).where(eq(shops.id, shop.id));
    const created = await createProductForShop(
      { shopId: shop.id, name: "Local Namkeen 400 g", unit: "pack", barcode: "ABC123456", onlinePricePaise: 6_000, offlinePricePaise: 6_000, confirmDuplicate: true },
      { id: owner.id, role: "SHOP_OWNER" },
      true,
    );
    expect(created.product).toMatchObject({ barcode: "ABC123456", approvalStatus: "PENDING_APPROVAL" });
    expect((await findProductByBarcode(shop.id, "ABC123456"))?.match).toMatchObject({ approved: false });
  });
});

describe("WP3 How you deliver", () => {
  it("pickup only turns delivery off and completes the checklist's delivery line; own staff turns it on", async () => {
    const shop = await createShop(owner.id, { status: "APPROVED" });
    const before = await getShopSetupChecklist(shop);
    expect(before?.items.find((i) => i.key === "delivery")).toMatchObject({ done: shop.deliveryAvailable, href: "/shop/setup/delivery" });

    const pickup = await updateShop(shop.id, { deliveryChoice: "PICKUP_ONLY" }, { id: owner.id, role: "SHOP_OWNER" });
    expect(pickup).toMatchObject({ deliveryChoice: "PICKUP_ONLY", deliveryAvailable: false });
    expect((await getShopSetupChecklist(pickup))?.items.find((i) => i.key === "delivery")?.done).toBe(true);

    const staff = await updateShop(shop.id, { deliveryChoice: "OWN_STAFF", serviceRadiusKm: 4 }, { id: owner.id, role: "SHOP_OWNER" });
    expect(staff).toMatchObject({ deliveryChoice: "OWN_STAFF", deliveryAvailable: true, serviceRadiusKm: 4 });
  });
});

describe("WP4 registration reminders", () => {
  const ownerNotices = async () =>
    db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.SHOP_REGISTRATION_IDLE)));

  it("each step moves the reminder 24 h ahead; reminded at 24 h and 72 h, then it stops", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    const [first] = await db.select().from(scheduledNotices);
    expect(first).toMatchObject({ kind: "REGISTRATION_IDLE", stage: 1, sentAt: null });
    expect(first.dueAt.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);

    // Nothing due yet.
    expect(await deliverDueScheduledNotices()).toEqual({ sent: 0, skipped: 0 });

    const at24 = new Date(Date.now() + 24 * HOUR + 60_000);
    expect((await deliverDueScheduledNotices({ now: at24 })).sent).toBe(1);
    expect(await ownerNotices()).toHaveLength(1);
    const [second] = await db.select().from(scheduledNotices);
    expect(second.stage).toBe(2);
    expect(second.dueAt.getTime() - at24.getTime()).toBe(48 * HOUR);
    // The same minute again: already claimed, nothing more.
    expect((await deliverDueScheduledNotices({ now: at24 })).sent).toBe(0);

    const at72 = new Date(at24.getTime() + 48 * HOUR + 60_000);
    expect((await deliverDueScheduledNotices({ now: at72 })).sent).toBe(1);
    expect(await ownerNotices()).toHaveLength(2);
    const [last] = await db.select().from(scheduledNotices);
    expect(last.sentAt).not.toBeNull();
    expect((await deliverDueScheduledNotices({ now: new Date(at72.getTime() + 30 * 24 * HOUR) })).sent).toBe(0);

    // Coming back starts it over at stage 1.
    await getWizardDraft(owner);
    const [restarted] = await db.select().from(scheduledNotices);
    expect(restarted).toMatchObject({ stage: 1, sentAt: null, cancelledAt: null });
  });

  it("a registration no longer waiting on the owner is not reminded", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    await db.update(shopRegistrationDrafts).set({ status: "COMPLETED" }).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    expect((await deliverDueScheduledNotices({ now: new Date(Date.now() + 25 * HOUR) })).sent).toBe(1); // claimed…
    expect(await ownerNotices()).toHaveLength(0); // …but nothing sent
  });

  it("the admin list shows registrations idle for a day, with the step and reminders sent", async () => {
    await answerDraftReferral({ actor: owner, referralCode: null });
    expect(await listIdleRegistrations()).toHaveLength(0);
    await db.update(shopRegistrationDrafts).set({ updatedAt: new Date(Date.now() - 30 * HOUR) }).where(eq(shopRegistrationDrafts.ownerId, owner.id));
    const [row] = await listIdleRegistrations();
    expect(row).toMatchObject({ ownerEmail: owner.email, remindersSent: 0 });
    expect(row.idleHours).toBeGreaterThanOrEqual(29);
    expect(row.step).not.toBeNull();
  });
});
