/**
 * Excel GOODS uploads — creating new products from a spreadsheet (product
 * management brief §"Product Upload Behavior", §21, TESTs 4/7/8/11).
 *
 * Builds real .xlsx buffers with ExcelJS (the same library the parser uses) so
 * these exercise the actual header-matching and cell-parsing code, not a
 * hand-rolled stand-in for it.
 */
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { products, shopProducts } from "@/server/db/schema";
import { applyUpload, validateUpload } from "@/server/services/excel";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  linkShopCategory,
  resetDatabase,
} from "../helpers/fixtures";

const OWNER = (id: string) => ({ id, role: "SHOP_OWNER" as const });
const OPERATOR = (id: string) => ({ id, role: "OPERATOR" as const });

async function buildWorkbook(
  headers: string[],
  rows: (string | number)[][],
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

describe("GOODS upload — new products", () => {
  beforeEach(resetDatabase);

  it("creates a brand-new product from a row with no Product ID (TEST 4)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    await createCategory({ department: "DAIRY", name: "Milk" });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [["", "Fresh Cow Milk", "Milk", "1 Litre", "70"]],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(owner.id),
    );

    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].status).toBe("NEW_PRODUCT");
    expect(preview.counts.newProducts).toBe(1);

    const result = await applyUpload(preview.uploadId, OWNER(owner.id));
    expect(result.created).toBe(1);
    expect(result.wentLive).toBe(true);

    const [created] = await db
      .select()
      .from(products)
      .where(eq(products.name, "Fresh Cow Milk"));
    expect(created).toBeDefined();
    expect(created.approvalStatus).toBe("PENDING_APPROVAL"); // shop owner created it

    const [sp] = await db
      .select()
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shop.id), eq(shopProducts.productId, created.id)));
    expect(sp.onlinePricePaise).toBe(7000);
  });

  it("updates the price when Product ID already exists, rather than creating a duplicate", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Cow Milk" });
    await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000 });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [[product.code, "Cow Milk", "Milk", "L", "72"]],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(owner.id),
    );
    expect(preview.rows[0].status).toBe("VALID");

    await applyUpload(preview.uploadId, OWNER(owner.id));

    const all = await db.select().from(products).where(eq(products.name, "Cow Milk"));
    expect(all).toHaveLength(1); // still exactly one product row

    const [sp] = await db
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.productId, product.id));
    expect(sp.onlinePricePaise).toBe(7200);
  });

  it("attaches a product that another shop already carries, without creating a new row", async () => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { shopType: "DAIRY", name: "Shop A" });
    const shopB = await createShop(ownerB.id, { shopType: "DAIRY", name: "Shop B" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "A2 Milk" });
    await createShopProduct(shopA.id, product.id, { onlinePricePaise: 9000 });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [[product.code, "A2 Milk", "Milk", "L", "9500"]],
    );

    // Shop B does not carry "Milk" yet, so the row is refused with the reason...
    const refused = await validateUpload(
      { shopId: shopB.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(ownerB.id),
    );
    expect(refused.rows[0].status).toBe("NOT_FOUND");
    expect(refused.rows[0].errorMessage).toMatch(/does not carry/);

    // ...and accepted once it does.
    await linkShopCategory(shopB.id, category.id);
    const preview = await validateUpload(
      { shopId: shopB.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(ownerB.id),
    );
    expect(preview.rows[0].status).toBe("VALID");

    const result = await applyUpload(preview.uploadId, OWNER(ownerB.id));
    expect(result.created).toBe(1);

    const all = await db.select().from(products).where(eq(products.name, "A2 Milk"));
    expect(all).toHaveLength(1); // reused, not duplicated

    const [spB] = await db
      .select()
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shopB.id), eq(shopProducts.productId, product.id)));
    expect(spB.onlinePricePaise).toBe(950000);
  });

  it("flags an unresolvable category rather than guessing", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [["", "Mystery Product", "Not A Real Category", "L", "50"]],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(owner.id),
    );
    expect(preview.rows[0].status).toBe("NOT_FOUND");
    expect(preview.rows[0].errorMessage).toMatch(/unknown category/i);
  });

  it("flags in-sheet duplicate new-product names (TEST 11)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    await createCategory({ department: "DAIRY", name: "Milk" });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [
        ["", "Farm Fresh Milk", "Milk", "L", "60"],
        ["", "Farm Fresh Milk", "Milk", "L", "62"],
      ],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(owner.id),
    );
    expect(preview.rows[0].status).toBe("NEW_PRODUCT");
    expect(preview.rows[1].status).toBe("DUPLICATE");
  });

  it("does not let a GOODS upload for Shop A touch Shop B (TEST 7, TEST 8)", async () => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { shopType: "DAIRY", name: "Shop A" });
    const shopB = await createShop(ownerB.id, { shopType: "DAIRY", name: "Shop B" });
    await createCategory({ department: "DAIRY", name: "Milk" });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [["", "Shop A Exclusive Milk", "Milk", "L", "80"]],
    );

    const preview = await validateUpload(
      { shopId: shopA.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OWNER(ownerA.id),
    );
    await applyUpload(preview.uploadId, OWNER(ownerA.id));

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.name, "Shop A Exclusive Milk"));

    const inA = await db
      .select()
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shopA.id), eq(shopProducts.productId, product.id)));
    const inB = await db
      .select()
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shopB.id), eq(shopProducts.productId, product.id)));

    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
  });

  it("withholds price and stays a proposal when an operator uploads for a shop they don't own", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    await createCategory({ department: "DAIRY", name: "Milk" });

    const buffer = await buildWorkbook(
      ["Product ID", "Product Name", "Category", "Unit", "Price"],
      [["", "Operator Sourced Milk", "Milk", "L", "65"]],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "goods.xlsx", buffer, uploadType: "GOODS" },
      OPERATOR(operator.id),
    );
    const result = await applyUpload(preview.uploadId, OPERATOR(operator.id));

    expect(result.wentLive).toBe(false);
    expect(result.created).toBe(1);
    expect(result.pending).toBe(1);

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.name, "Operator Sourced Milk"));
    const [sp] = await db
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.productId, product.id));
    expect(sp.onlinePricePaise).toBeNull();
    expect(sp.onlineSaleEnabled).toBe(false);
  });
});

describe("PRICES upload is unaffected by the GOODS extension", () => {
  beforeEach(resetDatabase);

  it("still rejects a Product ID this shop doesn't carry (unchanged behaviour)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Some Milk" });

    const buffer = await buildWorkbook(
      ["Product ID", "Price"],
      [[product.code, "70"]],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "prices.xlsx", buffer, uploadType: "PRICES" },
      OWNER(owner.id),
    );
    expect(preview.rows[0].status).toBe("NOT_FOUND");
  });

  it("still requires Product ID — a blank one is MISSING_FIELD, not a new product", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { shopType: "DAIRY" });

    const buffer = await buildWorkbook(
      ["Product ID", "Price"],
      [["", "70"]],
    );

    const preview = await validateUpload(
      { shopId: shop.id, fileName: "prices.xlsx", buffer, uploadType: "PRICES" },
      OWNER(owner.id),
    );
    expect(preview.rows[0].status).toBe("MISSING_FIELD");
  });
});
