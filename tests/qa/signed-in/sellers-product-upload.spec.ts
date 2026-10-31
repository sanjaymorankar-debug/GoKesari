/**
 * Bulk product upload, Phase 1 additions (docs/audit/order-payment-gst-audit.md,
 * Area 5) as shop A's owner meets them: the CSV template, the GST % and Goods
 * Type drop-downs, "download my catalogue", the preview checks and the
 * "only rows to fix" report. Signed-in tier: the test site and the local server.
 *
 * The one write is a preview upload, which changes nothing in the shop; it is
 * cancelled at the end. The invoice, delivery and RTO cases need data the test
 * site does not have and are declared manual (unit / integration tests cover them).
 */
import ExcelJS from "exceljs";

import { as } from "../lib/actors";
import { shopOf } from "../lib/flows";
import { anonymous, call, RUN, stash, unstash, why } from "../lib/http";
import { expect, manual, need, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import { filePart } from "../lib/sellers-helpers";

const signed = { tier: "signed" as const, timeout: 180_000 };
const STASH = "sellers-product-upload";

/** A file download as the shop owner: status, headers and bytes. */
async function download(path: string) {
  const res = await (await as("shop")).fetch(new URL(path, BASE_URL).toString(), { failOnStatusCode: false, timeout: 120_000 });
  return { status: res.status(), headers: res.headers(), bytes: await res.body() };
}

function csvHeader(bytes: Buffer) {
  return bytes.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)[0].split(",");
}

qa("TC-OPG-001", "the upload template comes as CSV with the Excel template's columns", async () => {
  const res = await download("/api/v1/product-imports/template?format=csv");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/text\/csv/);
  expect(res.headers["content-disposition"]).toMatch(/GoKesari_Product_Upload_Template\.csv/);
  const header = csvHeader(res.bytes);
  for (const column of ["Product Name", "HSN Code", "GST %", "MRP", "Selling Price", "Goods Type"]) expect(header).toContain(column);
  expect(res.bytes.toString("utf8")).toContain("EXAMPLE");
  return `${header.length} columns: ${header.join(", ")}`;
}, signed);

qa("TC-OPG-002", "the Excel template offers GST % and Goods Type as drop-downs", async () => {
  const res = await download("/api/v1/product-imports/template");
  expect(res.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.bytes as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Products")!;
  const header = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  const cell = (name: string) => ws.getCell(2, header.indexOf(name));
  const gst = String(cell("GST %").dataValidation?.formulae?.[0] ?? "");
  expect(cell("GST %").dataValidation).toMatchObject({ type: "list" });
  expect(gst).toContain("18");
  expect(gst).toContain("40");
  expect(cell("Goods Type").dataValidation?.formulae?.[0]).toBe('"Packaged,Loose"');
  return `GST % list ${gst}; Goods Type list Packaged, Loose`;
}, signed);

qa("TC-OPG-003", "the shop owner downloads their catalogue as Excel and CSV in the upload layout", async () => {
  const shop = await shopOf("A");
  const xlsx = await download(`/api/v1/shops/${shop.id}/catalogue-export?format=xlsx`);
  expect(xlsx.status, xlsx.bytes.toString("utf8").slice(0, 200)).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ""));
  for (const column of ["SKU", "Product Name", "HSN Code", "GST %", "MRP", "Selling Price", "Quantity", "Goods Type"]) expect(header).toContain(column);
  const rows = ws.actualRowCount - 1;
  expect(rows, "one row per listing").toBeGreaterThan(0);

  const csv = await download(`/api/v1/shops/${shop.id}/catalogue-export?format=csv`);
  expect(csv.status).toBe(200);
  expect(csv.headers["content-type"]).toMatch(/text\/csv/);
  expect(csvHeader(csv.bytes)).toEqual(header);
  return `${shop.name}: ${rows} listings; Excel and CSV share the header ${header.join(", ")}`;
}, signed);

qa("TC-OPG-004", "a customer and a signed-out caller cannot download a shop's catalogue", async () => {
  const shop = await shopOf("A");
  const path = `/api/v1/shops/${shop.id}/catalogue-export?format=csv`;
  const customer = await call(await as("customer"), "GET", path);
  expect(customer.status, why(customer)).toBe(403);
  const guest = await call(await anonymous(), "GET", path);
  expect(guest.status, why(guest)).toBe(401);
  return `customer ${customer.status}, signed out ${guest.status}`;
}, signed);

qa("TC-OPG-005", "the upload preview flags a price above MRP, a non-slab GST rate and a loose good without a weight unit", async () => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const csv = [
    "Product Name,HSN Code,GST %,MRP,Selling Price,Quantity,Unit,Goods Type,Action",
    `QA price above MRP ${RUN},21069099,18,34,35,1,pcs,Packaged,Upsert`,
    `QA odd GST ${RUN},21069099,7,50,45,1,pcs,Packaged,Upsert`,
    `QA loose in pieces ${RUN},07136000,0,,140,1,pcs,Loose,Upsert`,
  ].join("\r\n");
  const upload = await call(owner, "POST", `/api/v1/shops/${shop.id}/product-imports`, undefined, {
    multipart: { file: filePart(`qa-preview-${RUN}.csv`, Buffer.from(csv), "text/csv") },
  });
  expect(upload.status, why(upload)).toBe(202);
  const jobId = upload.body.jobId as string;
  stash(STASH, { jobId });

  let status = "";
  for (let i = 0; i < 30 && !/preview_ready|failed/.test(status); i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    status = (await call(owner, "GET", `/api/v1/product-imports/${jobId}`)).body?.status ?? "";
  }
  expect(status, "the preview is ready").toBe("preview_ready");
  const rows = await call(owner, "GET", `/api/v1/product-imports/${jobId}/rows?status=all&page=1`);
  expect(rows.status, why(rows)).toBe(200);
  const messages = (rows.body.rows as { messages: string[] }[]).map((r) => r.messages.join(" "));
  expect(messages.join(" | ")).toMatch(/above the MRP/);
  expect(messages.join(" | ")).toMatch(/GST 7% is not a GST rate/);
  expect(messages.join(" | ")).toMatch(/kg, g, l or ml/);
  return messages.join(" | ").slice(0, 400);
}, signed);

qa("TC-OPG-006", "the result report can hold only the rows to fix", async () => {
  const { jobId } = need(unstash<{ jobId: string }>(STASH), "the preview upload of TC-OPG-005");
  const owner = await as("shop");
  try {
    const res = await download(`/api/v1/product-imports/${jobId}/report?format=csv&rows=problems`);
    expect(res.status).toBe(200);
    const lines = res.bytes.toString("utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
    expect(lines.length - 1, "the three flagged rows").toBe(3);
    return `${lines.length - 1} rows to fix; header ${lines[0].slice(0, 120)}`;
  } finally {
    await call(owner, "POST", `/api/v1/product-imports/${jobId}/cancel`);
  }
}, signed);

manual("TC-OPG-007", "cess on the tax invoice", "needs a GST-registered shop selling a cess listing on the site; covered by tests/unit/gst-slabs.test.ts and the invoice integration tests");
manual("TC-OPG-008", "composition dealer's GSTIN on the bill of supply", "needs a composition shop with a GSTIN on the site; covered by the invoice integration tests");
manual("TC-OPG-009", "reattempt after a failed delivery needs operations", "needs a failed delivery attempt by a rider; covered by the order integration tests");
manual("TC-OPG-010", "returned to shop: buyer and shop told", "needs an RTO on the site; covered by the event catalogue tests");
