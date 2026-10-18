/**
 * batch-2026-10 WS-D — F9.1.2 product data sources (manufacturer portal + API key, GS1 DataKart mock,
 * Open Food Facts) and F9.1.4 large-scale ingestion, product browser, promote; F9.2.6 inventory-sync flag.
 */
import { NextRequest } from "next/server";
import sharp from "sharp";
import { and, eq, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as apiProductsPost } from "@/app/api/pmd/v1/manufacturer/products/route";
import { GET as errorsGet } from "@/app/api/pmd/jobs/[id]/errors/route";
import { POST as lookupPost } from "@/app/api/pmd/sources/lookup/route";
import { POST as bulkEditPost } from "@/app/api/pmd/browser/bulk-edit/route";
import { POST as integrationCron } from "@/app/api/cron/integration-sync/route";
import { POST as manufacturersPost } from "@/app/api/pmd/manufacturers/route";
import { AppError } from "@/lib/errors";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, pmdImageAssets, pmdIngestJobRows, pmdIngestJobs, pmdObjectBlobs, pmdRecordAttributions, products } from "@/server/db/schema";
import { assertInventorySyncEnabled } from "@/server/integrations/inventory-sync-flag";
import { bulkEdit, mergeDuplicate, promoteMany, searchBrowser } from "@/server/pmd/browser";
import { DataKartApiClient, GS1_MOCK_RECORDS, gs1DataSource } from "@/server/pmd/data-sources/gs1-datakart";
import { templateCsv, templateXlsx } from "@/server/pmd/data-sources/manufacturer";
import { offLookupSource } from "@/server/pmd/data-sources/open-food-facts";
import { createIngestJob, createManufacturerJob, errorFileCsv, getJob, parseUploadedFile, processIngestJob, validateRows } from "@/server/pmd/ingest-jobs";
import { addManufacturerMember, createManufacturerAccount, issueApiKey, revokeApiKey } from "@/server/pmd/manufacturers";
import { manufacturerDataSource } from "@/server/pmd/data-sources/manufacturer";
import { PlatformObjectStore } from "@/server/pmd/object-store";
import { lookupAndStage } from "@/server/pmd/source-lookups";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createCategory, createUser, resetDatabase } from "../helpers/fixtures";
import { count, gtin13, pmdSql, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const actorOf = (u: { id: string; role: UserRole; email?: string }) => ({ id: u.id, role: u.role, email: u.email ?? null });

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function admin() {
  const u = await createUser({ role: "ADMIN", email: `pmd-admin-${Math.random().toString(36).slice(2)}@test.local` });
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN" as const };
}

const G = (n: number) => gtin13(`8907${String(n).padStart(8, "0")}`);

function csv(rows: Record<string, string>[]): Buffer {
  const headings = Object.keys(rows[0]);
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Buffer.from([headings.join(","), ...rows.map((r) => headings.map((h) => q(r[h] ?? "")).join(","))].join("\n"), "utf8");
}

const row = (n: number, over: Record<string, string> = {}) => ({
  GTIN: G(n),
  "Product Name": `Toned Milk Pouch ${n} 500 ml`,
  Brand: "Gokul",
  Category: "dairy/milk",
  "Pack Size": "500 ml",
  MRP: "28.00",
  "GST %": "0",
  HSN: "04012000",
  "Image URLs": "",
  ...over,
});

async function apiCall(handler: (r: NextRequest) => Promise<Response>, path: string, init: { method?: string; key?: string | null; body?: unknown; contentType?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers["content-type"] = init.contentType ?? "application/json";
  const req = new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const res = await handler(req);
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  process.env.PMD_INGEST_AUTORUN = "off";
  await seedReference(sql);
});

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await resetPmd(sql);
  await db.execute(dsql`TRUNCATE TABLE pmd_ingest_job_rows, pmd_ingest_jobs, pmd_image_assets, pmd_record_attributions, pmd_object_blobs, pmd_manufacturer_api_keys, pmd_manufacturer_members, pmd_manufacturer_accounts CASCADE`);
  await db.execute(dsql`DELETE FROM platform_settings WHERE key IN ('pmdSources', 'objectStore', 'inventorySync')`);
  clearRuleCache();
});

afterAll(() => {
  delete process.env.PMD_INGEST_AUTORUN;
});

async function manufacturer(name = "Gokul Dairy") {
  const a = await admin();
  const account = await createManufacturerAccount({ name, brandNames: ["Gokul"] }, a);
  return { admin: a, account };
}

describe("manufacturer self-upload (F9.1.2)", () => {
  it("TC-B26-D-015 the API refuses a missing, malformed, unknown or revoked key with 401", async () => {
    const { admin: a, account } = await manufacturer();
    const body = { products: [{ gtin: G(1), name: "Milk 500 ml", brand: "Gokul" }] };
    expect((await apiCall(apiProductsPost, "/api/pmd/v1/manufacturer/products", { body })).status).toBe(401);
    expect((await apiCall(apiProductsPost, "/api/pmd/v1/manufacturer/products", { body, key: "not-a-key" })).status).toBe(401);
    expect((await apiCall(apiProductsPost, "/api/pmd/v1/manufacturer/products", { body, key: "gkm_" + "x".repeat(32) })).status).toBe(401);
    const issued = await issueApiKey(account.id, { label: "ERP" }, a);
    await revokeApiKey(account.id, issued.id, a);
    expect((await apiCall(apiProductsPost, "/api/pmd/v1/manufacturer/products", { body, key: issued.key })).status).toBe(401);
    const refused = await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_ACTIONS.PMD_API_KEY_USED));
    expect(refused.some((r) => (r.newValue as { refused?: string }).refused === "revoked")).toBe(true);
  });

  it("TC-B26-D-016 a valid key stages the rows as a job; only the key's hash is stored; use is audited", async () => {
    const { admin: a, account } = await manufacturer();
    const issued = await issueApiKey(account.id, {}, a);
    const keys = await db.execute(dsql`SELECT key_hash FROM pmd_manufacturer_api_keys`);
    expect(JSON.stringify(keys)).not.toContain(issued.key);
    const res = await apiCall(apiProductsPost, "/api/pmd/v1/manufacturer/products", {
      key: issued.key,
      body: { products: [{ gtin: G(1), name: "Toned Milk 500 ml", brand: "Gokul", mrp: "28" }, { gtin: "8901234567891", name: "Bad check digit", brand: "Gokul" }] },
    });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ totalRows: 2, validRows: 1, invalidRows: 1, status: "QUEUED", kind: "MANUFACTURER_API" });
    const p = await processIngestJob(res.body.job.id);
    expect(p.status).toBe("PARTIAL");
    expect(await count(sql, "pmd.product_master")).toBe(1);
    const [src] = await sql<{ source_key: string; source_kind: string }[]>`SELECT s.source_key, s.source_kind FROM pmd.product_source ps JOIN pmd.source s USING (source_id)`;
    expect(src).toEqual({ source_key: account.sourceKey, source_kind: "BRAND_MANUFACTURER" });
    expect(await db.$count(auditLogs, eq(auditLogs.action, AUDIT_ACTIONS.PMD_API_KEY_USED))).toBe(1);
  });

  it("TC-B26-D-017 template upload: every row validated, file duplicates flagged, staged and de-duplicated by GTIN across files", async () => {
    const { account } = await manufacturer();
    const file = csv([row(1), row(2), row(3, { GTIN: "8901234567891" }), row(4, { GTIN: G(1) }), row(5, { "Product Name": "" }), row(6, { MRP: "free" }), row(7, { HSN: "12" })]);
    const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "catalogue.csv", file, autoStart: false }, { id: null, role: null });
    expect(job).toMatchObject({ totalRows: 7, validRows: 2, invalidRows: 5 });
    expect(job.report.validation).toMatchObject({ duplicates: 1, byCode: { GTIN_CHECK_DIGIT: 1, DUPLICATE_GTIN_IN_FILE: 1, NAME_MISSING: 1, MRP_INVALID: 1, HSN_INVALID: 1 } });
    await processIngestJob(job.id);
    expect(await count(sql, "pmd.product_master")).toBe(2);
    expect(await count(sql, "pmd.raw_record")).toBe(2);
    // The same GTINs again (a second upload) attach to the same masters — no duplicates.
    const again = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "again.csv", file: csv([row(1, { MRP: "30.00" }), row(2)]), autoStart: false }, { id: null, role: null });
    await processIngestJob(again.job.id);
    expect(await count(sql, "pmd.product_master")).toBe(2);
    expect(await count(sql, "pmd.product_identifier", "id_type = 'GTIN'")).toBe(2);
  });

  it("TC-B26-D-018 the Excel template downloads and reads back; a file without the required columns is refused", async () => {
    const xlsx = await templateXlsx();
    const parsed = await parseUploadedFile(xlsx, "template.xlsx");
    expect(parsed.headings).toContain("GTIN");
    expect(parsed.rows).toHaveLength(1);
    const outcome = validateRows(parsed.rows)[0].outcome;
    expect(outcome.ok).toBe(true);
    expect(templateCsv().toString("utf8")).toContain("GTIN,Item Code,Product Name");
    const { account } = await manufacturer();
    await expect(
      createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "x.csv", file: Buffer.from("Name,Price\nMilk,10\n"), autoStart: false }, { id: null, role: null }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("TC-B26-D-019 the portal switch off refuses uploads; manufacturer accounts are admin-only", async () => {
    const { admin: a, account } = await manufacturer();
    await setRule("pmdSources", { manufacturerPortalEnabled: false }, a);
    await expect(
      createIngestJob({ kind: "MANUFACTURER_UPLOAD", source: manufacturerDataSource(account), manufacturerAccountId: account.id, fileName: "x", rows: validateRows([{ rowNumber: 1, cells: row(1) }]) }, { id: null, role: null }),
    ).rejects.toThrow(/switched off/);
    const op = await createUser({ role: "OPERATOR" });
    signIn({ id: op.id, email: op.email, name: op.name, role: "OPERATOR" });
    expect((await call(manufacturersPost, "/api/pmd/manufacturers", { method: "POST", body: { name: "Acme" } })).status).toBe(403);
    // A member can be linked by an admin.
    const member = await createUser({ email: "brand-user@example.com" });
    await addManufacturerMember(account.id, { email: "brand-user@example.com" }, a);
    const rows = await db.execute(dsql`SELECT user_id FROM pmd_manufacturer_members`);
    expect(JSON.stringify(rows)).toContain(member.id);
  });
});

describe("GS1 DataKart and Open Food Facts (F9.1.2)", () => {
  it("TC-B26-D-020 GS1 look-ups are refused while the flag is off; on, the mock stages realistic records under its own mock source", async () => {
    const a = await admin();
    signIn(a);
    const off = await call(lookupPost, "/api/pmd/sources/lookup", { method: "POST", body: { source: "GS1", gtins: [GS1_MOCK_RECORDS[0].gtin] } });
    expect(off.status).toBe(409);
    await setRule("pmdSources", { gs1Enabled: true }, a);
    const on = await call(lookupPost, "/api/pmd/sources/lookup", { method: "POST", body: { source: "GS1", gtins: [GS1_MOCK_RECORDS[0].gtin, G(99)] } });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ mode: "MOCK", found: 1 });
    expect(on.body.notFound).toHaveLength(1);
    const [p] = await sql<{ product_name: string; hsn_code: string; source_key: string }[]>`
      SELECT m.product_name, m.hsn_code, s.source_key FROM pmd.product_master m JOIN pmd.product_source ps ON ps.product_id = m.product_id JOIN pmd.source s ON s.source_id = ps.source_id`;
    expect(p.source_key).toBe("gs1_datakart_mock");
    expect(p.hsn_code).toBe("04051000");
  });

  it("TC-B26-D-021 the real DataKart client is a scaffold: unconfigured without keys, never mocked in production", async () => {
    expect(new DataKartApiClient(undefined, undefined).isConfigured()).toBe(false);
    const prod = gs1DataSource({ real: new DataKartApiClient(undefined, undefined), production: true });
    expect(prod.mode()).toBe("UNAVAILABLE");
    const a = await admin();
    await setRule("pmdSources", { gs1Enabled: true }, a);
    expect(await prod.isEnabled()).toBe(false);
    const fetchStub = vi.fn(async () => Response.json({ ...GS1_MOCK_RECORDS[1] }));
    const real = new DataKartApiClient("https://datakart.example.test/api", "k", fetchStub as unknown as typeof fetch);
    const src = gs1DataSource({ real, production: true });
    expect(src.mode()).toBe("REAL");
    const r = await src.lookup([GS1_MOCK_RECORDS[1].gtin]);
    expect(r.found[0]).toMatchObject({ brand: "Tata Salt", quantityText: "1 kg" });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it("TC-B26-D-022 Open Food Facts is refused while its flag is off (no request leaves); on, records are staged with ODbL attribution", async () => {
    const a = await admin();
    const fetchStub = vi.fn(async () =>
      Response.json({
        status: 1,
        product: { code: "8901262150101", product_name: "Amul Masti Dahi", brands: "Amul", quantity: "400 g", categories_tags: ["en:yogurts"], creator: "someone-private", image_url: "https://images.openfoodfacts.org/dahi.jpg" },
      }),
    );
    const source = offLookupSource({ fetch: fetchStub as unknown as typeof fetch });
    await expect(lookupAndStage({ source: "OFF", gtins: ["8901262150101"] }, actorOf(a), { source })).rejects.toBeInstanceOf(AppError);
    expect(fetchStub).not.toHaveBeenCalled();
    await setRule("pmdSources", { openFoodFactsEnabled: true, imagesEnabled: false }, a);
    const r = await lookupAndStage({ source: "OFF", gtins: ["8901262150101"] }, actorOf(a), { source });
    expect(r.found).toBe(1);
    const [raw] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM pmd.raw_record`;
    expect(raw.payload).not.toHaveProperty("creator");
    const [attr] = await db.select().from(pmdRecordAttributions);
    expect(attr.attribution).toMatch(/Open Food Facts.*ODbL/);
    expect(attr.licenceUrl).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
    const browse = await searchBrowser({ q: "Masti" }, sql);
    expect(browse.rows[0].attributions[0]).toMatch(/ODbL/);
  });

  it("TC-B26-D-039 a slow look-up import does not hold the request: the reply carries the running job, which then finishes in the background (S-035)", async () => {
    const a = await admin();
    await setRule("pmdSources", { openFoodFactsEnabled: true, imagesEnabled: true, imagesPerRow: 1 }, a);
    const fetchStub = vi.fn(async () =>
      Response.json({ status: 1, product: { code: "8901262150101", product_name: "Amul Masti Dahi", brands: "Amul", quantity: "400 g", image_url: "https://images.openfoodfacts.org/dahi.jpg" } }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowImage = vi.fn(async () => {
      await gate;
      throw new Error("image host did not answer");
    });
    const started = Date.now();
    const r = await lookupAndStage({ source: "OFF", gtins: ["8901262150101"] }, actorOf(a), {
      source: offLookupSource({ fetch: fetchStub as unknown as typeof fetch }),
      process: { fetcher: slowImage },
      waitMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.found).toBe(1);
    expect(r.job?.status).toBe("RUNNING");
    await vi.waitFor(() => expect(slowImage).toHaveBeenCalled());
    release();
    await vi.waitFor(async () => expect((await getJob(r.job!.id)).status).toBe("SUCCEEDED"), { timeout: 10_000, interval: 50 });
    expect((await getJob(r.job!.id)).imagesFailed).toBe(1);
  });
});

describe("large-scale ingestion (F9.1.4)", () => {
  it("TC-B26-D-023 a job interrupted mid-way resumes from its last committed batch, with nothing loaded twice", async () => {
    const { admin: a, account } = await manufacturer();
    await setRule("pmdSources", { ingestBatchSize: 40 }, a);
    const rows = Array.from({ length: 200 }, (_, i) => ({ rowNumber: i + 2, cells: row(i + 1) }));
    const job = await createIngestJob({ kind: "MANUFACTURER_UPLOAD", source: manufacturerDataSource(account), manufacturerAccountId: account.id, fileName: "big.csv", rows: validateRows(rows), autoStart: false }, actorOf(a));
    await expect(
      processIngestJob(job.id, {
        maxBatches: 100,
        beforeCheckpoint: (batch) => {
          if (batch === 2) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    const crashed = await getJob(job.id);
    expect(crashed).toMatchObject({ cursor: 81, batchesDone: 2, stagedRows: 80, status: "RUNNING" });
    expect(crashed.lastError).toBe("simulated crash");
    const done = await processIngestJob(job.id, { maxBatches: 100 });
    expect(done).toMatchObject({ status: "SUCCEEDED", stagedRows: 200, batchesDone: 5, percent: 100 });
    expect(await count(sql, "pmd.product_master")).toBe(200);
    // The interrupted batch ran twice; the second time its records were unchanged.
    const runs = await sql<{ records_unchanged: number }[]>`SELECT records_unchanged FROM pmd.ingestion_run ORDER BY run_id`;
    expect(runs).toHaveLength(6);
    expect(runs[3].records_unchanged).toBe(40);
  });

  it("TC-B26-D-024 the error file lists every refused row with its reason, neutralising spreadsheet formulas", async () => {
    const { account } = await manufacturer();
    const file = csv([row(1), row(2, { GTIN: "123" }), row(3, { "Product Name": "=HYPERLINK(\"http://x\")", GTIN: "8901234567891" }), row(4, { GTIN: G(1) })]);
    const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "e.csv", file, autoStart: false }, { id: null, role: null });
    const text = await errorFileCsv(job.id);
    const lines = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Row,Status,Error code,Reason,GTIN,Product Name,Brand,Category,Pack Size,MRP,GST %,HSN,Image URLs");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^3,INVALID,GTIN_INVALID,/);
    expect(lines[2]).toMatch(/^4,INVALID,GTIN_CHECK_DIGIT,/);
    expect(lines[2]).toContain("'=HYPERLINK");
    expect(lines[3]).toMatch(/^5,DUPLICATE,DUPLICATE_GTIN_IN_FILE,Same GTIN as row 2/);
    const a = await admin();
    signIn(a);
    const res = await call(errorsGet, `/api/pmd/jobs/${job.id}/errors`, { params: { id: job.id } });
    expect(res.status).toBe(200);
  });

  it("TC-B26-D-025 images are fetched (stubbed), resized and kept in the object store", async () => {
    const { account } = await manufacturer();
    const png = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("broken")) throw new Error("the server answered 404");
      return { bytes: png, contentType: "image/png" };
    });
    const file = csv([row(1, { "Image URLs": "https://cdn.example.com/a.png|https://cdn.example.com/broken.png" })]);
    const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "img.csv", file, autoStart: false }, { id: null, role: null });
    const done = await processIngestJob(job.id, { fetcher: fetcher as never, store: new PlatformObjectStore() });
    expect(done).toMatchObject({ imagesStored: 1, imagesFailed: 1 });
    const [stored] = await db.select().from(pmdImageAssets).where(eq(pmdImageAssets.status, "STORED"));
    expect(Math.max(stored.width!, stored.height!)).toBe(800);
    const [blob] = await db.select().from(pmdObjectBlobs).where(eq(pmdObjectBlobs.key, stored.objectKey!));
    expect(blob.contentType).toBe("image/webp");
    const meta = await sharp(blob.data!).metadata();
    expect(meta.format).toBe("webp");
    // A private address is refused before anything is fetched.
    const bad = validateRows([{ rowNumber: 2, cells: row(2, { "Image URLs": "http://127.0.0.1/admin.png" }) }]);
    expect(bad[0].outcome.errorCode).toBe("IMAGE_URL_INVALID");
  });

  it("TC-B26-D-026 a 100,000-row file is parsed, validated and staged into a resumable job within 60 s", async () => {
    const { account } = await manufacturer();
    const started = Date.now();
    const header = "GTIN,Product Name,Brand,Category,Pack Size,MRP,GST %,HSN";
    const lines = [header];
    for (let i = 1; i <= 100_000; i++) lines.push(`${G(i)},Product ${i} 500 g,Gokul,dairy/milk,500 g,${(i % 500) + 10}.00,5,04012000`);
    lines.push(`${G(1)},Duplicate,Gokul,dairy/milk,500 g,10.00,5,04012000`);
    const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "100k.csv", file: Buffer.from(lines.join("\n")), autoStart: false }, { id: null, role: null });
    const elapsed = Date.now() - started;
    expect(job).toMatchObject({ totalRows: 100_001, validRows: 100_000, invalidRows: 1, status: "QUEUED", cursor: 0 });
    expect(await db.$count(pmdIngestJobRows, eq(pmdIngestJobRows.jobId, job.id))).toBe(100_001);
    expect(elapsed).toBeLessThan(60_000);
    // The same code path loads the first batch and checkpoints it.
    const p = await processIngestJob(job.id, { maxBatches: 1 });
    expect(p).toMatchObject({ batchesDone: 1, stagedRows: 1000, cursor: 1001 });
    console.info(`[TC-B26-D-026] 100,001 rows parsed + validated + staged in ${elapsed} ms`);
  }, 120_000);
});

describe("product browser, bulk edit, merge, promote (F9.1.4)", () => {
  async function stageThree() {
    const { admin: a, account } = await manufacturer();
    await createCategory({ department: "DAIRY", name: "Milk" });
    const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "3.csv", file: csv([row(1), row(2), row(3)]), autoStart: false }, { id: null, role: null });
    await processIngestJob(job.id);
    const ids = (await sql<{ master_product_id: string }[]>`SELECT master_product_id FROM pmd.product_master ORDER BY product_id`).map((r) => r.master_product_id);
    return { a, ids };
  }

  it("TC-B26-D-027 promote one, then the rest in bulk: they become catalogue products for every shop; staging/master filters follow", async () => {
    const { a, ids } = await stageThree();
    const one = await promoteMany([ids[0]], actorOf(a));
    expect(one).toMatchObject({ promoted: 1, refused: 0 });
    const bulk = await promoteMany(ids, actorOf(a));
    expect(bulk).toMatchObject({ promoted: 2, refused: 1 });
    expect(bulk.outcomes.find((o) => !o.ok)?.code).toBe("ALREADY_PROMOTED");
    const catalogue = await db.select().from(products);
    expect(catalogue).toHaveLength(3);
    expect(catalogue.every((p) => p.approvalStatus === "APPROVED" && p.mrpPaise === 2800)).toBe(true);
    expect((await searchBrowser({ scope: "master" }, sql)).total).toBe(3);
    expect((await searchBrowser({ scope: "staging" }, sql)).total).toBe(0);
    expect(await db.$count(auditLogs, eq(auditLogs.action, AUDIT_ACTIONS.PMD_PRODUCTS_PROMOTED))).toBe(2);
  });

  it("TC-B26-D-028 bulk edit changes the selected rows and audits each; MRP applies only to catalogue products", async () => {
    const { a, ids } = await stageThree();
    await promoteMany([ids[0]], actorOf(a));
    const r = await bulkEdit({ masterProductIds: ids, set: { hsnCode: "04011000", gstRateBp: 500, mrpPaise: 3100 }, reason: "GST notification" }, actorOf(a), sql);
    expect(r).toMatchObject({ updated: 3, mrpUpdated: 1 });
    expect(r.skipped.map((s) => s.masterProductId)).toEqual([ids[1], ids[2]]);
    const rows = await sql<{ hsn_code: string; gst_rate_bp: number }[]>`SELECT hsn_code, gst_rate_bp FROM pmd.product_master`;
    expect(rows.every((x) => x.hsn_code === "04011000" && x.gst_rate_bp === 500)).toBe(true);
    const [cat] = await db.select().from(products);
    expect(cat).toMatchObject({ mrpPaise: 3100, hsnCode: "04011000", gstRateBp: 500 });
    expect(await db.$count(auditLogs, eq(auditLogs.action, AUDIT_ACTIONS.PMD_BULK_EDITED))).toBe(3);
    expect(await count(sql, "pmd.product_change_log", "changed_by LIKE 'bulk-edit:%'")).toBe(6);
  });

  it("TC-B26-D-029 bulk edit and merge need their permissions; a merge retires the duplicate by pointer and is audited", async () => {
    const { a, ids } = await stageThree();
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    signIn({ id: shopOwner.id, email: shopOwner.email, name: shopOwner.name, role: "SHOP_OWNER" });
    const denied = await call(bulkEditPost, "/api/pmd/browser/bulk-edit", { method: "POST", body: { masterProductIds: [ids[0]], set: { hsnCode: "0401" } } });
    expect(denied.status).toBe(403);
    const op = await createUser({ role: "OPERATOR" });
    signIn({ id: op.id, email: op.email, name: op.name, role: "OPERATOR" });
    const ok = await call(bulkEditPost, "/api/pmd/browser/bulk-edit", { method: "POST", body: { masterProductIds: [ids[0]], set: { brandName: "Gokul Gold" } } });
    expect(ok.status).toBe(200);
    const merged = await mergeDuplicate({ fromMasterId: ids[2], intoMasterId: ids[1], reason: "same pouch" }, actorOf(a), sql);
    expect(merged.sourcesMoved).toBe(1);
    const [gone] = await sql<{ record_status: string }[]>`SELECT record_status FROM pmd.product_master WHERE master_product_id = ${ids[2]}`;
    expect(gone.record_status).toBe("MERGED");
    expect(await count(sql, "pmd.product_merge_log")).toBe(1);
    expect(await db.$count(auditLogs, and(eq(auditLogs.action, AUDIT_ACTIONS.PMD_PRODUCTS_MERGED), eq(auditLogs.actorId, a.id)))).toBe(1);
  });
});

describe("inventory sync descoped (F9.2.6)", () => {
  it("TC-B26-D-030 with inventorySync.enabled off (the default) the sync sweep does not run and the connector is refused", async () => {
    const req = () => new NextRequest("http://localhost/api/cron/integration-sync", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    const off = await integrationCron(req());
    expect(await off.json()).toEqual({ skipped: true, reason: "INVENTORY_SYNC_DISABLED" });
    await expect(assertInventorySyncEnabled()).rejects.toMatchObject({ code: "CONFLICT" });
    const a = await admin();
    await setRule("inventorySync", { enabled: true }, a);
    const on = await integrationCron(req());
    const body = await on.json();
    expect(body.skipped).toBeUndefined();
    expect(body).toHaveProperty("dispatched");
    await expect(assertInventorySyncEnabled()).resolves.toBeUndefined();
  });
});

describe("audit of ingestion", () => {
  it("TC-B26-D-031 creating and finishing an import is audited and the uploader is told", async () => {
    const { account } = await manufacturer();
    const uploader = await createUser({ email: "uploader@example.com" });
    const { job } = await createManufacturerJob({ accountId: account.id, via: "PORTAL", fileName: "n.csv", file: csv([row(1)]), autoStart: false }, { id: uploader.id, role: "CUSTOMER" });
    await processIngestJob(job.id);
    expect(await db.$count(auditLogs, eq(auditLogs.action, AUDIT_ACTIONS.PMD_INGEST_JOB_CREATED))).toBe(1);
    expect(await db.$count(auditLogs, eq(auditLogs.action, AUDIT_ACTIONS.PMD_INGEST_JOB_FINISHED))).toBe(1);
    const notes = await db.execute(dsql`SELECT type, action_url FROM notifications WHERE user_id = ${uploader.id}`);
    expect(JSON.stringify(notes)).toContain(`/manufacturer/jobs/${job.id}`);
    const [after] = await db.select().from(pmdIngestJobs).where(eq(pmdIngestJobs.id, job.id));
    expect(after.status).toBe("SUCCEEDED");
  });
});
