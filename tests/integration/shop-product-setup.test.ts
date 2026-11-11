/**
 * "Set up your shop's products" (docs/shop-product-setup-2026-11): the guided
 * flow, the listing statuses, what customers see, and the Excel / CSV path.
 */
import { and, eq } from "drizzle-orm";
import ExcelJS from "exceljs";
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

import { GET as downloadGet } from "@/app/api/shops/[id]/product-setup/download/route";
import { db } from "@/server/db";
import { products, shopBulkUploads, shopListingDetails, shopProducts } from "@/server/db/schema";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { addCategoryToShop, removeCategoryFromShop } from "@/server/services/product-categories";
import {
  applyUpload,
  BULK_HEADERS,
  buildErrorFile,
  buildMyProducts,
  buildTemplate,
  cancelUpload,
  checkUpload,
  confirmUpload,
  createUpload,
  getUploadView,
  listUploadHistory,
} from "@/server/services/shop-bulk-upload";
import {
  addPickedProducts,
  chooseCategories,
  countNewProducts,
  getSetupProgress,
  listCategoryTiles,
  listPickerIds,
  listPickerProducts,
  listShopListings,
  saveListingEdits,
  saveSetupStep,
  setListingPaused,
} from "@/server/services/shop-product-setup";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "APPROVED" });
  const category = await createCategory({ name: "Grocery" });
  const other = await createCategory({ name: "Stationery" });
  const biscuits = await createProduct(category.id, { name: "Biscuits", unit: "pack" });
  await db.update(products).set({ mrpPaise: 3000 }).where(eq(products.id, biscuits.id));
  const tea = await createProduct(category.id, { name: "Tea", unit: "pack" });
  await db.update(products).set({ mrpPaise: 12000 }).where(eq(products.id, tea.id));
  const rice = await createProduct(category.id, { name: "Loose Rice", unit: "kg", kind: "LOOSE" });
  await db.update(products).set({ mrpPaise: 9999 }).where(eq(products.id, rice.id));
  const pen = await createProduct(other.id, { name: "Pen", unit: "piece" });
  await db.update(products).set({ mrpPaise: 1000 }).where(eq(products.id, pen.id));
  const reload = async <T extends { id: string }>(p: T) => (await db.select().from(products).where(eq(products.id, p.id)))[0];
  return { owner, shop, category, other, biscuits: await reload(biscuits), tea: await reload(tea), rice: await reload(rice), pen: await reload(pen) };
}

const statusOf = async (shopId: string, productId: string) =>
  (await listShopListings(shopId)).find((l) => l.productId === productId)?.status;
const rowOf = async (shopId: string, productId: string) =>
  (await db.select().from(shopProducts).where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId))))[0];
const customerSees = async (shopId: string) => (await listStorefrontProducts({ shopId })).map((p) => p.productName).sort();

/** A filled-in upload file. `rows` are [code, include, shopMrp, price, stock]. */
async function xlsx(rows: (string | number | null)[][], headers: readonly string[] = BULK_HEADERS) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  sheet.addRow([...headers]);
  for (const [code, include, shopMrp, price, stock] of rows) {
    sheet.addRow([code, "cat", "tampered name", "brand", "1 pack", "pack", 1, include, shopMrp, price, stock]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

let fileNo = 0;
async function preview(shopId: string, owner: { id: string; role: UserRole }, rows: (string | number | null)[][]) {
  const upload = await createUpload(shopId, { name: `file-${(fileNo += 1)}.xlsx`, bytes: await xlsx(rows) }, owner);
  await checkUpload(upload.id);
  return upload.id;
}

async function imported(shopId: string, owner: { id: string; role: UserRole }, rows: (string | number | null)[][], confirmPause = false) {
  const id = await preview(shopId, owner, rows);
  await confirmUpload(shopId, id, { confirmPause }, owner);
  await applyUpload(id, owner);
  return getUploadView(shopId, id, owner);
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

describe("guided flow", () => {
  it("a new shop has no categories selected, and progress is saved between steps", async () => {
    const { owner, shop, category, other } = await setup();
    expect((await listCategoryTiles(shop.id)).filter((t) => t.selected)).toEqual([]);
    expect((await getSetupProgress(shop.id)).step).toBe(1);

    await chooseCategories(shop.id, [category.id, other.id], owner);
    expect((await getSetupProgress(shop.id)).step).toBe(2);
    expect((await listCategoryTiles(shop.id)).filter((t) => t.selected).map((t) => t.name).sort()).toEqual(["Grocery", "Stationery"]);
    expect((await listCategoryTiles(shop.id)).find((t) => t.name === "Grocery")?.productCount).toBe(3);
    await saveSetupStep(shop.id, 3, owner);
    expect((await getSetupProgress(shop.id)).step).toBe(3);
  });

  it("choosing categories creates no stock", async () => {
    const { owner, shop, category } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    expect(await listShopListings(shop.id)).toEqual([]);
  });

  it("selects, searches and filters only within chosen categories", async () => {
    const { owner, shop, category, tea, pen } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const all = await listPickerProducts(shop.id, {});
    expect(all.products.map((p) => p.name)).toEqual(["Biscuits", "Loose Rice", "Tea"]);
    expect(all.products.some((p) => p.id === pen.id)).toBe(false);
    expect((await listPickerProducts(shop.id, { query: tea.code })).products.map((p) => p.name)).toEqual(["Tea"]);
    expect((await listPickerProducts(shop.id, { query: "nothing like this" })).total).toBe(0);
    expect(await listPickerIds(shop.id, { categoryId: category.id })).toHaveLength(3);
  });

  it("blocks duplicates: an added product shows Already added and is left alone", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    expect(await addPickedProducts(shop.id, [biscuits.id], owner)).toEqual({ added: 1, alreadyAdded: 0 });
    expect((await listPickerProducts(shop.id, {})).products.find((p) => p.id === biscuits.id)?.alreadyAdded).toBe(true);
    expect(await listPickerIds(shop.id, {})).not.toContain(biscuits.id);
    expect(await addPickedProducts(shop.id, [biscuits.id], owner)).toEqual({ added: 0, alreadyAdded: 1 });
    expect(await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id))).toHaveLength(1);
  });

  it("prefills the price from MRP; loose goods keep an empty price", async () => {
    const { owner, shop, category, biscuits, rice } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [biscuits.id, rice.id], owner);
    expect(await rowOf(shop.id, biscuits.id)).toMatchObject({ onlinePricePaise: 3000, onlineStock: 0, stockPending: true });
    expect(await rowOf(shop.id, rice.id)).toMatchObject({ onlinePricePaise: null, onlineSaleEnabled: false, stockPending: true });
    expect(await statusOf(shop.id, biscuits.id)).toBe("NEEDS_STOCK");
  });

  it("Save and go live shows the product to customers", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [biscuits.id], owner);
    const { shopProductId } = (await listShopListings(shop.id))[0];
    const result = await saveListingEdits(shop.id, [{ shopProductId, stock: 12, pricePaise: 2800 }], "live", owner);
    expect(result).toMatchObject({ live: 1, needsStockOrPrice: 0, errors: [] });
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");
    expect(await customerSees(shop.id)).toEqual(["Biscuits"]);
  });

  it("Skip keeps the product hidden in Needs Stock; updating stock later makes it Live", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [biscuits.id], owner);
    const { shopProductId } = (await listShopListings(shop.id))[0];
    const skipped = await saveListingEdits(shop.id, [{ shopProductId, stock: 9, pricePaise: 2900 }], "skip", owner);
    expect(skipped).toMatchObject({ live: 0, needsStockOrPrice: 1 });
    expect(await rowOf(shop.id, biscuits.id)).toMatchObject({ onlinePricePaise: 2900, onlineStock: 0 });
    expect(await customerSees(shop.id)).toEqual([]);

    await saveListingEdits(shop.id, [{ shopProductId, stock: 5 }], "live", owner);
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");
    expect(await customerSees(shop.id)).toEqual(["Biscuits"]);
  });

  it("loose goods cannot go live without a price, and may have decimal stock", async () => {
    const { owner, shop, category, rice } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [rice.id], owner);
    const { shopProductId } = (await listShopListings(shop.id))[0];
    const noPrice = await saveListingEdits(shop.id, [{ shopProductId, stock: 2.5 }], "live", owner);
    expect(noPrice).toMatchObject({ live: 0, needsStockOrPrice: 1 });
    expect(await statusOf(shop.id, rice.id)).toBe("NEEDS_PRICE");
    expect(await customerSees(shop.id)).toEqual([]);
    await saveListingEdits(shop.id, [{ shopProductId, pricePaise: 6000 }], "live", owner);
    expect(await statusOf(shop.id, rice.id)).toBe("LIVE");
  });

  it("refuses decimal stock on packaged goods, a price of 0, and a price above MRP, row by row", async () => {
    const { owner, shop, category, biscuits, tea } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [biscuits.id, tea.id], owner);
    const [a, b] = await listShopListings(shop.id);
    const out = await saveListingEdits(
      shop.id,
      [
        { shopProductId: a.shopProductId, stock: 1.5 },
        { shopProductId: b.shopProductId, stock: 3, pricePaise: 0 },
      ],
      "live",
      owner,
    );
    expect(out.errors.map((e) => e.message).join(" ")).toMatch(/whole number.*more than 0/);
    const above = await saveListingEdits(shop.id, [{ shopProductId: a.shopProductId, stock: 3, pricePaise: 99_999 }], "live", owner);
    expect(above.errors[0].message).toMatch(/more than the MRP/);
  });

  it("a shop's own MRP does not touch the master or another shop", async () => {
    const { owner, shop, category, biscuits } = await setup();
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopB = await createShop(ownerB.id, { status: "APPROVED" });
    for (const [o, s] of [[owner, shop], [ownerB, shopB]] as const) {
      await chooseCategories(s.id, [category.id], o);
      await addPickedProducts(s.id, [biscuits.id], o);
      const { shopProductId } = (await listShopListings(s.id))[0];
      await saveListingEdits(s.id, [{ shopProductId, stock: 3, pricePaise: 2500 }], "live", o);
    }
    const { shopProductId } = (await listShopListings(shop.id))[0];
    await saveListingEdits(shop.id, [{ shopProductId, shopMrpPaise: 2700 }], "live", owner);

    expect((await db.select().from(products).where(eq(products.id, biscuits.id)))[0].mrpPaise).toBe(3000);
    expect((await listStorefrontProducts({ shopId: shop.id }))[0].mrpPaise).toBe(2700);
    expect((await listStorefrontProducts({ shopId: shopB.id }))[0].mrpPaise).toBe(3000);
    expect(await db.select().from(shopListingDetails).where(eq(shopListingDetails.shopId, shopB.id))).toEqual([]);
  });

  it("stock 0 shows Out of Stock and customers do not see it", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [biscuits.id], owner);
    const { shopProductId } = (await listShopListings(shop.id))[0];
    await saveListingEdits(shop.id, [{ shopProductId, stock: 0 }], "live", owner);
    expect(await statusOf(shop.id, biscuits.id)).toBe("OUT_OF_STOCK");
    expect(await customerSees(shop.id)).toEqual([]);
  });

  it("removing and adding back a category pauses and restores listings with stock and price intact", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    await addPickedProducts(shop.id, [biscuits.id], owner);
    const { shopProductId } = (await listShopListings(shop.id))[0];
    await saveListingEdits(shop.id, [{ shopProductId, stock: 7, pricePaise: 2600 }], "live", owner);

    await removeCategoryFromShop(shop.id, category.id, owner);
    expect(await statusOf(shop.id, biscuits.id)).toBe("PAUSED");
    expect(await customerSees(shop.id)).toEqual([]);

    await addCategoryToShop(shop.id, category.id, owner);
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");
    expect(await rowOf(shop.id, biscuits.id)).toMatchObject({ onlineStock: 7, onlinePricePaise: 2600 });
  });

  it("a product added to the master later is not listed, and shows as new", async () => {
    const { owner, shop, category } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    expect(await countNewProducts(shop.id)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await createProduct(category.id, { name: "Fresh Arrival", unit: "pack" });
    expect(await countNewProducts(shop.id)).toBe(1);
    const shown = await listPickerProducts(shop.id, { newOnly: true });
    expect(shown.products.map((p) => [p.name, p.isNew])).toEqual([["Fresh Arrival", true]]);
    expect(await rowOf(shop.id, fresh.id)).toBeUndefined();
  });

  it("an existing listing keeps working: untouched rows stay Live with their own stock", async () => {
    const { owner, shop, biscuits } = await setup();
    await createShopProduct(shop.id, biscuits.id, { onlinePricePaise: 2500, onlineStock: 40 });
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");
    expect(await rowOf(shop.id, biscuits.id)).toMatchObject({ stockPending: false, onlineStock: 40 });
    void owner;
    expect(await customerSees(shop.id)).toEqual(["Biscuits"]);
  });
});

describe("Excel and CSV", () => {
  async function readBook(bytes: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    return workbook;
  }

  it("the template holds only the chosen categories, with read-only columns locked and Product ID as text", async () => {
    const { owner, shop, category, biscuits, pen } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const file = await buildTemplate(shop.id, "xlsx", owner);
    const book = await readBook(file.bytes);
    const sheet = book.getWorksheet("Products")!;
    expect(book.getWorksheet("Instructions")).toBeDefined();
    expect((sheet.getRow(1).values as string[]).slice(1)).toEqual([...BULK_HEADERS]);
    const codes = sheet.getColumn(1).values.slice(2);
    expect(codes).toContain(biscuits.code);
    expect(codes).not.toContain(pen.code);
    const row = sheet.getRow(2);
    expect(row.getCell(1).numFmt).toBe("@");
    expect(row.getCell(1).protection?.locked).not.toBe(false);
    expect(row.getCell(8).protection?.locked).toBe(false);
    expect(row.getCell(11).protection?.locked).toBe(false);
  });

  it("a template needs a category; CSV is offered too; a formula in a name is made harmless", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await expect(buildTemplate(shop.id, "xlsx", owner)).rejects.toThrow(/category/i);
    await chooseCategories(shop.id, [category.id], owner);
    await db.update(products).set({ name: "=HYPERLINK(1)" }).where(eq(products.id, biscuits.id));
    const csv = (await buildTemplate(shop.id, "csv", owner)).bytes.toString("utf8");
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).not.toMatch(/,=HYPERLINK/);
    const sheet = (await readBook((await buildTemplate(shop.id, "xlsx", owner)).bytes)).getWorksheet("Products")!;
    expect(sheet.getColumn(3).values).toContain("'=HYPERLINK(1)");
  });

  it("previews without saving: nothing changes before confirmation", async () => {
    const { owner, shop, category, biscuits, tea, rice } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const id = await preview(shop.id, owner, [
      [biscuits.code, "Yes", null, 25, 10],
      [tea.code, "Yes", null, 100, null],
      [rice.code, "Yes", null, null, 2.5],
    ]);
    const view = await getUploadView(shop.id, id, owner);
    expect(view.status).toBe("READY");
    expect(view.counts).toMatchObject({ goLive: 1, needsStock: 1, needsPrice: 1, errors: 0 });
    expect(await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id))).toHaveLength(0);
  });

  it("applies statuses: go live, blank stock, blank price, and read-only columns never change the master", async () => {
    const { owner, shop, category, biscuits, tea, rice } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const view = await imported(shop.id, owner, [
      [biscuits.code, "Yes", null, 25, 10],
      [tea.code, "Yes", null, 100, null],
      [rice.code, "Yes", null, null, 2.5],
    ]);
    expect(view.status).toBe("DONE");
    expect(view.result).toMatchObject({ live: 1, needsStockOrPrice: 2 });
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");
    expect(await statusOf(shop.id, tea.id)).toBe("NEEDS_STOCK");
    expect(await statusOf(shop.id, rice.id)).toBe("NEEDS_PRICE");
    expect((await db.select().from(products).where(eq(products.id, biscuits.id)))[0].name).toBe("Biscuits");
    expect(await customerSees(shop.id)).toEqual(["Biscuits"]);
  });

  it("No or blank on a product not in the shop is ignored", async () => {
    const { owner, shop, category, biscuits, tea } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const id = await preview(shop.id, owner, [
      [biscuits.code, "No", null, 25, 10],
      [tea.code, null, null, 25, 10],
    ]);
    expect((await getUploadView(shop.id, id, owner)).counts).toMatchObject({ ignored: 2, goLive: 0 });
  });

  it("on an existing listing a blank means no change, and only a typed 0 sets stock to 0", async () => {
    const { owner, shop, biscuits, tea } = await setup();
    await createShopProduct(shop.id, biscuits.id, { onlinePricePaise: 2500, onlineStock: 40 });
    await createShopProduct(shop.id, tea.id, { onlinePricePaise: 9000, onlineStock: 40 });
    const view = await imported(shop.id, owner, [
      [biscuits.code, "Yes", null, null, null],
      [tea.code, "Yes", null, null, 0],
    ]);
    expect(view.counts).toMatchObject({ unchanged: 1, update: 1 });
    expect(await rowOf(shop.id, biscuits.id)).toMatchObject({ onlineStock: 40, onlinePricePaise: 2500 });
    expect(await rowOf(shop.id, tea.id)).toMatchObject({ onlineStock: 0, onlinePricePaise: 9000 });
    expect(await statusOf(shop.id, tea.id)).toBe("OUT_OF_STOCK");
  });

  it("No on an existing listing pauses only after the owner confirms, and never deletes", async () => {
    const { owner, shop, biscuits, tea } = await setup();
    await createShopProduct(shop.id, biscuits.id, { onlinePricePaise: 2500, onlineStock: 40 });
    await createShopProduct(shop.id, tea.id, { onlinePricePaise: 2500, onlineStock: 40 });
    const unconfirmed = await imported(shop.id, owner, [[biscuits.code, "No", null, null, null]], false);
    expect(unconfirmed.counts.pause).toBe(1);
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");

    await imported(shop.id, owner, [[tea.code, "No", null, null, null]], true);
    expect(await statusOf(shop.id, tea.id)).toBe("PAUSED");
    expect((await rowOf(shop.id, tea.id)).deletedAt).toBeNull();
    // A later restock does not end the owner's pause.
    const { shopProductId } = (await listShopListings(shop.id)).find((l) => l.productId === tea.id)!;
    await saveListingEdits(shop.id, [{ shopProductId, stock: 99 }], "live", owner);
    expect(await statusOf(shop.id, tea.id)).toBe("PAUSED");
    await setListingPaused(shop.id, shopProductId, false, owner);
    expect(await statusOf(shop.id, tea.id)).toBe("LIVE");
    await setListingPaused(shop.id, shopProductId, true, owner);
    expect(await customerSees(shop.id)).toEqual(["Biscuits"]);
  });

  it("explains unknown IDs, duplicates and bad values; imports valid rows; the error file re-uploads", async () => {
    const { owner, shop, category, biscuits, tea, rice, pen } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const id = await preview(shop.id, owner, [
      ["P99999", "Yes", null, 10, 1],
      [tea.code, "Yes", null, 50, 1],
      [tea.code, "Yes", null, 50, 2],
      [rice.code, "Maybe", null, 50, 1],
      [biscuits.code, "Yes", null, "abc", 1],
      [pen.code, "Yes", null, 5, 1.5],
    ]);
    const view = await getUploadView(shop.id, id, owner);
    expect(view.counts.errors).toBe(6);
    const text = view.errors.map((e) => e.message).join(" | ");
    expect(text).toMatch(/P99999 is not in the GoKesari product list/);
    expect(text).toMatch(/more than once/);
    expect(text).toMatch(/Include must be Yes or No/);
    expect(text).toMatch(/Selling Price must be a number/);
    expect(await db.select().from(products).where(eq(products.code, "P99999"))).toEqual([]);

    const errorFile = await buildErrorFile(shop.id, id, owner);
    const book = await readBook(errorFile.bytes);
    const sheet = book.getWorksheet("Products")!;
    expect((sheet.getRow(1).values as string[]).at(-1)).toBe("Error");
    sheet.getRow(6).getCell(10).value = 28; // biscuits: correct the price
    const corrected = Buffer.from(await book.xlsx.writeBuffer());
    const again = await createUpload(shop.id, { name: "fixed.xlsx", bytes: corrected }, owner);
    await checkUpload(again.id);
    const fixedView = await getUploadView(shop.id, again.id, owner);
    expect(fixedView.status).toBe("READY");
    expect(fixedView.counts.goLive).toBe(1);
  });

  it("imports valid rows and skips error rows", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const view = await imported(shop.id, owner, [
      [biscuits.code, "Yes", null, 25, 10],
      ["P99999", "Yes", null, 10, 1],
    ]);
    expect(view.result).toMatchObject({ live: 1, errors: 1 });
    expect(await statusOf(shop.id, biscuits.id)).toBe("LIVE");
  });

  it("refuses a wrong template, a wrong file type and an oversized file", async () => {
    const { owner, shop } = await setup();
    const wrong = await createUpload(shop.id, { name: "other.xlsx", bytes: await xlsx([], ["Name", "Price"]) }, owner);
    await checkUpload(wrong.id);
    expect(await getUploadView(shop.id, wrong.id, owner)).toMatchObject({ status: "REJECTED", failure: expect.stringMatching(/not the GoKesari product file/) });
    await expect(createUpload(shop.id, { name: "a.pdf", bytes: Buffer.from("x") }, owner)).rejects.toThrow(/xlsx/);
    await expect(createUpload(shop.id, { name: "a.xlsx", bytes: Buffer.alloc(11 * 1024 * 1024) }, owner)).rejects.toThrow(/too large/);
  });

  it("reads a CSV, keeping the Product ID as typed", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const csv = `${BULK_HEADERS.map((h) => `"${h}"`).join(",")}\r\n${biscuits.code},cat,x,b,1,pack,1,Yes,,25,10\r\n`;
    const upload = await createUpload(shop.id, { name: "edited.csv", bytes: Buffer.from(csv) }, owner);
    await checkUpload(upload.id);
    expect((await getUploadView(shop.id, upload.id, owner)).counts).toMatchObject({ goLive: 1, errors: 0 });
  });

  it("a repeated confirm applies once, and the same file cannot be imported twice", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const bytes = await xlsx([[biscuits.code, "Yes", null, 25, 10]]);
    const upload = await createUpload(shop.id, { name: "once.xlsx", bytes }, owner);
    await checkUpload(upload.id);
    expect((await confirmUpload(shop.id, upload.id, { confirmPause: false }, owner)).started).toBe(true);
    expect((await confirmUpload(shop.id, upload.id, { confirmPause: false }, owner)).started).toBe(false);
    await applyUpload(upload.id, owner);
    await applyUpload(upload.id, owner);
    expect(await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id))).toHaveLength(1);
    await expect(createUpload(shop.id, { name: "once.xlsx", bytes }, owner)).rejects.toThrow(/already imported/);
  });

  it("a cancelled upload changes nothing; history records the file in IST", async () => {
    const { owner, shop, category, biscuits } = await setup();
    await chooseCategories(shop.id, [category.id], owner);
    const id = await preview(shop.id, owner, [[biscuits.code, "Yes", null, 25, 10]]);
    await cancelUpload(shop.id, id, owner);
    await expect(confirmUpload(shop.id, id, { confirmPause: false }, owner)).rejects.toThrow();
    expect(await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id))).toHaveLength(0);
    const history = await listUploadHistory(shop.id, owner);
    expect(history[0]).toMatchObject({ status: "CANCELLED", uploadedBy: owner.name ?? "—" });
    expect(history[0].fileName).toMatch(/^file-/);
  });

  it("my products download lists the shop's listings", async () => {
    const { owner, shop, biscuits } = await setup();
    await createShopProduct(shop.id, biscuits.id, { onlinePricePaise: 2500, onlineStock: 40 });
    const csv = (await buildMyProducts(shop.id, "csv", owner)).bytes.toString("utf8");
    expect(csv).toContain(biscuits.code);
    expect(csv).toContain(",Yes,,25,40");
  });

  it("one shop cannot download or change another shop's data", async () => {
    const { owner, shop, category, biscuits } = await setup();
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await createShop(stranger.id);
    await chooseCategories(shop.id, [category.id], owner);
    const id = await preview(shop.id, owner, [[biscuits.code, "Yes", null, 25, 10]]);

    signIn(stranger);
    const res = await call(downloadGet, `/api/shops/${shop.id}/product-setup/download?kind=template`, { params: { id: shop.id } });
    expect(res.status).toBe(403);
    await expect(buildMyProducts(shop.id, "xlsx", stranger)).rejects.toThrow();
    await expect(getUploadView(shop.id, id, stranger)).rejects.toThrow();
    await expect(confirmUpload(shop.id, id, { confirmPause: false }, stranger)).rejects.toThrow();
    await expect(createUpload(shop.id, { name: "x.xlsx", bytes: Buffer.from("x") }, stranger)).rejects.toThrow();
    await expect(saveListingEdits(shop.id, [], "live", stranger)).rejects.toThrow();
    await expect(chooseCategories(shop.id, [category.id], stranger)).rejects.toThrow();
    expect((await db.select().from(shopBulkUploads).where(eq(shopBulkUploads.id, id)))[0].status).toBe("READY");
  });
});
