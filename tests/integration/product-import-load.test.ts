/**
 * Bulk product upload load test (docs/product-import-2026-10 §8): 5,000 rows
 * — the default row limit — parsed, previewed and imported. The API answers
 * the upload and the commit with 202 at once and does this work after the
 * response, so the screen never waits on it; this measures how long the
 * background work takes. Timings are printed for the test report.
 */
import ExcelJS from "exceljs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The service reaches the auth module through the photo code; no request is made here.
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { db } from "@/server/db";
import { inventoryMovements } from "@/server/db/schema";
import { createImportJob, getJobView, runCommit, runParse, startCommit } from "@/server/services/product-import";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const ROWS = 5_000;

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`TRUNCATE product_import_jobs, shop_listing_details, product_attributes CASCADE`);
});

describe("load", () => {
  it(`imports ${ROWS} rows within the time budget`, { timeout: 15 * 60_000 }, async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");
    ws.addRow(["SKU", "Product Name", "Brand", "MRP", "Selling Price", "Quantity", "Category"]);
    for (let i = 1; i <= ROWS; i += 1) ws.addRow([`LOAD-${i}`, `Load Test Product ${i}`, "LoadBrand", 120, 99, i % 50, "Snacks"]);
    const bytes = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const actor = { id: owner.id, role: owner.role };

    const t0 = Date.now();
    const { job } = await createImportJob(shop.id, { name: "load.xlsx", bytes }, actor);
    const tUpload = Date.now() - t0;
    await runParse(job.id);
    const tParse = Date.now() - t0 - tUpload;
    const preview = await getJobView(job.id);
    expect(preview.counts.totalRows).toBe(ROWS);
    await startCommit(job.id, "SET", actor);
    const t1 = Date.now();
    const done = await runCommit(job.id, actor, { skipImages: true });
    const tCommit = Date.now() - t1;

    console.info(
      `[load] ${ROWS} rows, ${(bytes.length / 1024).toFixed(0)} KB: upload ${tUpload} ms, parse+preview ${tParse} ms, import ${tCommit} ms (${((tCommit / ROWS) * 1000).toFixed(0)} µs/row)`,
    );
    expect(done.status).toBe("completed");
    expect(done.counts.created).toBe(ROWS);
    expect(done.counts.failed).toBe(0);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(inventoryMovements).where(eq(inventoryMovements.importJobId, job.id));
    expect(n).toBe(ROWS - ROWS / 50); // every row with a non-zero quantity
    // Budget on a local database; the screen polls, so it is not a request timeout.
    expect(tParse).toBeLessThan(60_000);
    expect(tCommit).toBeLessThan(10 * 60_000);
  });
});
