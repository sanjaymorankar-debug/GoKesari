/**
 * Sync by file (Module 2) — myBillBook, Vyapar and any other software:
 *
 * IN   the shop uploads its item export (Excel/CSV) → GoKesari reads the
 *      headings and guesses which column is what (the shop's last mapping,
 *      else the software's preset) → the shop confirms the columns on the
 *      mapping screen → the rows go through the same matching and applying as
 *      an API pull.
 * OUT  invoices and credit notes queue like any other push; for a file
 *      connection they wait as "ready to export". Downloading "new entries"
 *      takes exactly those and marks them exported, so the next download
 *      never repeats one. A date-range download (for a re-import or the CA)
 *      marks nothing. Every row carries GoKesari's document number, which
 *      the software can use to refuse a duplicate.
 */
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { stateLabel } from "@/lib/gst-states";
import { db } from "@/server/db";
import {
  creditNotes,
  integrationColumnMappings,
  integrationImports,
  integrationJobs,
  shopIntegrations,
  taxInvoices,
  type ShopIntegration,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { CanonicalCreditNote, CanonicalInvoice, CanonicalItem } from "./canonical";
import type { IntegrationActor } from "./connections";
import { creditNoteToCanonical, invoiceToCanonical, mappingFor } from "./documents";
import { liveIntegration, logSync } from "./jobs";
import { applyPulledItems, type PullSummary } from "./pull";
import { adapterFor, isFileAdapter } from "./registry";
import { readSheet, sheetTypeOf, toCsv, toXlsx } from "./tabular";
import { FILE_ITEM_FIELDS, type FileItemField } from "./types";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;
const SAMPLE_ROWS = 5;

export const FIELD_LABELS: Record<FileItemField, { label: string; required: boolean; hint: string }> = {
  externalId: { label: "Item code / ID in your software", required: false, hint: "Leave empty to use the code, barcode or name." },
  name: { label: "Item name", required: true, hint: "" },
  sku: { label: "Item code / SKU", required: false, hint: "" },
  barcode: { label: "Barcode (EAN)", required: false, hint: "Best for automatic matching." },
  unit: { label: "Unit", required: false, hint: "" },
  stock: { label: "Stock quantity", required: false, hint: "" },
  price: { label: "Selling price (₹, incl. GST)", required: false, hint: "" },
  mrp: { label: "MRP (₹)", required: false, hint: "" },
  hsn: { label: "HSN code", required: false, hint: "" },
  gstRate: { label: "GST rate (%)", required: false, hint: "" },
};

async function requireFileIntegration(shopId: string): Promise<ShopIntegration> {
  const integration = await liveIntegration(shopId);
  if (!integration) throw notFound("Accounting connection");
  if (!isFileAdapter(adapterFor(integration.provider))) throw validationFailed("This connection does not sync by file.");
  return integration;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();

/** Column guess: the shop's last mapping when its headings are all present, else the software's preset. */
export async function suggestMapping(integration: ShopIntegration, headers: string[]): Promise<Record<string, string>> {
  const [saved] = await db
    .select({ mapping: integrationColumnMappings.mapping })
    .from(integrationColumnMappings)
    .where(and(eq(integrationColumnMappings.shopId, integration.shopId), eq(integrationColumnMappings.provider, integration.provider), eq(integrationColumnMappings.kind, "ITEMS")));
  if (saved && Object.values(saved.mapping).every((h) => headers.includes(h))) return saved.mapping;
  const adapter = adapterFor(integration.provider);
  const presets = isFileAdapter(adapter) ? adapter.itemColumns : {};
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of FILE_ITEM_FIELDS) {
    for (const alias of presets[field] ?? []) {
      const header = headers.find((h) => !used.has(h) && norm(h) === norm(alias));
      if (header) {
        out[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return out;
}

export async function createItemImport(shopId: string, file: { name: string; bytes: Buffer }, actor: IntegrationActor) {
  const integration = await requireFileIntegration(shopId);
  if (file.bytes.length === 0) throw validationFailed("The file is empty.");
  if (file.bytes.length > MAX_IMPORT_BYTES) throw validationFailed("The file is larger than 5 MB.");
  const type = sheetTypeOf(file.name, file.bytes);
  const rows = await readSheet(file.bytes, type, MAX_IMPORT_ROWS);
  if (rows.length < 2) throw validationFailed("The file has no item rows under its headings.");
  const headers = rows[0].map((h, i) => h || `Column ${i + 1}`);
  if (new Set(headers).size !== headers.length) throw validationFailed("Two columns have the same heading. Rename one and upload again.");
  const mapping = await suggestMapping(integration, headers);
  const [row] = await db
    .insert(integrationImports)
    .values({
      shopId,
      integrationId: integration.id,
      uploadedBy: actor.id,
      fileName: file.name.slice(0, 200),
      fileType: type,
      headers,
      sampleRows: rows.slice(1, 1 + SAMPLE_ROWS),
      rowCount: rows.length - 1,
      mapping,
      fileStorage: "DB",
      fileData: file.bytes,
    })
    .returning({ id: integrationImports.id });
  return getItemImport(shopId, row.id);
}

export async function getItemImport(shopId: string, importId: string) {
  const [row] = await db
    .select({
      id: integrationImports.id,
      fileName: integrationImports.fileName,
      fileType: integrationImports.fileType,
      status: integrationImports.status,
      headers: integrationImports.headers,
      sampleRows: integrationImports.sampleRows,
      rowCount: integrationImports.rowCount,
      mapping: integrationImports.mapping,
      summary: integrationImports.summary,
      createdAt: integrationImports.createdAt,
      appliedAt: integrationImports.appliedAt,
    })
    .from(integrationImports)
    .where(and(eq(integrationImports.id, importId), eq(integrationImports.shopId, shopId)));
  if (!row) throw notFound("Upload");
  return { ...row, running: row.status === "APPLIED" && !row.appliedAt, fields: FIELD_LABELS };
}

export async function listItemImports(shopId: string) {
  return db
    .select({
      id: integrationImports.id,
      fileName: integrationImports.fileName,
      status: integrationImports.status,
      rowCount: integrationImports.rowCount,
      summary: integrationImports.summary,
      createdAt: integrationImports.createdAt,
      appliedAt: integrationImports.appliedAt,
    })
    .from(integrationImports)
    .where(eq(integrationImports.shopId, shopId))
    .orderBy(desc(integrationImports.createdAt))
    .limit(20);
}

export const mappingSchema = z.partialRecord(z.enum(FILE_ITEM_FIELDS), z.string().min(1).max(200));

export async function setImportMapping(shopId: string, importId: string, mapping: z.infer<typeof mappingSchema>, actor: IntegrationActor) {
  const [imp] = await db.select().from(integrationImports).where(and(eq(integrationImports.id, importId), eq(integrationImports.shopId, shopId)));
  if (!imp) throw notFound("Upload");
  if (imp.status !== "UPLOADED") throw conflict("This upload has already been applied or cancelled.");
  const unknown = Object.values(mapping).filter((h) => !imp.headers.includes(h));
  if (unknown.length) throw validationFailed(`These columns are not in the file: ${unknown.join(", ")}`);
  if (!mapping.name) throw validationFailed("Choose the column with the item name.");
  const columns = Object.values(mapping);
  if (new Set(columns).size !== columns.length) throw validationFailed("One column is chosen for two fields.");
  const [integration] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.id, imp.integrationId));
  await db.update(integrationImports).set({ mapping }).where(eq(integrationImports.id, importId));
  await db
    .insert(integrationColumnMappings)
    .values({ shopId, provider: integration.provider, kind: "ITEMS", mapping, updatedBy: actor.id })
    .onConflictDoUpdate({
      target: [integrationColumnMappings.shopId, integrationColumnMappings.provider, integrationColumnMappings.kind],
      set: { mapping, updatedBy: actor.id, updatedAt: new Date() },
    });
  return getItemImport(shopId, importId);
}

/* ------------------------------------------------------- reading rows */

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const text = raw.replace(/[₹,\s]/g, "").replace(/^'/, "").replace(/(rs\.?|inr)/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const toPaise = (raw: string | undefined) => {
  const n = parseNumber(raw);
  return n != null && n >= 0 ? Math.round(n * 100) : null;
};

/** "18", "18%", "18.0" → 1800 bp; a fraction ("0.18") is read as 18%. */
function toRateBp(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseNumber(raw.replace("%", ""));
  if (n == null || n < 0) return null;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return pct <= 100 ? Math.round(pct * 100) : null;
}

export function rowsToItems(headers: string[], rows: string[][], mapping: Partial<Record<FileItemField, string>>): { items: CanonicalItem[]; skipped: number } {
  const index = Object.fromEntries(Object.entries(mapping).map(([f, h]) => [f, headers.indexOf(h)])) as Partial<Record<FileItemField, number>>;
  const get = (row: string[], field: FileItemField) => {
    const i = index[field];
    return i != null && i >= 0 ? row[i]?.trim() || undefined : undefined;
  };
  const items: CanonicalItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    const name = get(row, "name");
    if (!name) {
      skipped += 1;
      continue;
    }
    const sku = get(row, "sku") ?? null;
    const barcode = get(row, "barcode") ?? null;
    const externalId = (get(row, "externalId") ?? sku ?? barcode ?? name.toLowerCase()).slice(0, 300);
    if (seen.has(externalId)) {
      skipped += 1;
      continue;
    }
    seen.add(externalId);
    const hsn = get(row, "hsn")?.replace(/\D/g, "");
    items.push({
      externalId,
      name: name.slice(0, 300),
      sku: sku?.slice(0, 100) ?? null,
      barcode: barcode?.replace(/\.0+$/, "").slice(0, 100) ?? null,
      unit: get(row, "unit")?.slice(0, 40) ?? null,
      stock: parseNumber(get(row, "stock")),
      pricePaise: toPaise(get(row, "price")),
      mrpPaise: toPaise(get(row, "mrp")),
      hsn: hsn && /^\d{4,8}$/.test(hsn) ? hsn : null,
      gstRateBp: toRateBp(get(row, "gstRate")),
    });
  }
  return { items, skipped };
}

/**
 * Starts applying an upload: claims it (a second press is refused) and
 * returns. `runItemImport` does the work after the response.
 */
export async function startItemImport(shopId: string, importId: string, actor: IntegrationActor): Promise<void> {
  const [imp] = await db
    .update(integrationImports)
    .set({ status: "APPLIED", appliedAt: null })
    .where(and(eq(integrationImports.id, importId), eq(integrationImports.shopId, shopId), eq(integrationImports.status, "UPLOADED")))
    .returning();
  if (!imp) {
    const [exists] = await db.select({ status: integrationImports.status }).from(integrationImports).where(and(eq(integrationImports.id, importId), eq(integrationImports.shopId, shopId)));
    if (!exists) throw notFound("Upload");
    throw conflict("This upload has already been applied or cancelled.");
  }
  if (!imp.mapping?.name) {
    await db.update(integrationImports).set({ status: "UPLOADED" }).where(eq(integrationImports.id, importId));
    throw validationFailed("Choose the column with the item name first.");
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_FILE_APPLIED,
    entityType: "shop",
    entityId: shopId,
    newValue: { importId, fileName: imp.fileName, rows: imp.rowCount, mapping: imp.mapping, via: actor.via },
  });
}

export async function runItemImport(importId: string): Promise<PullSummary | null> {
  const [imp] = await db.select().from(integrationImports).where(eq(integrationImports.id, importId));
  if (!imp || imp.status !== "APPLIED" || imp.appliedAt || !imp.fileData) return null;
  const [integration] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.id, imp.integrationId));
  try {
    const rows = await readSheet(Buffer.from(imp.fileData), imp.fileType, MAX_IMPORT_ROWS);
    const { items, skipped } = rowsToItems(rows[0], rows.slice(1), imp.mapping ?? {});
    const summary = await applyPulledItems(integration, items);
    summary.invalid += skipped;
    const now = new Date();
    await db
      .update(integrationImports)
      .set({ appliedAt: now, summary: summary as unknown as Record<string, number>, fileData: null })
      .where(eq(integrationImports.id, importId));
    await db.update(shopIntegrations).set({ lastPullAt: now, updatedAt: now }).where(eq(shopIntegrations.id, integration.id));
    return summary;
  } catch (error) {
    // Back to "uploaded" so the owner can fix the columns and press Apply again.
    await db.update(integrationImports).set({ status: "UPLOADED", appliedAt: null }).where(eq(integrationImports.id, importId));
    await logSync(integration, {
      level: "ERROR",
      event: "file.failed",
      message: `The file ${imp.fileName} could not be applied: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

export async function cancelItemImport(shopId: string, importId: string): Promise<void> {
  const [row] = await db
    .update(integrationImports)
    .set({ status: "CANCELLED", fileData: null })
    .where(and(eq(integrationImports.id, importId), eq(integrationImports.shopId, shopId), eq(integrationImports.status, "UPLOADED")))
    .returning({ id: integrationImports.id });
  if (!row) throw conflict("Only an upload not yet applied can be cancelled.");
}

/* ------------------------------------------------------------ exports */

export const exportQuerySchema = z.object({
  kind: z.enum(["invoices", "credit-notes", "stock-out"]),
  /** "new": entries not exported before (and mark them); "range": every entry between from and to. */
  scope: z.enum(["new", "range"]).default("new"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  format: z.enum(["xlsx", "csv"]).default("xlsx"),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

const rs = (paise: number) => Math.round(paise) / 100;
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
/** IST midnight of a YYYY-MM-DD date. */
const istStart = (date: string) => new Date(`${date}T00:00:00+05:30`);

const LINE_HEADERS = [
  "Item code (your software)",
  "Item name",
  "HSN",
  "Quantity",
  "Unit",
  "Rate (excl. GST)",
  "Taxable value",
  "GST %",
  "CGST",
  "SGST",
  "IGST",
  "Line total",
];

function lineCells(doc: CanonicalInvoice | CanonicalCreditNote) {
  return doc.lines.map((l) => [
    l.externalItemId ?? "",
    l.name,
    l.hsn ?? "",
    l.quantity,
    l.unit,
    rs(l.ratePaise),
    rs(l.taxablePaise),
    l.gstRateBp / 100,
    rs(l.cgstPaise),
    rs(l.sgstPaise),
    rs(l.igstPaise),
    rs(l.totalPaise),
  ]);
}

export interface ExportFile {
  fileName: string;
  contentType: string;
  body: Buffer;
  count: number;
}

export async function exportDocuments(shopId: string, query: ExportQuery, actor: IntegrationActor): Promise<ExportFile> {
  const integration = await requireFileIntegration(shopId);
  const isNotes = query.kind === "credit-notes";
  if (query.scope === "range" && (!query.from || !query.to)) throw validationFailed("Choose the from and to dates.");
  if (query.from && query.to && query.from > query.to) throw validationFailed("The from date is after the to date.");

  // Which documents.
  let jobIds: string[] = [];
  let invoiceRows: (typeof taxInvoices.$inferSelect)[] = [];
  let noteRows: (typeof creditNotes.$inferSelect)[] = [];
  if (query.scope === "new") {
    const kinds = query.kind === "stock-out" ? (["PUSH_INVOICE", "PUSH_CREDIT_NOTE"] as const) : isNotes ? (["PUSH_CREDIT_NOTE"] as const) : (["PUSH_INVOICE"] as const);
    const jobs = await db
      .select({ id: integrationJobs.id, kind: integrationJobs.kind, subjectId: integrationJobs.subjectId })
      .from(integrationJobs)
      .where(and(eq(integrationJobs.integrationId, integration.id), inArray(integrationJobs.kind, [...kinds]), inArray(integrationJobs.status, ["PENDING", "FAILED"])))
      .orderBy(asc(integrationJobs.createdAt))
      .limit(5000);
    jobIds = jobs.map((j) => j.id);
    const invIds = jobs.filter((j) => j.kind === "PUSH_INVOICE").map((j) => j.subjectId!);
    const noteIds = jobs.filter((j) => j.kind === "PUSH_CREDIT_NOTE").map((j) => j.subjectId!);
    if (invIds.length) invoiceRows = await db.select().from(taxInvoices).where(and(eq(taxInvoices.shopId, shopId), inArray(taxInvoices.id, invIds))).orderBy(asc(taxInvoices.issuedAt));
    if (noteIds.length) noteRows = await db.select().from(creditNotes).where(and(eq(creditNotes.shopId, shopId), inArray(creditNotes.id, noteIds))).orderBy(asc(creditNotes.issuedAt));
  } else {
    const from = istStart(query.from!);
    const to = new Date(istStart(query.to!).getTime() + 86_400_000);
    if (!isNotes) invoiceRows = await db.select().from(taxInvoices).where(and(eq(taxInvoices.shopId, shopId), gte(taxInvoices.issuedAt, from), lt(taxInvoices.issuedAt, to))).orderBy(asc(taxInvoices.issuedAt));
    if (isNotes || query.kind === "stock-out") noteRows = await db.select().from(creditNotes).where(and(eq(creditNotes.shopId, shopId), gte(creditNotes.issuedAt, from), lt(creditNotes.issuedAt, to))).orderBy(asc(creditNotes.issuedAt));
  }

  const listingIds = [...invoiceRows.flatMap((i) => (i.snapshot as { lines?: { shopProductId?: string }[] }).lines ?? []), ...noteRows.flatMap((n) => (n.snapshot as { lines?: { shopProductId?: string }[] }).lines ?? [])]
    .map((l) => l.shopProductId ?? "")
    .filter(Boolean);
  const mapping = await mappingFor(integration.id, [...new Set(listingIds)]);
  const invoices = invoiceRows.map((i) => invoiceToCanonical(i, mapping));
  const notes = noteRows.map((n) => creditNoteToCanonical(n, mapping));

  let header: string[];
  let rows: (string | number | null)[][];
  let sheet: string;
  if (query.kind === "invoices") {
    sheet = "Sales invoices";
    header = ["Invoice no", "Invoice date", "Order no", "Customer name", "Customer GSTIN", "Place of supply", ...LINE_HEADERS, "Invoice total"];
    rows = invoices.flatMap((d) =>
      lineCells(d).map((cells) => [d.number, dmy(d.date), d.orderNumber ?? "", d.buyer.name, d.buyer.gstin ?? "", stateLabel(d.placeOfSupply) ?? "", ...cells, rs(d.totals.totalPaise)]),
    );
  } else if (isNotes) {
    sheet = "Credit notes";
    header = ["Credit note no", "Credit note date", "Against invoice", "Invoice date", "Reason", "Goods returned", "Customer name", "Customer GSTIN", "Place of supply", ...LINE_HEADERS, "Credit note total"];
    rows = notes.flatMap((d) =>
      lineCells(d).map((cells) => [
        d.number,
        dmy(d.date),
        d.againstInvoice.number,
        dmy(d.againstInvoice.date),
        d.reason,
        d.restock ? "Yes" : "No",
        d.buyer.name,
        d.buyer.gstin ?? "",
        stateLabel(d.placeOfSupply) ?? "",
        ...cells,
        rs(d.totals.totalPaise),
      ]),
    );
  } else {
    // Stock moved by GoKesari sales: out on each invoice, back in on returns.
    sheet = "Stock movement";
    header = ["Date", "Movement", "Document no", "Item code (your software)", "Item name", "Quantity", "Unit"];
    rows = [
      ...invoices.flatMap((d) => d.lines.map((l) => [dmy(d.date), "OUT", d.number, l.externalItemId ?? "", l.name, l.quantity, l.unit])),
      ...notes.filter((d) => d.restock).flatMap((d) => d.lines.map((l) => [dmy(d.date), "IN", d.number, l.externalItemId ?? "", l.name, l.quantity, l.unit])),
    ].sort((a, b) => String(a[0]).split("-").reverse().join("").localeCompare(String(b[0]).split("-").reverse().join("")));
  }

  const body = query.format === "csv" ? toCsv(header, rows) : await toXlsx(sheet, header, rows);
  const count = query.kind === "invoices" ? invoices.length : isNotes ? notes.length : invoices.length + notes.length;

  if (query.scope === "new" && jobIds.length) {
    const now = new Date();
    const ref = `file:${now.toISOString()}`;
    await db
      .update(integrationJobs)
      .set({ status: "SUCCEEDED", externalRef: ref, completedAt: now, updatedAt: now, errorCode: null, errorMessage: null })
      .where(and(inArray(integrationJobs.id, jobIds), inArray(integrationJobs.status, ["PENDING", "FAILED"])));
    await db.update(shopIntegrations).set({ lastPushAt: now, updatedAt: now }).where(eq(shopIntegrations.id, integration.id));
  }
  await logSync(integration, {
    level: "INFO",
    event: "file.exported",
    message: `Downloaded ${count} ${query.kind === "stock-out" ? "documents as stock movement" : query.kind.replace("-", " ")}${query.scope === "new" ? " (new since the last download)" : ` from ${query.from} to ${query.to}`}.`,
  });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.INTEGRATION_EXPORTED,
    entityType: "shop",
    entityId: shopId,
    newValue: { kind: query.kind, scope: query.scope, from: query.from ?? null, to: query.to ?? null, count, via: actor.via },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    fileName: `gokesari-${query.kind}-${query.scope === "new" ? `new-${stamp}` : `${query.from}-to-${query.to}`}.${query.format}`,
    contentType: query.format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body,
    count,
  };
}
