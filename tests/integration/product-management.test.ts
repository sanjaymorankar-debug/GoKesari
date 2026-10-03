/**
 * Shop owner / admin product management (product management brief).
 *
 * Covers the brief's numbered test scenarios that are meaningful at the
 * service layer: 1, 2, 3, 6, 9, 10, 11, 12, 13. Scenarios 4, 5, 7, 8 (Excel
 * upload, cross-shop API manipulation) are covered in excel + authorization
 * suites, and by `requireShopAccess` — the same ownership guard every other
 * shop-scoped route in this codebase already relies on.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { PERMISSIONS, can } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { productPriceHistory, products, shopProducts } from "@/server/db/schema";
import {
  createProductForShop,
  createShopProduct,
  findSimilarProducts,
  listProducts,
  suggestProductsForShop,
} from "@/server/services/catalogue";
import {
  createCategory,
  createProduct,
  createShop,
  createUser,
  linkShopCategory,
  resetDatabase,
} from "../helpers/fixtures";

const OWNER = (id: string) => ({ id, role: "SHOP_OWNER" as const });
const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });
const ADMIN = (id: string) => ({ id, role: "ADMIN" as const });

describe("product creation permissions", () => {
  it("gives every operational role the ability to create for their own reach (§ ROLE PERMISSIONS)", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.PRODUCT_CREATE_OWN)).toBe(true);
    expect(can("SHOP_OWNER", PERMISSIONS.PRODUCT_CREATE_ANY)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.PRODUCT_CREATE_ANY)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.PRODUCT_CREATE_ANY)).toBe(true);
  });

  it("reserves publishing to the central catalogue for ADMIN only", () => {
    expect(can("SHOP_OWNER", PERMISSIONS.PRODUCT_APPROVE)).toBe(false);
    expect(can("OPERATOR", PERMISSIONS.PRODUCT_APPROVE)).toBe(false);
    expect(can("ADMIN", PERMISSIONS.PRODUCT_APPROVE)).toBe(true);
  });
});

describe("shop owner creates a new product", () => {
  beforeEach(resetDatabase);

  it("creates the product, attaches it to the shop, saves every field, and audits it (TEST 2, TEST 3)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });

    const result = await createProductForShop(
      {
        shopId: shop.id,
        categoryId: category.id,
        name: "Fresh Cow Milk",
        description: "Fresh farm milk supplied daily.",
        specifications: "Cow milk\n3.5% fat\n1 litre pack\nFresh daily",
        unit: "1 Litre",
        onlineSaleEnabled: true,
        offlineSaleEnabled: true,
        onlinePricePaise: 7000,
        offlinePricePaise: 6800,
      },
      OWNER(owner.id),
      true, // owner's own shop — applies immediately
    );

    expect(result.reusedExisting).toBe(false);
    expect(result.product.name).toBe("Fresh Cow Milk");
    expect(result.product.description).toBe("Fresh farm milk supplied daily.");
    expect(result.product.specifications).toContain("3.5% fat");
    expect(result.product.unit).toBe("1 Litre");
    expect(result.product.createdBy).toBe(owner.id);

    expect(result.shopProduct.shopId).toBe(shop.id);
    expect(result.shopProduct.onlinePricePaise).toBe(7000);
    expect(result.shopProduct.offlinePricePaise).toBe(6800);
    expect(result.shopProduct.onlineSaleEnabled).toBe(true);

    // Record who created it and when (§ "record creation date/time").
    const [row] = await db.select().from(products).where(eq(products.id, result.product.id));
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("starts PENDING_APPROVAL for a shop owner, so other shops cannot find it yet (TEST 9)", async () => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { shopType: "DAIRY", name: "Shop A" });
    const shopB = await createShop(ownerB.id, { shopType: "DAIRY", name: "Shop B" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });

    const result = await createProductForShop(
      {
        shopId: shopA.id,
        categoryId: category.id,
        name: "A2 Cow Milk",
        unit: "1 Litre",
        onlineSaleEnabled: true,
        onlinePricePaise: 8000,
      },
      OWNER(ownerA.id),
      true,
    );
    expect(result.product.approvalStatus).toBe("PENDING_APPROVAL");

    // TEST 1's guarantee, from the other direction: it appears ONLY in Shop A.
    const [inShopA] = await db
      .select()
      .from(shopProducts)
      .where(
        and(eq(shopProducts.shopId, shopA.id), eq(shopProducts.productId, result.product.id)),
      );
    expect(inShopA).toBeDefined();

    const [inShopB] = await db
      .select()
      .from(shopProducts)
      .where(
        and(eq(shopProducts.shopId, shopB.id), eq(shopProducts.productId, result.product.id)),
      );
    expect(inShopB).toBeUndefined();

    // And it must not surface in Shop B's "add existing" search.
    // (Shop B carries the category, so only the approval gate hides it.)
    await linkShopCategory(shopB.id, category.id);
    const suggestionsForB = await suggestProductsForShop(shopB.id);
    expect(suggestionsForB.some((p) => p.id === result.product.id)).toBe(false);
  });

  it("is discoverable by other shops once an admin publishes it", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });

    const { product } = await createProductForShop(
      { shopId: shop.id, categoryId: category.id, name: "Toned Milk Special", unit: "1 L" },
      OWNER(owner.id),
      true,
    );

    let visible = await listProducts({ department: "DAIRY" });
    expect(visible.some((p) => p.id === product.id)).toBe(false);

    const { approveProduct } = await import("@/server/services/catalogue");
    const admin = await createUser({ role: "ADMIN" });
    await approveProduct(product.id, ADMIN(admin.id));

    visible = await listProducts({ department: "DAIRY" });
    expect(visible.some((p) => p.id === product.id)).toBe(true);
  });

  it("skips PENDING_APPROVAL when an admin creates the product (already trusted)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });

    const { product } = await createProductForShop(
      { shopId: shop.id, categoryId: category.id, name: "Admin-added Milk", unit: "1 L" },
      ADMIN(admin.id),
      true,
    );
    expect(product.approvalStatus).toBe("APPROVED");
  });
});

describe("duplicate detection", () => {
  beforeEach(resetDatabase);

  it("reuses an exact name match in the same category instead of duplicating it (TEST 11)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const existing = await createProduct(category.id, { name: "Cow Milk" });

    const result = await createProductForShop(
      { shopId: shop.id, categoryId: category.id, name: "cow milk", unit: "1 L", onlinePricePaise: 7000, onlineSaleEnabled: true },
      OWNER(owner.id),
      true,
    );

    expect(result.reusedExisting).toBe(true);
    expect(result.product.id).toBe(existing.id);

    const all = await db.select().from(products).where(eq(products.name, "Cow Milk"));
    expect(all).toHaveLength(1); // no duplicate row created
  });

  it("blocks a near-duplicate name unless confirmDuplicate is set", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    await createProduct(category.id, { name: "Buffalo Milk" });

    await expect(
      createProductForShop(
        { shopId: shop.id, categoryId: category.id, name: "Buffalo Milk 1L", unit: "1 L" },
        OWNER(owner.id),
        true,
      ),
    ).rejects.toThrow();

    const created = await createProductForShop(
      {
        shopId: shop.id,
        categoryId: category.id,
        name: "Buffalo Milk 1L",
        unit: "1 L",
        confirmDuplicate: true,
      },
      OWNER(owner.id),
      true,
    );
    expect(created.product.name).toBe("Buffalo Milk 1L");
    expect(created.similarWarning.some((p) => p.name === "Buffalo Milk")).toBe(true);
  });

  it("findSimilarProducts scopes the search to one category", async () => {
    const dairyCategory = await createCategory({ department: "DAIRY", name: "Milk" });
    const bakeryCategory = await createCategory({ department: "BAKERY", name: "Bread" });
    await createProduct(dairyCategory.id, { name: "Cow Milk" });

    const inDairy = await findSimilarProducts("Cow Milk", dairyCategory.id);
    expect(inDairy.exact?.name).toBe("Cow Milk");

    const inBakery = await findSimilarProducts("Cow Milk", bakeryCategory.id);
    expect(inBakery.exact).toBeNull();
  });
});

describe("multi-shop pricing independence (TEST 10)", () => {
  beforeEach(resetDatabase);

  it("lets each shop set its own price for the same central product", async () => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { name: "Shop A" });
    const shopB = await createShop(ownerB.id, { name: "Shop B" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Milk 1 L" });
    await linkShopCategory(shopA.id, category.id);
    await linkShopCategory(shopB.id, category.id);

    const spA = await createShopProduct(
      { shopId: shopA.id, productId: product.id, onlineSaleEnabled: true, offlineSaleEnabled: false, onlinePricePaise: 6500 },
      OWNER(ownerA.id),
    );
    const spB = await createShopProduct(
      { shopId: shopB.id, productId: product.id, onlineSaleEnabled: true, offlineSaleEnabled: false, onlinePricePaise: 7500 },
      OWNER(ownerB.id),
    );

    expect(spA.onlinePricePaise).toBe(6500);
    expect(spB.onlinePricePaise).toBe(7500);
    expect(spA.id).not.toBe(spB.id);
  });
});

describe("operator creating a product for a shop they don't own", () => {
  beforeEach(resetDatabase);

  it("withholds the price when applyPriceImmediately is false (preserves the approval workflow)", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });

    const result = await createProductForShop(
      {
        shopId: shop.id,
        categoryId: category.id,
        name: "Operator-added Milk",
        unit: "1 L",
        onlineSaleEnabled: true,
        onlinePricePaise: 9000,
      },
      OPERATOR(operator.id),
      false, // not the owner, not an override-holder
    );

    // The product exists in the shop, but is not yet purchasable — the price
    // is what needs the owner's approval, exactly as an operator's edit to an
    // existing product would (§7/§10, unchanged by this feature).
    expect(result.shopProduct.onlinePricePaise).toBeNull();
    expect(result.shopProduct.onlineSaleEnabled).toBe(false);
    expect(result.product.approvalStatus).toBe("APPROVED"); // operator is trusted
  });
});

describe("price history on a newly created product", () => {
  beforeEach(resetDatabase);

  it("does not write price history for the initial price (there is no 'previous' price to trail)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });

    const { shopProduct } = await createProductForShop(
      { shopId: shop.id, categoryId: category.id, name: "Fresh Toned Milk", unit: "1 L", onlineSaleEnabled: true, onlinePricePaise: 6600 },
      OWNER(owner.id),
      true,
    );

    const history = await db
      .select()
      .from(productPriceHistory)
      .where(eq(productPriceHistory.shopProductId, shopProduct.id));
    expect(history).toHaveLength(0);
  });
});
