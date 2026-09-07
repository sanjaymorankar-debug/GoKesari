/**
 * Product Master + shop inventory (Product Master / Inventory brief).
 *
 * These map directly onto the brief's own §39 acceptance tests — one master
 * product shared by many shops, independent per-shop stock, thresholds and
 * alerts, and MRP that a shop owner cannot overwrite.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { brands, products, shopProducts } from "@/server/db/schema";
import { restockOnline } from "@/server/services/catalogue";
import { createBrand } from "@/server/services/brands";
import {
  acknowledgeStockAlert,
  evaluateStockAlerts,
  getInventoryDashboard,
  listStockAlerts,
  needsReorder,
  setStockThresholds,
  stockStatus,
} from "@/server/services/inventory-alerts";
import {
  findDuplicateCandidates,
  findProductByGtin,
  getMrpHistory,
  listProductsMissingMrp,
  normalizeGtin,
  setMasterMrp,
  submitMrpCorrection,
  updateProductIdentity,
} from "@/server/services/product-master";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(resetDatabase);

const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });
const OWNER = (id: string) => ({ id, role: "SHOP_OWNER" as const });

async function masterProductWithGtin(gtin = "8901234567894") {
  const admin = await createUser({ role: "ADMIN" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Amul Taaza Toned Milk" });
  await updateProductIdentity(product.id, { gtin, netQuantity: 1000, netQuantityUnit: "ml" }, ADMIN(admin.id));
  await setMasterMrp({ productId: product.id, mrpPaise: 10000, source: "ADMIN" }, ADMIN(admin.id));
  return { admin, category, product };
}

describe("GTIN normalization", () => {
  it("strips separators and accepts EAN-8/UPC-A/EAN-13/GTIN-14 lengths", () => {
    expect(normalizeGtin("890-1234 567894")).toBe("8901234567894");
    expect(normalizeGtin("12345678")).toBe("12345678");
    expect(normalizeGtin("00012345678905")).toBe("00012345678905");
  });

  it("rejects non-digits and wrong lengths", () => {
    expect(() => normalizeGtin("ABC123")).toThrowError(/digits only/i);
    expect(() => normalizeGtin("12345")).toThrowError(/8, 12, 13 or 14/);
  });
});

describe("one master product, many shops (§39 tests 1–4)", () => {
  it("lets two shops stock the same master product with independent inventory", async () => {
    const { product } = await masterProductWithGtin();

    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { name: "Shop A" });
    const spA = await createShopProduct(shopA.id, product.id, {
      onlinePricePaise: 9500,
      onlineStock: 25,
    });

    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopB = await createShop(ownerB.id, { name: "Shop B" });
    const spB = await createShopProduct(shopB.id, product.id, {
      onlinePricePaise: 9000,
      onlineStock: 7,
    });

    // Test 3: no duplicate master row was created.
    const allProducts = await db.select().from(products);
    expect(allProducts).toHaveLength(1);

    // Test 4: changing one shop's stock leaves the other alone.
    await restockOnline(spA.id, 10, "Stock received", ownerA.id);
    const [afterA] = await db.select().from(shopProducts).where(eq(shopProducts.id, spA.id));
    const [afterB] = await db.select().from(shopProducts).where(eq(shopProducts.id, spB.id));
    expect(afterA.onlineStock).toBe(35);
    expect(afterB.onlineStock).toBe(7);

    // Test 9: each shop keeps its own selling price under one shared MRP.
    expect(afterA.onlinePricePaise).toBe(9500);
    expect(afterB.onlinePricePaise).toBe(9000);
    const [master] = await db.select().from(products).where(eq(products.id, product.id));
    expect(master.mrpPaise).toBe(10000);
  });

  it("refuses a second master product with the same GTIN (§39 test 12)", async () => {
    const { admin, category } = await masterProductWithGtin("8901234567894");
    const second = await createProduct(category.id, { name: "Look-alike Milk" });

    await expect(
      updateProductIdentity(second.id, { gtin: "8901234567894" }, ADMIN(admin.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("barcode lookup (§39 tests 10–11)", () => {
  it("finds the existing master product by GTIN", async () => {
    const { product } = await masterProductWithGtin("8901234567894");
    const found = await findProductByGtin("890-1234-567894");
    expect(found?.id).toBe(product.id);
  });

  it("returns null for an unknown barcode rather than inventing a product", async () => {
    await masterProductWithGtin("8901234567894");
    expect(await findProductByGtin("4006381333931")).toBeNull();
  });
});

describe("duplicate detection (§11)", () => {
  it("flags a same-brand, same-name, same-pack product as a potential duplicate", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const brand = await createBrand({ name: "Amul" }, ADMIN(admin.id));
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const existing = await createProduct(category.id, { name: "Taaza Toned Milk" });
    await updateProductIdentity(
      existing.id,
      { brandId: brand.id, netQuantity: 1000, netQuantityUnit: "ml" },
      ADMIN(admin.id),
    );

    const candidates = await findDuplicateCandidates({
      brandId: brand.id,
      name: "Taaza Toned Milk",
      netQuantity: 1000,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe("BRAND_NAME_PACK");
    expect(candidates[0].product.id).toBe(existing.id);
  });

  it("treats an exact GTIN match as definite, not merely potential", async () => {
    const { product } = await masterProductWithGtin("8901234567894");
    const candidates = await findDuplicateCandidates({
      gtin: "8901234567894",
      name: "Something else entirely",
    });
    expect(candidates[0].reason).toBe("GTIN");
    expect(candidates[0].product.id).toBe(product.id);
  });
});

describe("MRP protection (§13, §39 test 8)", () => {
  it("refuses a shop owner writing the master MRP directly", async () => {
    const { product } = await masterProductWithGtin();
    const owner = await createUser({ role: "SHOP_OWNER" });

    await expect(
      setMasterMrp({ productId: product.id, mrpPaise: 11000, source: "SELLER_SUBMITTED" }, OWNER(owner.id)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [unchanged] = await db.select().from(products).where(eq(products.id, product.id));
    expect(unchanged.mrpPaise).toBe(10000);
  });

  it("parks a seller's correction as PENDING_VERIFICATION without touching the MRP", async () => {
    const { product } = await masterProductWithGtin();
    const owner = await createUser({ role: "SHOP_OWNER" });

    const updated = await submitMrpCorrection(product.id, 11000, OWNER(owner.id), "Printed ₹110");
    expect(updated.mrpVerificationStatus).toBe("PENDING_VERIFICATION");
    expect(updated.mrpPaise).toBe(10000);
  });

  it("appends every accepted change to an immutable history", async () => {
    const { admin, product } = await masterProductWithGtin();
    await setMasterMrp({ productId: product.id, mrpPaise: 11000, source: "BRAND" }, ADMIN(admin.id));
    await setMasterMrp({ productId: product.id, mrpPaise: 12000, source: "BRAND" }, ADMIN(admin.id));

    const history = await getMrpHistory(product.id);
    expect(history).toHaveLength(3); // initial 100 + two changes
    expect(history[0].newMrpPaise).toBe(12000);
    expect(history[0].previousMrpPaise).toBe(11000);
  });

  it("lists packaged products missing an MRP but not loose goods", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const category = await createCategory({ department: "GROCERY_KIRANA", name: "Staples" });

    const packaged = await createProduct(category.id, { name: "Packaged Atta" });
    const loose = await createProduct(category.id, { name: "Loose Rice" });
    await updateProductIdentity(loose.id, { kind: "LOOSE" }, ADMIN(admin.id));

    const missing = await listProductsMissingMrp();
    const ids = missing.map((p) => p.id);
    expect(ids).toContain(packaged.id);
    expect(ids).not.toContain(loose.id);
  });
});

describe("stock status and thresholds (§15, §18)", () => {
  it("derives status from the shop's own threshold", () => {
    expect(stockStatus(25, 10)).toBe("IN_STOCK");
    expect(stockStatus(10, 10)).toBe("LOW_STOCK");
    expect(stockStatus(7, 10)).toBe("LOW_STOCK");
    expect(stockStatus(0, 10)).toBe("OUT_OF_STOCK");
    // A threshold of 0 opts the line out of low-stock alerting entirely.
    expect(stockStatus(1, 0)).toBe("IN_STOCK");
  });

  it("treats reorder level as a separate signal from low stock", () => {
    expect(needsReorder(7, 10)).toBe(true);
    expect(needsReorder(11, 10)).toBe(false);
    expect(needsReorder(7, null)).toBe(false);
  });
});

describe("stock alerts (§16, §17, §39 tests 5–7)", () => {
  async function shopWithStock(stock: number, threshold: number) {
    const { product } = await masterProductWithGtin();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const sp = await createShopProduct(shop.id, product.id, {
      onlinePricePaise: 9000,
      onlineStock: stock,
    });
    await setStockThresholds(sp.id, { lowStockThreshold: threshold }, OWNER(owner.id));
    return { owner, shop, sp };
  }

  it("raises a LOW_STOCK alert when stock is at or below the threshold", async () => {
    const { shop } = await shopWithStock(7, 10);
    const alerts = await listStockAlerts(shop.id);
    expect(alerts.map((a) => a.alertType)).toContain("LOW_STOCK");
    expect(alerts[0].stockAtAlert).toBe(7);
    expect(alerts[0].thresholdAtAlert).toBe(10);
  });

  it("raises OUT_OF_STOCK and marks the line unavailable at zero — without deleting it", async () => {
    const { shop, sp } = await shopWithStock(0, 10);

    const alerts = await listStockAlerts(shop.id);
    expect(alerts.map((a) => a.alertType)).toContain("OUT_OF_STOCK");

    const [row] = await db.select().from(shopProducts).where(eq(shopProducts.id, sp.id));
    expect(row.isAvailable).toBe(false);
    expect(row.lowStockThreshold).toBe(10); // settings survive
  });

  it("resolves the alert and restores availability on replenishment", async () => {
    const { owner, shop, sp } = await shopWithStock(0, 10);

    await restockOnline(sp.id, 50, "Stock received", owner.id);

    const [row] = await db.select().from(shopProducts).where(eq(shopProducts.id, sp.id));
    expect(row.onlineStock).toBe(50);
    expect(row.isAvailable).toBe(true);

    const open = await listStockAlerts(shop.id, { status: "OPEN" });
    expect(open).toHaveLength(0);
    const resolved = await listStockAlerts(shop.id, { status: "RESOLVED" });
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("does not pile up duplicate open alerts for a line that stays low", async () => {
    const { shop, sp } = await shopWithStock(7, 10);
    await evaluateStockAlerts(sp.id);
    await evaluateStockAlerts(sp.id);

    const open = await listStockAlerts(shop.id, { status: "OPEN" });
    expect(open.filter((a) => a.alertType === "LOW_STOCK")).toHaveLength(1);
  });

  it("lets the shop owner acknowledge an alert but not another shop's", async () => {
    const { shop } = await shopWithStock(7, 10);
    const [alert] = await listStockAlerts(shop.id);

    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(acknowledgeStockAlert(alert.id, OWNER(stranger.id))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const owner = await createUser({ role: "ADMIN" });
    const acked = await acknowledgeStockAlert(alert.id, ADMIN(owner.id));
    expect(acked.status).toBe("ACKNOWLEDGED");
  });
});

describe("inventory dashboard (§22)", () => {
  it("counts each line once and values stock at the shop's selling price", async () => {
    const { product } = await masterProductWithGtin();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);

    const category = await createCategory({ department: "DAIRY", name: "Curd" });
    const second = await createProduct(category.id, { name: "Curd 500g" });
    const third = await createProduct(category.id, { name: "Paneer 200g" });

    // 20 units @ ₹90, threshold 5 → in stock
    await createShopProduct(shop.id, product.id, { onlinePricePaise: 9000, onlineStock: 20 });
    // 3 units @ ₹50, threshold 5 → low stock
    const low = await createShopProduct(shop.id, second.id, {
      onlinePricePaise: 5000,
      onlineStock: 3,
    });
    await setStockThresholds(low.id, { lowStockThreshold: 5, reorderLevel: 5 }, OWNER(owner.id));
    // 0 units → out of stock
    await createShopProduct(shop.id, third.id, { onlinePricePaise: 8000, onlineStock: 0 });

    const dashboard = await getInventoryDashboard(shop.id);
    expect(dashboard.totalProducts).toBe(3);
    expect(dashboard.inStock).toBe(1);
    expect(dashboard.lowStock).toBe(1);
    expect(dashboard.outOfStock).toBe(1);
    expect(dashboard.reorderRequired).toBe(1);
    // 20×9000 + 3×5000 + 0 = 195000
    expect(dashboard.inventoryValuePaise).toBe(195000);
  });
});

describe("brands", () => {
  it("refuses a duplicate brand name", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await createBrand({ name: "Amul" }, ADMIN(admin.id));
    await expect(createBrand({ name: "amul" }, ADMIN(admin.id))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const rows = await db.select().from(brands);
    expect(rows).toHaveLength(1);
  });
});
