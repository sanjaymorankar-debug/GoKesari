/**
 * SM-002 — shop onboarding stages KYC_PENDING → PAYMENT_PENDING → VERIFIED
 * (migration 0051). The database derives the stage from seller documents and
 * the registration fee; only VERIFIED can be approved.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { FOOD_SHOP_TYPE_KEYS, isFoodBusinessShopType, SHOP_TYPES } from "@/lib/shop-types";
import { adminNextAction, ownerNextAction } from "@/lib/shop-onboarding";
import { db } from "@/server/db";
import { platformSettings, sellerVerifications, shops, statusChanges } from "@/server/db/schema";
import { recordPayment } from "@/server/services/shop-payments";
import { countShopsByLifecycle, getShopOnboarding } from "@/server/services/shop-onboarding";
import { clearRuleCache } from "@/server/services/settings";
import { approveShop } from "@/server/services/shops";
import { isLifecycleTransitionError } from "@/server/services/status-models";
import {
  createCategory,
  createShop,
  createUser,
  linkShopCategory,
  resetDatabase,
  verifySellerDocuments,
} from "../helpers/fixtures";

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });
const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "statusModels"));
  clearRuleCache();
});

async function stage(shopId: string) {
  const [row] = await db.select({ s: shops.lifecycleStatus }).from(shops).where(eq(shops.id, shopId));
  return row.s;
}

async function log(shopId: string) {
  const rows = await db
    .select()
    .from(statusChanges)
    .where(eq(statusChanges.entityId, shopId))
    .orderBy(statusChanges.createdAt);
  return rows.map((r) => [r.fromStatus, r.toStatus]);
}

describe("stage derivation", () => {
  it("moves KYC_PENDING → PAYMENT_PENDING → VERIFIED → ACTIVE and logs each step", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", registrationFeePaise: 500_000 });
    expect(shop.lifecycleStatus).toBe("KYC_PENDING");

    // A non-food shop needs PAN, GSTIN and Shop Act — not FSSAI.
    await verifySellerDocuments(shop.id, ["PAN", "GSTIN"]);
    expect(await stage(shop.id)).toBe("KYC_PENDING");
    await verifySellerDocuments(shop.id, ["SHOP_ACT"]);
    expect(await stage(shop.id)).toBe("PAYMENT_PENDING");

    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 200_000 }, OPERATOR(operator.id));
    expect(await stage(shop.id)).toBe("PAYMENT_PENDING");
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 300_000 }, OPERATOR(operator.id));
    expect(await stage(shop.id)).toBe("VERIFIED");

    const approved = await approveShop(shop.id, { classification: "GREEN" }, ADMIN(admin.id));
    expect(approved.lifecycleStatus).toBe("ACTIVE");
    expect(await log(shop.id)).toEqual([
      [null, "KYC_PENDING"],
      ["KYC_PENDING", "PAYMENT_PENDING"],
      ["PAYMENT_PENDING", "VERIFIED"],
      ["VERIFIED", "ACTIVE"],
    ]);
  });

  it("asks a food business for FSSAI, including a shop that adds a food category later", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const dairy = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "DAIRY", name: "Food Shop" });
    await verifySellerDocuments(dairy.id, ["PAN", "GSTIN", "SHOP_ACT"]);
    expect(await stage(dairy.id)).toBe("KYC_PENDING");
    await verifySellerDocuments(dairy.id, ["FSSAI"]);
    expect(await stage(dairy.id)).toBe("PAYMENT_PENDING");

    const hardware = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", name: "Tool Shop" });
    await verifySellerDocuments(hardware.id, ["PAN", "GSTIN", "SHOP_ACT"]);
    expect(await stage(hardware.id)).toBe("PAYMENT_PENDING");
    const bakery = await createCategory({ department: "BAKERY", name: "Bread" });
    await linkShopCategory(hardware.id, bakery.id);
    expect(await stage(hardware.id)).toBe("KYC_PENDING");
  });

  it("goes back to KYC_PENDING when a verified document expires", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id);
    expect(await stage(shop.id)).toBe("VERIFIED");
    await db
      .update(sellerVerifications)
      .set({ status: "EXPIRED" })
      .where(sql`${sellerVerifications.shopId} = ${shop.id} AND ${sellerVerifications.docType} = 'FSSAI'`);
    expect(await stage(shop.id)).toBe("KYC_PENDING");
  });

  it("leaves approved shops alone when their documents change", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id); // APPROVED
    await verifySellerDocuments(shop.id, ["PAN"]);
    await db.delete(sellerVerifications).where(eq(sellerVerifications.shopId, shop.id));
    expect(await stage(shop.id)).toBe("ACTIVE");
    expect(await log(shop.id)).toEqual([[null, "ACTIVE"]]);
  });
});

describe("approval gate", () => {
  it("refuses KYC_PENDING with the missing documents, PAYMENT_PENDING with the fee", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 500_000 });
    await verifySellerDocuments(shop.id, ["PAN"]);

    await expect(approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/GST number \(GSTIN\).*FSSAI/),
      details: { lifecycleStatus: "KYC_PENDING" },
    });

    await verifySellerDocuments(shop.id);
    await expect(approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { feePaymentStatus: "PENDING" },
    });
    const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(after.status).toBe("PENDING_APPROVAL");
    expect(after.lifecycleStatus).toBe("PAYMENT_PENDING");
  });

  it("checks documents when a rejected shop is approved directly", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "REJECTED", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await expect(approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await verifySellerDocuments(shop.id);
    const approved = await approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id));
    expect(approved.lifecycleStatus).toBe("ACTIVE");
  });

  it("is enforced by the database too: a raw update cannot skip onboarding", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    const attempt = db.update(shops).set({ status: "APPROVED" }).where(eq(shops.id, shop.id));
    await expect(attempt).rejects.toSatisfy(isLifecycleTransitionError);
  });

  it("is switched off with statusModels.enforceTransitions, and the move is logged as unenforced", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await db.insert(platformSettings).values({ key: "statusModels", value: { enforceTransitions: false } });
    clearRuleCache();

    const approved = await approveShop(shop.id, { classification: "KESARI" }, ADMIN(admin.id));
    expect(approved.lifecycleStatus).toBe("ACTIVE");
    const [last] = await db
      .select()
      .from(statusChanges)
      .where(sql`${statusChanges.entityId} = ${shop.id} AND ${statusChanges.toStatus} = 'ACTIVE'`);
    expect(last.detail).toMatchObject({ unenforced: true });
  });
});

describe("screens", () => {
  it("lists missing documents, fee owed and counts per stage", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const a = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", name: "A", registrationFeePaise: 300_000 });
    const b = await createShop(owner.id, { status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", name: "B", registrationFeePaise: 300_000 });
    const c = await createShop(owner.id, { name: "C" }); // approved
    await verifySellerDocuments(b.id, ["PAN", "GSTIN", "SHOP_ACT"]);

    const facts = await getShopOnboarding([a.id, b.id, c.id]);
    expect(facts.get(a.id)).toMatchObject({
      stage: "KYC_PENDING",
      missingDocTypes: ["PAN", "GSTIN", "SHOP_ACT"],
      feeOutstandingPaise: 300_000,
    });
    expect(facts.get(b.id)).toMatchObject({ stage: "PAYMENT_PENDING", missingDocTypes: [], feeOutstandingPaise: 300_000 });
    expect(facts.has(c.id)).toBe(false);

    const counts = await countShopsByLifecycle();
    expect(counts).toMatchObject({ KYC_PENDING: 1, PAYMENT_PENDING: 1, VERIFIED: 0, ACTIVE: 1 });
  });

  it("tells the owner and operations the next step for each stage", () => {
    const base = { missingDocuments: ["PAN", "Shop Act licence"], feeOutstandingPaise: 500_000 };
    expect(ownerNextAction({ ...base, stage: "KYC_PENDING" })).toMatchObject({
      href: "/shop/verification",
      text: expect.stringContaining("PAN and Shop Act licence"),
    });
    expect(ownerNextAction({ ...base, stage: "PAYMENT_PENDING" }).text).toContain("₹5,000");
    expect(ownerNextAction({ ...base, stage: "VERIFIED" }).text).toContain("no action needed");
    expect(adminNextAction({ ...base, stage: "KYC_PENDING" }).href).toBe("/admin/seller-verification");
    expect(adminNextAction({ ...base, stage: "PAYMENT_PENDING" }).href).toBe("/admin#shop-finance");
    expect(adminNextAction({ ...base, stage: "VERIFIED" }).text).toContain("ready to approve");
  });
});

describe("SQL mirrors the TypeScript rules", () => {
  it("food shop types match FOOD_SHOP_TYPE_KEYS", async () => {
    for (const { key } of SHOP_TYPES) {
      const [{ v }] = (await db.execute(
        sql`SELECT shop_sells_food(gen_random_uuid(), ${key}) AS v`,
      )) as unknown as { v: boolean }[];
      expect([key, v]).toEqual([key, isFoodBusinessShopType(key)]);
    }
    expect(FOOD_SHOP_TYPE_KEYS.length).toBeGreaterThan(0);
  });
});
