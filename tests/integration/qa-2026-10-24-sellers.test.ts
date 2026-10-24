/**
 * Seller-side fixes from the automated QA run of 24 Oct 2026 (shop onboarding,
 * catalogue, pricing, MRP and field validation). Each case names its TC ID.
 */
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { PATCH as productGstPatch } from "@/app/api/admin/product-gst/[productId]/route";
import { POST as mrpCorrectionsPost } from "@/app/api/mrp/corrections/route";
import { POST as mrpPost } from "@/app/api/mrp/route";
import { POST as productsPost } from "@/app/api/products/route";
import { GET as referralCodesGet } from "@/app/api/referral-codes/route";
import { DELETE as shopProductDelete, PATCH as shopProductPatch } from "@/app/api/shop-products/[id]/route";
import { POST as classificationPost } from "@/app/api/shops/[id]/classification/route";
import { PATCH as compliancePatch } from "@/app/api/shops/[id]/compliance/route";
import { POST as gstPost } from "@/app/api/shops/[id]/gst/route";
import { PATCH as stockSettingsPatch } from "@/app/api/shop-products/[id]/stock-settings/route";
import { GET as shopProductsGet, POST as shopProductsPost } from "@/app/api/shops/[id]/products/route";
import { POST as rejectPost } from "@/app/api/shops/[id]/reject/route";
import { PATCH as shopPatch } from "@/app/api/shops/[id]/route";
import { POST as registerPost } from "@/app/api/shops/route";
import { encryptPan, panBlindIndex } from "@/lib/pan-crypto";
import { adjustStockTo, writeOffStock } from "@/server/accounts/stock";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  productCategories,
  productPriceHistory,
  products,
  shopCategories,
  referralCodes,
  referralRedemptions,
  shopClassificationHistory,
  shopProducts,
  shops,
} from "@/server/db/schema";
import { listStorefrontCategories, listStorefrontProducts, updateShopProduct } from "@/server/services/catalogue";
import { validateUpload } from "@/server/services/excel";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { getReferralPerformance } from "@/server/services/referrals";
import { approveShop, rejectShop } from "@/server/services/shops";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  linkShopCategory,
  resetDatabase,
  verifySellerDocuments,
} from "../helpers/fixtures";
import { gstin } from "../helpers/gstin";

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
});

function signIn(user: { id: string; email: string }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: null, image: null, role, status: "ACTIVE" } };
}

const actor = (user: { id: string }, role: UserRole) => ({ id: user.id, role });

/** Shop categories are seeded by migration 0035; resetDatabase leaves them alone. */
async function shopCategoryIds(): Promise<string[]> {
  return (await db.select({ id: shopCategories.id }).from(shopCategories).limit(1)).map((r) => r.id);
}

/** An owner signed in with an approved dairy shop selling one product. */
async function ownerWithListing() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id);
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk" });
  const listing = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000 });
  signIn(owner, "SHOP_OWNER");
  return { owner, shop, category, product, listing };
}

describe("TC-CAT-004: no channel goes on sale at ₹0", () => {
  it("PATCH /api/shop-products/{id} refuses a 0 price; 1 paisa and null (with sale off) are accepted", async () => {
    const { listing } = await ownerWithListing();
    const params = { id: listing.id };
    const zero = await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { onlineSaleEnabled: true, onlinePricePaise: 0 }, params });
    expect(zero.status).toBe(422);
    const offlineZero = await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { offlineSaleEnabled: true, offlinePricePaise: 0 }, params });
    expect(offlineZero.status).toBe(422);
    const [row] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(row.onlinePricePaise).toBe(7000);

    const paisa = await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { onlinePricePaise: 1 }, params });
    expect(paisa.status).toBe(200);
    const unpriced = await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { onlineSaleEnabled: false, onlinePricePaise: null }, params });
    expect(unpriced.status).toBe(200);
  });

  it("the service refuses 0 too, and a stored 0 cannot be switched on sale", async () => {
    const { owner, listing } = await ownerWithListing();
    await expect(updateShopProduct(listing.id, { onlinePricePaise: 0 }, actor(owner, "SHOP_OWNER") as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // A legacy row: offline price 0, offline sale off. Unrelated edits still save; going on sale does not.
    await db.update(shopProducts).set({ offlinePricePaise: 0, offlineSaleEnabled: false }).where(eq(shopProducts.id, listing.id));
    await expect(updateShopProduct(listing.id, { description: "Fresh daily" }, actor(owner, "SHOP_OWNER") as never)).resolves.toMatchObject({ description: "Fresh daily" });
    await expect(updateShopProduct(listing.id, { offlineSaleEnabled: true }, actor(owner, "SHOP_OWNER") as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("adding a listing or creating a product with a 0 price is refused", async () => {
    const { shop, category } = await ownerWithListing();
    const curd = await createProduct(category.id, { name: "Curd" });
    const add = await call(shopProductsPost, `/api/shops/${shop.id}/products`, {
      method: "POST",
      body: { productId: curd.id, onlineSaleEnabled: true, onlinePricePaise: 0 },
      params: { id: shop.id },
    });
    expect(add.status).toBe(422);
    const created = await call(productsPost, "/api/products", {
      method: "POST",
      body: { shopId: shop.id, categoryId: category.id, name: "Free Paneer", unit: "kg", onlineSaleEnabled: true, onlinePricePaise: 0 },
    });
    expect(created.status).toBe(422);
  });
});

describe("Removed listing listed again (seen in passing, no TC)", () => {
  it("POST /api/shops/{id}/products brings the removed row back instead of answering 409", async () => {
    const { shop, listing, product } = await ownerWithListing();
    const removed = await call(shopProductDelete, `/api/shop-products/${listing.id}`, { method: "DELETE", params: { id: listing.id } });
    expect(removed.status).toBe(200);

    const again = await call(shopProductsPost, `/api/shops/${shop.id}/products`, {
      method: "POST",
      body: { productId: product.id, onlineSaleEnabled: true, onlinePricePaise: 7500, onlineStock: 20 },
      params: { id: shop.id },
    });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(listing.id);
    const [row] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(row).toMatchObject({ deletedAt: null, isActive: true, onlineSaleEnabled: true, onlinePricePaise: 7500, onlineStock: 20 });
    const history = await db.select().from(productPriceHistory).where(eq(productPriceHistory.shopProductId, listing.id));
    expect(history.map((h) => [h.previousPricePaise, h.newPricePaise])).toContainEqual([7000, 7500]);

    // Listed again, it is a live listing: a third add is the usual 409.
    const third = await call(shopProductsPost, `/api/shops/${shop.id}/products`, {
      method: "POST",
      body: { productId: product.id, onlineSaleEnabled: false },
      params: { id: shop.id },
    });
    expect(third.status).toBe(409);
  });
});

describe("TC-CAT-050: a big shop's storefront reaches every category", () => {
  it("lists every category with its count and pages one category from the database", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const [big, late] = [await createCategory({ name: "Bulk Goods" }), await createCategory({ name: "Late Category" })];
    await db.update(productCategories).set({ sortOrder: 0 }).where(eq(productCategories.id, big.id));
    await db.update(productCategories).set({ sortOrder: 99 }).where(eq(productCategories.id, late.id));
    const rows = await db
      .insert(products)
      .values([
        ...Array.from({ length: 105 }, (_, i) => ({ categoryId: big.id, name: `Bulk ${String(i).padStart(3, "0")}`, slug: `bulk-${i}-${Date.now()}`, unit: "kg" })),
        ...Array.from({ length: 3 }, (_, i) => ({ categoryId: late.id, name: `Late ${i}`, slug: `late-${i}-${Date.now()}`, unit: "piece" })),
      ])
      .returning({ id: products.id });
    await linkShopCategory(shop.id, big.id);
    await linkShopCategory(shop.id, late.id);
    await db.insert(shopProducts).values(rows.map((p) => ({ shopId: shop.id, productId: p.id, onlineSaleEnabled: true, onlinePricePaise: 1000, onlineStock: 5 })));

    // The old page read the first 100 products only: "Late Category" was never among them.
    const first100 = await listStorefrontProducts({ shopId: shop.id, limit: 100 });
    expect(first100.some((p) => p.categoryName === "Late Category")).toBe(false);

    const categories = await listStorefrontCategories(shop.id);
    expect(categories.map((c) => [c.categoryName, c.count])).toEqual([["Bulk Goods", 105], ["Late Category", 3]]);
    const lateProducts = await listStorefrontProducts({ shopId: shop.id, categoryId: late.id, limit: 6 });
    expect(lateProducts.map((p) => p.productName)).toEqual(["Late 0", "Late 1", "Late 2"]);
    // The last page of the big category, straight from the database.
    const lastPage = await listStorefrontProducts({ shopId: shop.id, categoryId: big.id, limit: 6, offset: 102 });
    expect(lastPage.map((p) => p.productName)).toEqual(["Bulk 102", "Bulk 103", "Bulk 104"]);
  });
});

describe("TC-CAT-033: Excel price list — blank keeps, 0 is refused", () => {
  async function workbook(rows: (string | number | null)[][]): Promise<ArrayBuffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Prices");
    sheet.addRow(["Product ID", "Product Name", "Unit", "Price"]);
    for (const row of rows) sheet.addRow(row);
    return book.xlsx.writeBuffer() as Promise<ArrayBuffer>;
  }

  it("a blank cell is NO_CHANGE (an unpriced loose product stays unpriced) and a 0 is INVALID_PRICE", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const category = await createCategory({ name: "Grains" });
    const sugar = await createProduct(category.id, { name: "Loose Sugar", unit: "kg" });
    const rice = await createProduct(category.id, { name: "Loose Rice", unit: "kg" });
    await db.update(products).set({ kind: "LOOSE" }).where(eq(products.categoryId, category.id));
    const sugarListing = await createShopProduct(shop.id, sugar.id, { onlineSaleEnabled: false, onlinePricePaise: null });
    const riceListing = await createShopProduct(shop.id, rice.id, { onlinePricePaise: 4500 });
    const [s, r] = await Promise.all(
      [sugar.id, rice.id].map(async (id) => (await db.select({ code: products.code }).from(products).where(eq(products.id, id)))[0].code),
    );

    const blank = await validateUpload(
      { shopId: shop.id, fileName: "prices.xlsx", buffer: await workbook([[s, "Loose Sugar", "kg", null], [r, "Loose Rice", "kg", null]]) },
      actor(owner, "SHOP_OWNER"),
    );
    expect(blank.rows.map((row) => [row.productCode, row.status])).toEqual([[s, "NO_CHANGE"], [r, "NO_CHANGE"]]);

    const zero = await validateUpload(
      { shopId: shop.id, fileName: "zero.xlsx", buffer: await workbook([[s, "Loose Sugar", "kg", 0]]) },
      actor(owner, "SHOP_OWNER"),
    );
    expect(zero.rows[0].status).toBe("INVALID_PRICE");
    expect(zero.rows[0].errorMessage).toMatch(/more than ₹0/);

    const rows = await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id));
    expect(rows.find((x) => x.id === sugarListing.id)?.onlinePricePaise).toBeNull();
    expect(rows.find((x) => x.id === riceListing.id)?.onlinePricePaise).toBe(4500);
  });
});

describe("TC-CAT-062 / TC-FLD-079: an MRP is ₹0.01 to ₹10 lakh", () => {
  it("POST /api/mrp and POST /api/mrp/corrections refuse 0 and ₹10 crore", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const category = await createCategory();
    const product = await createProduct(category.id, { name: "Butter 100 g" });
    signIn(admin, "ADMIN");
    for (const mrpPaise of [0, 10_000_000_000]) {
      const res = await call(mrpPost, "/api/mrp", { method: "POST", body: { productId: product.id, mrpPaise, source: "ADMIN" } });
      expect(res.status, String(mrpPaise)).toBe(422);
    }
    const okRes = await call(mrpPost, "/api/mrp", { method: "POST", body: { productId: product.id, mrpPaise: 7050, source: "ADMIN" } });
    expect(okRes.status).toBe(200);

    const owner = await createUser({ role: "SHOP_OWNER" });
    signIn(owner, "SHOP_OWNER");
    for (const claimedMrpPaise of [0, 10_000_000_000]) {
      const res = await call(mrpCorrectionsPost, "/api/mrp/corrections", { method: "POST", body: { productId: product.id, claimedMrpPaise } });
      expect(res.status, String(claimedMrpPaise)).toBe(422);
    }
  });
});

describe("TC-ONB-025: the referral report is JSON", () => {
  it("GET /api/referral-codes?report=1 answers 200 with numbers, not BigInts", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const [code] = await db.insert(referralCodes).values({ code: "QA25", createdBy: admin.id }).returning();
    await db.insert(referralRedemptions).values({ referralCodeId: code.id, shopId: shop.id, registrationFeePaise: 500_000 });

    const performance = await getReferralPerformance();
    expect(performance[0]).toMatchObject({ code: "QA25", shopCount: 1, feesAttributedPaise: 500_000 });
    expect(typeof performance[0].feesAttributedPaise).toBe("number");

    signIn(admin, "ADMIN");
    const res = await call(referralCodesGet, "/api/referral-codes?report=1");
    expect(res.status).toBe(200);
    expect(res.body.performance[0]).toMatchObject({ code: "QA25", feesAttributedPaise: 500_000 });
  });
});

describe("TC-ONB-038 / TC-FLD-121 / TC-ONB-043: only a registration under review is rejected; a closed shop is not approved", () => {
  it("refuses to reject a SUSPENDED or APPROVED shop (409), leaving status and audit untouched", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    signIn(operator, "OPERATOR");
    for (const status of ["SUSPENDED", "APPROVED", "REJECTED"] as const) {
      const shop = await createShop(owner.id, { status, name: `Shop ${status}` });
      const res = await call(rejectPost, `/api/shops/${shop.id}/reject`, { method: "POST", body: { reason: "Documents unclear" }, params: { id: shop.id } });
      expect(res.status, status).toBe(409);
      const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
      expect(row.status).toBe(status);
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, shop.id), eq(auditLogs.action, AUDIT_ACTIONS.SHOP_REJECTED)));
      expect(audits).toHaveLength(0);
    }
    const closed = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "Closed Shop" });
    await db.update(shops).set({ deletedAt: new Date() }).where(eq(shops.id, closed.id));
    await expect(rejectShop(closed.id, "Too late", actor(operator, "OPERATOR"))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a pending shop and stores the reason without its outer spaces", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    signIn(operator, "OPERATOR");
    const res = await call(rejectPost, `/api/shops/${shop.id}/reject`, { method: "POST", body: { reason: "   Licence photo unreadable   " }, params: { id: shop.id } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "REJECTED", rejectionReason: "Licence photo unreadable" });
    // Three letters only after trimming: refused.
    const other = await createShop(owner.id, { status: "PENDING_APPROVAL", name: "Other" });
    const short = await call(rejectPost, `/api/shops/${other.id}/reject`, { method: "POST", body: { reason: "  ab  " }, params: { id: other.id } });
    expect(short.status).toBe(422);
  });

  it("stores a classification reason trimmed (TC-FLD-121)", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { classification: "KESARI" });
    signIn(operator, "OPERATOR");
    const res = await call(classificationPost, `/api/shops/${shop.id}/classification`, { method: "POST", body: { classification: "GREEN", reason: "   Organic produce only   " }, params: { id: shop.id } });
    expect(res.status).toBe(200);
    const [history] = await db.select().from(shopClassificationHistory).where(eq(shopClassificationHistory.shopId, shop.id));
    expect(history.reason).toBe("Organic produce only");
  });

  it("refuses to approve a closed (deleted) shop", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 0 });
    await db.update(shops).set({ feePaymentStatus: "PAID", deletedAt: new Date() }).where(eq(shops.id, shop.id));
    await verifySellerDocuments(shop.id);
    await expect(approveShop(shop.id, { classification: "KESARI" }, actor(admin, "ADMIN"))).rejects.toMatchObject({ code: "CONFLICT" });
    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(row.status).toBe("PENDING_APPROVAL");
  });
});

describe("TC-FLD-037: registration text is trimmed before it is checked", () => {
  it("refuses an address of spaces and stores a padded one trimmed", async () => {
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    const base = {
      name: "Padded Dairy",
      ownerName: "Ramesh Patil",
      phone: "9876543210",
      city: "Pune",
      pincode: "411001",
      shopType: "DAIRY",
      categoryIds: await shopCategoryIds(),
      shopActNumber: "PII-KOTHRUD-II-12345",
    };
    const spaces = await call(registerPost, "/api/shops", { method: "POST", body: { ...base, addressLine1: "      " } });
    expect(spaces.status).toBe(422);
    expect(Object.keys(spaces.body.error.details.fields)).toContain("addressLine1");

    const padded = await call(registerPost, "/api/shops", {
      method: "POST",
      body: { ...base, addressLine1: "   12 Padded Road   ", city: "  Pune  ", landmark: "   ", description: "  Fresh milk daily  " },
    });
    expect(padded.status, JSON.stringify(padded.body)).toBe(201);
    const [row] = await db.select().from(shops).where(eq(shops.id, padded.body.id));
    expect(row).toMatchObject({ addressLine1: "12 Padded Road", city: "Pune", landmark: null, description: "Fresh milk daily" });
  });
});

describe("TC-FLD-043: GSTIN structure, state code, check character and PAN", () => {
  it("POST /api/shops/{id}/gst refuses state 00 / 99, a wrong check character and another PAN; accepts a valid one", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    signIn(owner, "SHOP_OWNER");
    const post = (g: string) => call(gstPost, `/api/shops/${shop.id}/gst`, { method: "POST", body: { gstin: g }, params: { id: shop.id } });
    const valid = gstin("27", "ABCPE1234F");
    const wrongCheck = valid.slice(0, 14) + (valid.endsWith("A") ? "B" : "A");
    for (const bad of [gstin("00", "ABCPE1234F"), gstin("99", "ABCPE1234F"), wrongCheck]) {
      expect((await post(bad)).status, bad).toBe(422);
    }
    // The shop's PAN is on file: a GSTIN issued on another PAN is refused.
    await db
      .update(shops)
      .set({ panNumberEncrypted: encryptPan("ABCPE1234F"), panHash: panBlindIndex("ABCPE1234F"), panLast4: "234F" })
      .where(eq(shops.id, shop.id));
    const otherPan = await post(gstin("27", "ZZZPZ9999Z"));
    expect(otherPan.status).toBe(422);
    expect(otherPan.body.error.message).toMatch(/PAN/);
    const okRes = await post(valid);
    expect(okRes.status).toBe(200);
    expect(okRes.body).toMatchObject({ gstin: valid, gstStatus: "PENDING_VERIFICATION" });
  });

  it("registration refuses a GSTIN whose PAN differs from the PAN entered", async () => {
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    const res = await call(registerPost, "/api/shops", {
      method: "POST",
      body: {
        name: "Gst Dairy", ownerName: "Ramesh Patil", phone: "9876543210", addressLine1: "1 Main Road", city: "Pune", pincode: "411001",
        shopType: "DAIRY", categoryIds: await shopCategoryIds(), panNumber: "ABCPE1234F", panHolderName: "Ramesh Patil", gstin: gstin("27", "ZZZPZ9999Z"),
      },
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.details.fields)).toEqual(["gstin"]);
  });
});

describe("TC-FLD-044: the compliance screen takes the owner's FSSAI rule (14 digits)", () => {
  it("refuses 13 and 15 digits and letters; stores 14 digits", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    signIn(admin, "ADMIN");
    const patch = (body: Record<string, unknown>) => call(compliancePatch, `/api/shops/${shop.id}/compliance`, { method: "PATCH", body, params: { id: shop.id } });
    for (const fssai of ["1152199800012", "115219980001234", "1152199800012A"]) {
      expect((await patch({ fssaiLicenseNumber: fssai })).status, fssai).toBe(422);
    }
    const okRes = await patch({ fssaiLicenseNumber: "11521998000123" });
    expect(okRes.status).toBe(200);
    expect(okRes.body.fssaiLicenseNumber).toBe("11521998000123");
    expect((await patch({ gstin: gstin("99", "ABCPE1234F") })).status).toBe(422);
  });
});

describe("Shop settings PATCH (TC-FLD-051/052/053/054/056)", () => {
  async function owner() {
    const user = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(user.id);
    signIn(user, "SHOP_OWNER");
    const patch = (body: Record<string, unknown>) => call(shopPatch, `/api/shops/${shop.id}`, { method: "PATCH", body, params: { id: shop.id } });
    return { shop, patch };
  }

  it("TC-FLD-051 / TC-FLD-053: ₹10 crore minimum order, delivery fee and free-delivery threshold are refused; sane values save", async () => {
    const { patch } = await owner();
    for (const key of ["minOrderPaise", "deliveryFeePaise", "freeDeliveryAbovePaise"]) {
      expect((await patch({ [key]: 10_000_000_000 })).status, key).toBe(422);
    }
    expect((await patch({ deliveryFeePaise: 500_001 })).status).toBe(422);
    const res = await patch({ minOrderPaise: 10_000_000, deliveryFeePaise: 500_000, freeDeliveryAbovePaise: 50_000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minOrderPaise: 10_000_000, deliveryFeePaise: 500_000, freeDeliveryAbovePaise: 50_000 });
  });

  it("TC-FLD-052: opening hours must be HH:MM 00:00–23:59, open ≠ close, each day once; past midnight is fine", async () => {
    const { patch } = await owner();
    for (const openingHours of [
      [{ day: 1, open: "25:00", close: "22:00" }],
      [{ day: 1, open: "morning", close: "night" }],
      [{ day: 1, open: "09:00", close: "09:00" }],
      [{ day: 1, open: "09:00", close: "18:00" }, { day: 1, open: "10:00", close: "19:00" }],
      [{ day: 7, open: "09:00", close: "18:00" }],
    ]) {
      expect((await patch({ openingHours })).status, JSON.stringify(openingHours)).toBe(422);
    }
    const res = await patch({ openingHours: [{ day: 5, open: "18:00", close: "02:00" }, { day: 0, open: "09:00", close: "09:00", closed: true }] });
    expect(res.status).toBe(200);
  });

  it("TC-FLD-054: preparation time is a setting, 5–240 minutes", async () => {
    const { shop, patch } = await owner();
    expect((await patch({ preparationTimeMinutes: 4 })).status).toBe(422);
    expect((await patch({ preparationTimeMinutes: 241 })).status).toBe(422);
    const res = await patch({ preparationTimeMinutes: 30 });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(row.preparationTimeMinutes).toBe(30);
  });

  it("TC-FLD-056: a logo must be https or an own upload — javascript: is refused", async () => {
    const { patch } = await owner();
    for (const logoUrl of ["javascript:alert(1)", "data:image/png;base64,AAAA", "http://example.com/logo.png"]) {
      expect((await patch({ logoUrl })).status, logoUrl).toBe(422);
    }
    expect((await patch({ photos: ["javascript:alert(1)"] })).status).toBe(422);
    expect((await patch({ logoUrl: "https://example.com/logo.png" })).status).toBe(200);
    expect((await patch({ logoUrl: "/api/images/00000000-0000-4000-8000-000000000001" })).status).toBe(200);
  });

  it("TC-ONB-042 (feature gap, not built): an owner cannot close the shop through settings", async () => {
    const { patch } = await owner();
    expect((await patch({ status: "CLOSED" })).status).toBe(422);
  });
});

describe("TC-FLD-074: a new product's unit comes from the list", () => {
  it("POST /api/products refuses bananas, 0 kg and blank; stores a known unit in its standard spelling", async () => {
    const { shop, category } = await ownerWithListing();
    for (const unit of ["bananas", "0 kg", "-5 L", ""]) {
      const res = await call(productsPost, "/api/products", { method: "POST", body: { shopId: shop.id, categoryId: category.id, name: `Odd ${unit}`, unit, confirmDuplicate: true } });
      expect(res.status, unit).toBe(422);
    }
    const res = await call(productsPost, "/api/products", { method: "POST", body: { shopId: shop.id, categoryId: category.id, name: "Half Kilo Paneer", unit: "Kg", unitSizeMilli: 500, confirmDuplicate: true } });
    expect(res.status).toBe(201);
    expect(res.body.product.unit).toBe("kg");
  });
});

describe("TC-FLD-078: the admin GST editor takes only GST rates in force", () => {
  it("refuses 7 % and -5 %; saves 0, 5, 12, 18 and 28 %", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const category = await createCategory();
    const product = await createProduct(category.id, { name: "Ghee 500 ml" });
    signIn(admin, "ADMIN");
    const patch = (gstRatePercent: number) =>
      call(productGstPatch, `/api/admin/product-gst/${product.id}`, { method: "PATCH", params: { productId: product.id }, body: { hsnCode: "0405", gstRatePercent, reason: "QA GST check" } });
    expect((await patch(7)).status).toBe(422);
    expect((await patch(-5)).status).toBe(422);
    for (const rate of [0, 5, 12, 18, 28]) {
      expect((await patch(rate)).status, String(rate)).toBe(200);
    }
  });
});

/* ------------------------------------------------- finance / inventory package */

describe("N4 (SC-23): a physical count sets the shelf total without emptying the online count", () => {
  it("100 online + 100 in shop, counted 37 → 37 online, 0 in shop, still available", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const category = await createCategory({ name: "Grocery" });
    const product = await createProduct(category.id, { name: "Tea 250 g", unit: "pack" });
    const listing = await createShopProduct(shop.id, product.id, { onlinePricePaise: 12_000, onlineStock: 100, offlineSaleEnabled: true });
    await updateShopProduct(listing.id, { offlineStock: 100 }, actor(owner, "SHOP_OWNER") as never);

    await adjustStockTo(shop.id, listing.id, 37_000, "Shelf count", owner.id);
    const [row] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(row).toMatchObject({ onlineStock: 37, offlineStock: 0, isAvailable: true });

    // A count above the total goes to the purchase channel (online by default).
    await adjustStockTo(shop.id, listing.id, 50_000, "Shelf count", owner.id);
    const [after] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(after).toMatchObject({ onlineStock: 50, offlineStock: 0 });
  });

  it("TC-FLD-065: a packaged product is counted and written off in whole units; loose goods keep fractions", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const category = await createCategory({ name: "Grocery" });
    const packaged = await createProduct(category.id, { name: "Biscuits 100 g", unit: "pack" });
    const loose = await createProduct(category.id, { name: "Loose Rice", unit: "kg" });
    await db.update(products).set({ kind: "LOOSE" }).where(eq(products.id, loose.id));
    const pack = await createShopProduct(shop.id, packaged.id, { onlineStock: 10 });
    const rice = await createShopProduct(shop.id, loose.id, { onlineStock: 10 });
    await expect(writeOffStock(shop.id, { shopProductId: pack.id, qtyMilli: 1_500, kind: "DAMAGE" }, owner.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(adjustStockTo(shop.id, pack.id, 7_500, null, owner.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(writeOffStock(shop.id, { shopProductId: pack.id, qtyMilli: 2_000, kind: "DAMAGE" }, owner.id)).resolves.toBeTruthy();
    await expect(writeOffStock(shop.id, { shopProductId: rice.id, qtyMilli: 1_500, kind: "EXPIRY" }, owner.id)).resolves.toBeTruthy();
  });
});

describe("N7 (TC-SPI-022): a stale stock save is refused, not written over an order", () => {
  it("opened at 10, an order takes 4, saving 8 → 409 'it is now 6'; stock stays 6", async () => {
    const { listing } = await ownerWithListing();
    await db.update(shopProducts).set({ onlineStock: 10 }).where(eq(shopProducts.id, listing.id));
    await db.update(shopProducts).set({ onlineStock: 6 }).where(eq(shopProducts.id, listing.id)); // the order
    const params = { id: listing.id };
    const stale = await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { onlineStock: 8, expectedOnlineStock: 10 }, params });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/it is now 6/);
    const [row] = await db.select().from(shopProducts).where(eq(shopProducts.id, listing.id));
    expect(row.onlineStock).toBe(6);

    // With the figure the page now shows, it saves; a caller that sends no expected figure still sets it outright.
    expect((await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { onlineStock: 5, expectedOnlineStock: 6 }, params })).status).toBe(200);
    expect((await call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body: { onlineStock: 9 }, params })).body.onlineStock).toBe(9);
  });
});

describe("N8 (TC-SPI-027) / N12 (TC-SPI-023): the public storefront API", () => {
  it("customers get inStock, never the count; buyable rows come before out-of-stock ones; staff still get counts", async () => {
    const { owner, shop, category } = await ownerWithListing();
    const oos = await createShopProduct(shop.id, (await createProduct(category.id, { name: "AAA Oos Cereal" })).id, { onlinePricePaise: 9_900, onlineStock: 0 });
    const fine = await createShopProduct(shop.id, (await createProduct(category.id, { name: "ZZZ Fine Cereal" })).id, { onlinePricePaise: 9_900, onlineStock: 10 });
    const customer = await createUser();
    signIn(customer, "CUSTOMER");
    const res = await call(shopProductsGet, `/api/shops/${shop.id}/products?limit=100`, { params: { id: shop.id } });
    expect(res.status).toBe(200);
    const rows = res.body as { shopProductId: string; onlineStock?: number; inStock: boolean }[];
    expect(rows.every((r) => r.onlineStock === undefined && !("offlineStock" in r))).toBe(true);
    expect(rows.find((r) => r.shopProductId === oos.id)?.inStock).toBe(false);
    expect(rows.find((r) => r.shopProductId === fine.id)?.inStock).toBe(true);
    const ids = rows.map((r) => r.shopProductId);
    expect(ids.indexOf(oos.id)).toBeGreaterThan(ids.indexOf(fine.id));

    signIn(owner, "SHOP_OWNER");
    const own = await call(shopProductsGet, `/api/shops/${shop.id}/products`, { params: { id: shop.id } });
    expect(JSON.stringify(own.body)).toContain('"onlineStock":10');
  });
});

describe("Listing field bounds (TC-FLD-058/059/061/062/063)", () => {
  it("₹10 crore prices, 99,999,999 stock and thresholds are refused; a blank stock is not 0", async () => {
    const { listing } = await ownerWithListing();
    const params = { id: listing.id };
    const patch = (body: Record<string, unknown>) => call(shopProductPatch, `/api/shop-products/${listing.id}`, { method: "PATCH", body, params });
    expect((await patch({ onlinePricePaise: 10_000_000_000 })).status).toBe(422);
    expect((await patch({ offlineSaleEnabled: true, offlinePricePaise: 10_000_000_000 })).status).toBe(422);
    expect((await patch({ onlineStock: 99_999_999 })).status).toBe(422);
    expect((await patch({ onlineStock: "" })).status).toBe(422);
    expect((await patch({ onlinePricePaise: 100_000_000, onlineStock: 1_000_000 })).status).toBe(200);
    for (const key of ["lowStockThreshold", "reorderLevel", "reorderQuantity"]) {
      const res = await call(stockSettingsPatch, `/api/shop-products/${listing.id}/stock-settings`, { method: "PATCH", body: { [key]: 99_999_999 }, params });
      expect(res.status, key).toBe(422);
    }
  });
});
