/**
 * Bulk product upload (docs/product-import-2026-10) against real PostgreSQL:
 * the PUZZLES.xlsm fixture end to end, matching, row actions, inventory modes
 * and the ledger, concurrency with live orders, operator price proposals,
 * images (SSRF guard and once-per-URL download), access rules and the API
 * routes. The test report (docs/testing/bulk-product-upload-test-report.md)
 * cites these test names.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
  deferred: [] as Promise<void>[],
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

// `after` only works inside a request; here the deferred work is collected so a test can await it.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => {
    state.deferred.push(task());
  },
}));

import { POST as commitRoute } from "@/app/api/v1/product-imports/[jobId]/commit/route";
import { GET as reportRoute } from "@/app/api/v1/product-imports/[jobId]/report/route";
import { GET as jobRoute } from "@/app/api/v1/product-imports/[jobId]/route";
import { GET as rowsRoute } from "@/app/api/v1/product-imports/[jobId]/rows/route";
import { GET as templateRoute } from "@/app/api/v1/product-imports/template/route";
import { GET as historyRoute, POST as uploadRoute } from "@/app/api/v1/shops/[shopId]/product-imports/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  inventoryMovements,
  notifications,
  priceUpdateRequests,
  productAttributes,
  productImages,
  productImportJobs,
  productImportRows,
  products,
  shopListingDetails,
  shopProducts,
} from "@/server/db/schema";
import { consumeOnlineStock, createProductForShop } from "@/server/services/catalogue";
import { addCategoryToShop } from "@/server/services/product-categories";
import {
  buildReport,
  cancelJob,
  createImportJob,
  getJobView,
  listJobRows,
  purgeOldProductImports,
  runCommit,
  runParse,
  startCommit,
  type ImportActor,
} from "@/server/services/product-import";
import { fetchImage } from "@/server/product-import/image-fetch";
import { buildAmazonWorkbook, amazonRow, ean13 } from "../helpers/amazon-template";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  linkShopCategory,
  resetDatabase,
} from "../helpers/fixtures";

const FIXTURE = path.join(__dirname, "..", "fixtures", "bulk_upload", "PUZZLES.xlsm");

beforeEach(async () => {
  state.session = null;
  state.deferred = [];
  resetRateLimits();
  await resetDatabase();
  await db.execute(sql`TRUNCATE product_import_jobs, shop_listing_details, product_attributes CASCADE`);
});

const actorOf = (u: { id: string; role: UserRole }): ImportActor => ({ id: u.id, role: u.role });

async function ownerWithShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { shopType: "GENERAL_TRADING" as never });
  return { owner, shop };
}

/** Builds a sheet with one heading row (the GoKesari template's shape, or any CSV-like sheet). */
async function simpleSheet(headers: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** Upload → preview → commit, through the service, in one go. */
async function importFile(
  shopId: string,
  actor: ImportActor,
  bytes: Buffer,
  options: { name?: string; mode?: "SET" | "ADD"; fetcher?: Parameters<typeof runCommit>[2] extends infer O ? (O extends { fetcher?: infer F } ? F : never) : never } = {},
) {
  const { job } = await createImportJob(shopId, { name: options.name ?? "upload.xlsx", bytes }, actor);
  await runParse(job.id);
  const preview = await getJobView(job.id);
  expect(preview.status, preview.errorMessage ?? "").toBe("preview_ready");
  await startCommit(job.id, options.mode ?? "SET", actor);
  const done = await runCommit(job.id, actor, options.fetcher ? { fetcher: options.fetcher } : { skipImages: true });
  const rows = (await listJobRows(job.id, { pageSize: 200 })).rows;
  return { jobId: job.id, preview, done, rows };
}

async function listingBySku(shopId: string, sku: string) {
  const [row] = await db
    .select({ sp: shopProducts, d: shopListingDetails, p: products })
    .from(shopListingDetails)
    .innerJoin(shopProducts, eq(shopProducts.id, shopListingDetails.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopListingDetails.shopId, shopId), eq(shopListingDetails.sellerSku, sku)));
  return row;
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 230, g: 120, b: 20 } } }).jpeg().toBuffer();
}

/* ======================================================================= */

describe("PUZZLES.xlsm end to end", () => {
  it("imports the Amazon PUZZLES template: all fields optional, stock = file Quantity, MRP on the shop only", async () => {
    const { owner, shop } = await ownerWithShop();
    await createCategory({ department: "GENERAL_TRADING" as never, name: "3-D Puzzles" });
    const bytes = readFileSync(FIXTURE);

    const { jobId, preview, done, rows } = await importFile(shop.id, actorOf(owner), bytes, { name: "PUZZLES.xlsm" });

    expect(preview.sourceFormat).toBe("AMAZON_TEMPLATE");
    expect(preview.sheetName).toBe("Template");
    expect(preview.counts.totalRows).toBe(5);
    expect(preview.counts.newProducts).toBe(5);
    expect(preview.messages.join(" ")).toMatch(/macros/i);
    expect(preview.messages.join(" ")).toMatch(/example \/ notice rows: 6, 7/);

    expect(done.status).toBe("completed");
    expect(done.counts.created).toBe(5);
    expect(done.counts.failed).toBe(0);

    const world = await listingBySku(shop.id, "PZ-1000-WORLDMAP");
    expect(world.p.name).toBe("Generic 1000 Piece Jigsaw Puzzle - World Map");
    expect(world.p.approvalStatus).toBe("PENDING_APPROVAL");
    expect(world.p.hsnCode).toBe("95032000");
    expect(world.p.gtin).toBe(ean13("890612345001"));
    expect(world.p.mrpPaise).toBeNull(); // the master MRP is never written by a shop's file
    expect(world.d.mrpPaise).toBe(99900); // …the shop's listing carries it
    expect(world.sp.onlinePricePaise).toBe(64900);
    expect(world.sp.onlineSaleEnabled).toBe(true);
    expect(world.sp.onlineStock).toBe(25);
    expect(world.sp.maximumOrderQuantity).toBe(5);
    expect(world.d.giftWrap).toBe(true);
    expect(world.d.itemCondition).toBe("New");
    expect(Object.keys(world.d.attributes)).toEqual(expect.arrayContaining(["Product Identity", "Offer (IN) - Sell on Amazon", "Safety & Compliance", "b2b", "compliance"]));
    const [attrs] = await db.select().from(productAttributes).where(eq(productAttributes.productId, world.p.id));
    expect(attrs.attributes).toHaveProperty("_brand", "Generic");

    const taj = await listingBySku(shop.id, "PZ-3D-TAJ");
    expect(taj.sp.onlineStock).toBe(1200); // "1,200"
    expect(taj.sp.onlinePricePaise).toBe(129900); // "1,299.00"
    expect(taj.d.salePricePaise).toBe(119900);
    expect(taj.d.saleStartsOn).toBe("2026-11-01"); // dd/mm/yyyy
    const [tajCategory] = await db.execute<{ name: string }>(sql`select name from product_categories where id = ${taj.p.categoryId}`);
    expect(tajCategory.name).toBe("3-D Puzzles");

    const floor = await listingBySku(shop.id, "PZ-KIDS-ANIMALS");
    expect(floor.p.gtin).toBeNull(); // GTIN Exempt
    expect(floor.sp.onlineStock).toBe(0);
    const [general] = await db.execute<{ name: string }>(sql`select name from product_categories where id = ${floor.p.categoryId}`);
    expect(general.name).toBe("General");

    const mini = await listingBySku(shop.id, "PZ-MINI-500");
    expect(mini.sp.onlineStock).toBe(0); // "ten" is not a quantity
    const miniRow = rows.find((r) => r.sku === "PZ-MINI-500")!;
    expect(miniRow.messages.join(" ")).toMatch(/not a whole number; stock left unchanged/);

    // Every stock change is in the ledger with the job, the user and source bulk_upload.
    const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.importJobId, jobId));
    expect(movements.length).toBe(3); // 25, 1200 and 7 — the zeros changed nothing
    for (const m of movements) {
      expect(m.source).toBe("bulk_upload");
      expect(m.createdBy).toBe(owner.id);
      expect(m.newUnits - m.previousUnits).toBe(m.deltaUnits);
    }

    // Inventory & Accounting's stock ledger (migration 0076 triggers) records the same changes, labelled by the import.
    const books = await db.execute<{ note: string; qty: string }>(
      sql`select note, qty_milli::text as qty from inv_stock_ledger where inventory_movement_id in (select id from inventory_movements where import_job_id = ${jobId})`,
    );
    expect(books).toHaveLength(3);
    for (const b of books) expect(b.note).toMatch(/^Bulk upload \(set\)$/);

    // The owner is told, in app (event-driven, no cron).
    const told = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(told.some((n) => n.type === "shop.product_import_finished")).toBe(true);
  });

  it("writes the result report: the original rows plus status and messages (CSV and XLSX)", async () => {
    const { owner, shop } = await ownerWithShop();
    const { jobId } = await importFile(shop.id, actorOf(owner), readFileSync(FIXTURE), { name: "PUZZLES.xlsm" });
    const csv = (await buildReport(jobId, "csv", actorOf(owner))).bytes.toString("utf8");
    const [header, first] = csv.replace(/^﻿/, "").split("\r\n");
    expect(header.startsWith("Row,SKU,Product Type,Listing Action")).toBe(true);
    expect(header.endsWith(",status,messages")).toBe(true);
    expect(first).toContain("PZ-1000-WORLDMAP");
    expect(first).toContain(",created,");
    const xlsx = await buildReport(jobId, "xlsx", actorOf(owner));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.bytes as unknown as ExcelJS.Buffer);
    expect(wb.getWorksheet("Result")!.rowCount).toBe(6);
  });
});

describe("matching (§3)", () => {
  it("1. same shop + same SKU updates that listing", async () => {
    const { owner, shop } = await ownerWithShop();
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Selling Price", "Quantity"], [["MILK-1", "Cow Milk 1 L", 70, 10]]));
    const second = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Selling Price", "Quantity"], [["milk-1", 72, 15]]));
    expect(second.rows[0].matchType).toBe("SKU");
    expect(second.rows[0].status).toBe("updated");
    const l = await listingBySku(shop.id, "MILK-1");
    expect(l.sp.onlinePricePaise).toBe(7200);
    expect(l.sp.onlineStock).toBe(15);
    expect(l.p.name).toBe("Cow Milk 1 L"); // blank name cell did not wipe it
  });

  it("2. a barcode in the master catalogue links the shop to that product (no new master row)", async () => {
    const { owner, shop } = await ownerWithShop();
    const category = await createCategory({ name: "Biscuits" });
    const master = await createProduct(category.id, { name: "Parle-G 250 g", unit: "pack" });
    const gtin = ean13("890171902001");
    await db.update(products).set({ gtin }).where(eq(products.id, master.id));
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(products);

    const { rows } = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Barcode", "Quantity"], [["PG-250", gtin, 40]]));
    expect(rows[0].matchType).toBe("BARCODE");
    expect(rows[0].status).toBe("created");
    expect(rows[0].productId).toBe(master.id);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(products);
    expect(after[0].n).toBe(before[0].n);
    const l = await listingBySku(shop.id, "PG-250");
    expect(l.sp.onlineStock).toBe(40);
    // The shop now carries the product's category (so the listing is on sale).
    const carried = await db.execute(sql`select 1 from shop_product_categories where shop_id = ${shop.id} and category_id = ${category.id}`);
    expect(carried.length).toBe(1);
  });

  it("3. name + brand exact match links with a 'matched by name' warning", async () => {
    const { owner, shop } = await ownerWithShop();
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Brand"], [["A-1", "Haldiram Bhujia 400g", "Haldiram"]]));
    const other = await ownerWithShop();
    const { rows } = await importFile(other.shop.id, actorOf(other.owner), await simpleSheet(["Product Name", "Brand", "Quantity"], [["haldiram  bhujia 400G", "HALDIRAM", 3]]));
    expect(rows[0].matchType).toBe("NAME");
    expect(rows[0].messages.join(" ")).toMatch(/Matched by name and brand/);
    const masters = await db.select().from(products).where(sql`lower(${products.name}) like 'haldiram%'`);
    expect(masters).toHaveLength(1);
  });

  it("4. no match creates a Pending master product that the existing duplicate check sees", async () => {
    const { owner, shop } = await ownerWithShop();
    const general = await createCategory({ name: "General" });
    void general;
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Selling Price", "Quantity"], [["NEW-1", "Kesar Pista Kulfi", 40, 6]]));
    const l = await listingBySku(shop.id, "NEW-1");
    expect(l.p.approvalStatus).toBe("PENDING_APPROVAL");
    expect(l.sp.onlineStock).toBe(6);
    // The manual "Create New Product" flow now finds it as an exact match and reuses it.
    const other = await ownerWithShop();
    const created = await createProductForShop(
      { shopId: other.shop.id, categoryId: l.p.categoryId, name: "Kesar Pista Kulfi", unit: "piece" },
      actorOf(other.owner),
      true,
    );
    expect(created.reusedExisting).toBe(true);
    expect(created.product.id).toBe(l.p.id);
  });
});

describe("all fields optional (§ rules)", () => {
  it("a row with only a name, only a barcode, only SKU + Quantity, and an empty row", async () => {
    const { owner, shop } = await ownerWithShop();
    // An existing listing the SKU-only row updates.
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Selling Price", "Quantity"], [["EXIST-1", "Existing Thing", 99, 1]]));
    const bytes = await simpleSheet(
      ["SKU", "Product Name", "Barcode", "Quantity"],
      [
        [null, "Only A Name", null, null],
        [null, null, ean13("890000000001"), null],
        [null, null, null, null],
        ["EXIST-1", null, null, 42],
      ],
    );
    const { preview, rows } = await importFile(shop.id, actorOf(owner), bytes);
    expect(preview.counts.totalRows).toBe(3);
    expect(preview.counts.skipped).toBe(1); // the empty row
    const byName = rows.find((r) => r.rowNumber === 2)!;
    expect(byName.status).toBe("created");
    expect(byName.messages.join(" ")).toMatch(/SKU GK-[0-9A-F]{8}-\d{5} was generated/);
    expect(byName.messages.join(" ")).toMatch(/not orderable until stock is set/);
    const byBarcode = rows.find((r) => r.rowNumber === 3)!;
    expect(byBarcode.status).toBe("created");
    const skuOnly = rows.find((r) => r.rowNumber === 5)!;
    expect(skuOnly.status).toBe("updated");
    const l = await listingBySku(shop.id, "EXIST-1");
    expect(l.sp.onlineStock).toBe(42);
    expect(l.sp.onlinePricePaise).toBe(9900); // untouched
    expect(l.p.name).toBe("Existing Thing");
  });
});

describe("inventory (§3)", () => {
  async function seed(stock: number) {
    const { owner, shop } = await ownerWithShop();
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Selling Price", "Quantity"], [["INV-1", "Inventory Item", 10, stock]]));
    return { owner, shop };
  }

  it("Set mode makes stock equal to the file's Quantity", async () => {
    const { owner, shop } = await seed(10);
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Quantity"], [["INV-1", 3]]), { mode: "SET" });
    expect((await listingBySku(shop.id, "INV-1")).sp.onlineStock).toBe(3);
  });

  it("Add mode adds the file's Quantity to current stock", async () => {
    const { owner, shop } = await seed(10);
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Quantity"], [["INV-1", 5]]), { mode: "ADD" });
    expect((await listingBySku(shop.id, "INV-1")).sp.onlineStock).toBe(15);
  });

  it("a blank quantity leaves an existing listing's stock unchanged; a negative one too, with a warning", async () => {
    const { owner, shop } = await seed(10);
    const { rows } = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Selling Price", "Quantity"], [["INV-1", 11, null]]));
    expect(rows[0].status).toBe("updated");
    expect((await listingBySku(shop.id, "INV-1")).sp.onlineStock).toBe(10);
    const neg = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Quantity"], [["INV-1", -4]]));
    expect(neg.rows[0].messages.join(" ")).toMatch(/negative; stock left unchanged/);
    expect((await listingBySku(shop.id, "INV-1")).sp.onlineStock).toBe(10);
  });

  it("duplicate SKUs in one file merge: Set uses the last row, Add sums them", async () => {
    const { owner, shop } = await seed(10);
    const sheet = await simpleSheet(["SKU", "Selling Price", "Quantity"], [["INV-1", 12, 4], ["INV-1", null, 6]]);
    const set = await importFile(shop.id, actorOf(owner), sheet, { mode: "SET" });
    expect(set.rows.find((r) => r.rowNumber === 2)!.status).toBe("skipped");
    expect(set.rows.find((r) => r.rowNumber === 3)!.messages.join(" ")).toMatch(/merged/);
    let l = await listingBySku(shop.id, "INV-1");
    expect(l.sp.onlineStock).toBe(6);
    expect(l.sp.onlinePricePaise).toBe(1200); // the earlier row's price survives the blank later cell

    await importFile(shop.id, actorOf(owner), sheet, { mode: "ADD", name: "again.xlsx" });
    l = await listingBySku(shop.id, "INV-1");
    expect(l.sp.onlineStock).toBe(16);
  });

  it("an order placed while an Add import runs is never lost", async () => {
    const { owner, shop } = await seed(20);
    const listing = await listingBySku(shop.id, "INV-1");
    const { job } = await createImportJob(shop.id, { name: "add.xlsx", bytes: await simpleSheet(["SKU", "Quantity"], [["INV-1", 5]]) }, actorOf(owner));
    await runParse(job.id);
    await startCommit(job.id, "ADD", actorOf(owner));
    const orders = Array.from({ length: 6 }, () => db.transaction((tx) => consumeOnlineStock(listing.sp.id, 1, "test order", tx)));
    await Promise.all([runCommit(job.id, actorOf(owner), { skipImages: true }), ...orders]);
    const after = await listingBySku(shop.id, "INV-1");
    expect(after.sp.onlineStock).toBe(20 + 5 - 6);
    const ledger = await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopProductId, listing.sp.id));
    const net = ledger.reduce((n, m) => n + m.deltaUnits, 0);
    expect(net).toBe(after.sp.onlineStock); // the ledger adds up to the balance (it started at 0)
  });
});

describe("listing actions (§3)", () => {
  it("Upsert creates then updates; Edit with no match is skipped; Delete soft-deactivates", async () => {
    const { owner, shop } = await ownerWithShop();
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Selling Price", "Quantity", "Action"], [["ACT-1", "Action Item", 25, 9, "Upsert"]]));
    const edit = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Quantity", "Action"], [["NOPE-404", 1, "Edit"], ["ACT-1", 4, "Edit (Partial Update)"]]));
    expect(edit.rows[0].status).toBe("skipped");
    expect(edit.rows[0].messages.join(" ")).toMatch(/no matching product/);
    expect(edit.rows[1].status).toBe("updated");

    const del = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Action"], [["ACT-1", "Delete"]]));
    expect(del.rows[0].status).toBe("deactivated");
    const l = await listingBySku(shop.id, "ACT-1");
    expect(l.sp.isActive).toBe(false);
    expect(l.sp.onlineStock).toBe(0);
    expect(l.sp.deletedAt).toBeNull(); // never hard-deleted
    expect(l.p.deletedAt).toBeNull(); // the master product stays

    // Create or Replace puts it back.
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Quantity"], [["ACT-1", 2]]), { name: "back.xlsx" });
    expect((await listingBySku(shop.id, "ACT-1")).sp.isActive).toBe(true);
  });
});

describe("prices", () => {
  it("an operator's prices are proposed to the owner, not applied", async () => {
    const { owner, shop } = await ownerWithShop();
    await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "Selling Price", "Quantity"], [["OP-1", "Operator Item", 50, 5]]));
    const operator = await createUser({ role: "OPERATOR" });
    const { rows, done } = await importFile(shop.id, actorOf(operator), await simpleSheet(["SKU", "Selling Price", "Quantity"], [["OP-1", 55, 8]]));
    expect(rows[0].messages.join(" ")).toMatch(/sent to the shop owner for approval/);
    expect(done.messages.join(" ")).toMatch(/1 price change/);
    const l = await listingBySku(shop.id, "OP-1");
    expect(l.sp.onlinePricePaise).toBe(5000);
    expect(l.sp.onlineStock).toBe(8);
    const pending = await db.select().from(priceUpdateRequests).where(eq(priceUpdateRequests.shopProductId, l.sp.id));
    expect(pending.map((p) => p.proposedPricePaise)).toEqual([5500, 5500]);
    // The operator is told too (they ran it), as is the owner.
    const toOperator = await db.select().from(notifications).where(eq(notifications.userId, operator.id));
    expect(toOperator.some((n) => n.type === "shop.product_import_finished")).toBe(true);
  });

  it("a price above the MRP in the file is not applied", async () => {
    const { owner, shop } = await ownerWithShop();
    const { rows } = await importFile(shop.id, actorOf(owner), await simpleSheet(["SKU", "Product Name", "MRP", "Selling Price"], [["MRP-1", "Over MRP", 100, 120]]));
    expect(rows[0].messages.join(" ")).toMatch(/above the MRP/);
    expect((await listingBySku(shop.id, "MRP-1")).sp.onlinePricePaise).toBeNull();
  });
});

describe("images (§4)", () => {
  it("downloads each URL once, attaches it to the listing, and an SSRF address is refused as a row warning", async () => {
    const { owner, shop } = await ownerWithShop();
    const bytes = await jpeg();
    const calls: string[] = [];
    const fetcher = async (url: string, options: { maxBytes: number; timeoutMs: number }) => {
      calls.push(url);
      if (url.includes("169.254")) return fetchImage(url, options); // the real guard
      return { bytes, contentType: "image/jpeg" };
    };
    const sheet = await simpleSheet(
      ["SKU", "Product Name", "Main Image URL", "Image URL 2"],
      [
        ["IMG-1", "Image One", "https://cdn.example.com/a.jpg", "http://169.254.169.254/latest/meta-data/x.jpg"],
        ["IMG-2", "Image Two", "https://cdn.example.com/a.jpg", null],
      ],
    );
    const { jobId, rows } = await importFile(shop.id, actorOf(owner), sheet, { fetcher });
    expect(calls.filter((u) => u === "https://cdn.example.com/a.jpg")).toHaveLength(1);
    const view = await getJobView(jobId);
    expect(view.counts.imagesSaved).toBe(2);
    expect(view.counts.imagesFailed).toBe(1);
    const after = (await listJobRows(jobId)).rows;
    expect(after[0].messages.join(" ")).toMatch(/169\.254\.169\.254.*blocked/);
    expect(rows[0].status).toBe("created"); // the product exists despite the failed image
    const l = await listingBySku(shop.id, "IMG-1");
    const photos = await db.select().from(productImages).where(eq(productImages.shopProductId, l.sp.id));
    expect(photos).toHaveLength(1);
  });
});

describe("security and access", () => {
  it("a shop owner cannot import into another shop", async () => {
    const a = await ownerWithShop();
    const b = await ownerWithShop();
    await expect(createImportJob(b.shop.id, { name: "x.csv", bytes: Buffer.from("SKU\nA\n") }, actorOf(a.owner))).rejects.toMatchObject({ status: 403 });
    const { job } = await createImportJob(b.shop.id, { name: "x.csv", bytes: Buffer.from("SKU,Quantity\nA,1\n") }, actorOf(b.owner));
    await expect(cancelJob(job.id, actorOf(a.owner))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an oversized file and a wrong file type", async () => {
    const { owner, shop } = await ownerWithShop();
    await db.execute(sql`INSERT INTO platform_settings (key, value) VALUES ('productImport', '{"maxFileBytes": 100000}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const { clearRuleCache } = await import("@/server/services/settings");
    clearRuleCache();
    await expect(createImportJob(shop.id, { name: "big.csv", bytes: Buffer.alloc(100_001, 65) }, actorOf(owner))).rejects.toMatchObject({ status: 422 });
    await expect(createImportJob(shop.id, { name: "notes.pdf", bytes: Buffer.from("%PDF-1.7") }, actorOf(owner))).rejects.toMatchObject({ status: 422 });
    // A .xlsx name on bytes that are not a spreadsheet fails at the preview with a readable reason.
    const { job } = await createImportJob(shop.id, { name: "fake.xlsx", bytes: Buffer.from("not a zip") }, actorOf(owner));
    await runParse(job.id);
    const view = await getJobView(job.id);
    expect(view.status).toBe("failed");
    expect(view.errorMessage).toMatch(/Excel file \(\.xlsx or \.xlsm\) or a CSV/);
  });

  it("an .xlsm with a VBA project is read as data only", async () => {
    const { owner, shop } = await ownerWithShop();
    const bytes = await buildAmazonWorkbook([amazonRow({ SKU: "VBA-1", "Item Name": "Macro Test", "Quantity (IN)": 2 })], { macros: true });
    const { preview, done } = await importFile(shop.id, actorOf(owner), bytes, { name: "macro.xlsm" });
    expect(preview.messages.join(" ")).toMatch(/macros\. They were not run/);
    expect(done.counts.created).toBe(1);
  });
});

describe("history, duplicates, cancel, retention", () => {
  it("flags an identical file that was already imported, keeps history, and purges after the retention period", async () => {
    const { owner, shop } = await ownerWithShop();
    const sheet = await simpleSheet(["SKU", "Product Name", "Quantity"], [["H-1", "History Item", 1]]);
    const first = await importFile(shop.id, actorOf(owner), sheet);
    const again = await createImportJob(shop.id, { name: "upload.xlsx", bytes: sheet }, actorOf(owner));
    expect(again.duplicateOf?.jobId).toBe(first.jobId);
    await runParse(again.job.id);
    expect((await cancelJob(again.job.id, actorOf(owner))).status).toBe("cancelled");

    await db.update(productImportJobs).set({ createdAt: new Date(Date.now() - 91 * 86_400_000) }).where(eq(productImportJobs.id, first.jobId));
    expect((await purgeOldProductImports()).jobs).toBe(1);
    const [purged] = await db.select().from(productImportJobs).where(eq(productImportJobs.id, first.jobId));
    expect(purged.fileData).toBeNull();
    expect(purged.purgedAt).not.toBeNull();
    expect(await db.select().from(productImportRows).where(eq(productImportRows.jobId, first.jobId))).toHaveLength(0);
  });
});

describe("API v1 routes", () => {
  function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
    state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
  }

  it("upload → poll → rows → commit → report, as the website and the apps call them", async () => {
    const { owner, shop } = await ownerWithShop();
    signIn(owner);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(readFileSync(FIXTURE))], "PUZZLES.xlsm"));
    const upload = await uploadRoute(new NextRequest(`http://localhost/api/v1/shops/${shop.id}/product-imports`, { method: "POST", body: form }), {
      params: Promise.resolve({ shopId: shop.id }),
    });
    expect(upload.status).toBe(202);
    const { jobId } = (await upload.json()) as { jobId: string };
    await Promise.all(state.deferred);

    const job = await call(jobRoute, `/api/v1/product-imports/${jobId}`, { params: { jobId } });
    expect(job.body.status).toBe("preview_ready");
    const rows = await call(rowsRoute, `/api/v1/product-imports/${jobId}/rows?status=warnings&page=1`, { params: { jobId } });
    expect(rows.status).toBe(200);
    expect(rows.body.total).toBeGreaterThan(0);

    const commit = await call(commitRoute, `/api/v1/product-imports/${jobId}/commit`, { method: "POST", body: { inventoryMode: "SET" }, params: { jobId } });
    expect(commit.status).toBe(202);
    await Promise.all(state.deferred);
    const finished = await call(jobRoute, `/api/v1/product-imports/${jobId}`, { params: { jobId } });
    expect(finished.body.status).toBe("completed");

    const report = await reportRoute(new NextRequest(`http://localhost/api/v1/product-imports/${jobId}/report?format=csv`), { params: Promise.resolve({ jobId }) });
    expect(report.status).toBe(200);
    expect(report.headers.get("content-disposition")).toMatch(/PUZZLES_result\.csv/);

    const history = await call(historyRoute, `/api/v1/shops/${shop.id}/product-imports`, { params: { shopId: shop.id } });
    expect(history.body.imports).toHaveLength(1);

    const template = await templateRoute();
    expect(template.headers.get("content-disposition")).toMatch(/GoKesari_Product_Upload_Template\.xlsx/);
  });

  it("refuses a signed-out caller and another shop's owner", async () => {
    const a = await ownerWithShop();
    const b = await ownerWithShop();
    expect((await call(historyRoute, `/api/v1/shops/${b.shop.id}/product-imports`, { params: { shopId: b.shop.id } })).status).toBe(401);
    signIn(a.owner);
    expect((await call(historyRoute, `/api/v1/shops/${b.shop.id}/product-imports`, { params: { shopId: b.shop.id } })).status).toBe(403);
  });
});

describe("regression: existing product flows are unchanged", () => {
  it("manual create-product and add-category still behave as before", async () => {
    const { owner, shop } = await ownerWithShop();
    const category = await createCategory({ name: "Snacks" });
    const made = await createProductForShop(
      { shopId: shop.id, categoryId: category.id, name: "Masala Peanuts", unit: "pack", onlinePricePaise: 3000, onlineSaleEnabled: true },
      actorOf(owner),
      true,
    );
    expect(made.reusedExisting).toBe(false);
    expect(made.product.approvalStatus).toBe("PENDING_APPROVAL");
    expect(made.shopProduct.onlinePricePaise).toBe(3000);

    const other = await createCategory({ name: "Namkeen" });
    const p = await createProduct(other.id, { name: "Aloo Bhujia" });
    void p;
    const added = await addCategoryToShop(shop.id, other.id, actorOf(owner));
    expect(added.added).toBe(true);
    expect(added.addedProducts).toBe(1);
    const sp = await db.select().from(shopProducts).where(eq(shopProducts.shopId, shop.id));
    expect(sp).toHaveLength(2);
    void createShopProduct;
    void linkShopCategory;
  });
});
