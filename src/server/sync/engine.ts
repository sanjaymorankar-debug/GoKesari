/**
 * The file sync engine (billing v2, docs/billing §7, §8): export the shop's
 * books to any supported tool and import that tool's files back, through the
 * canonical model (model.ts) only.
 *
 * Export   validate (missing HSN, unmapped units, unbalanced vouchers → a fix
 *          list, nothing exported) → the tool's files (Tally: XML + Excel +
 *          mapping template; others: Excel or CSV; generic: Excel + JSON) →
 *          every master and voucher recorded in sync_records (OUT) with its
 *          hash, so a re-export reports new / changed / unchanged and the
 *          tool's own key (Tally REMOTEID = type|date|number) stops duplicates.
 * Import   parse (Tally XML, generic JSON, or any tool's Excel / CSV by its
 *          headings) → masters first (parties, items), then vouchers (sales
 *          and purchases with items, receipts / payments, journals) → each
 *          record keyed in sync_records (IN). The same record again is
 *          skipped; a record changed on both sides since the last sync goes
 *          to the conflict queue (sync_conflicts) for the shop to decide —
 *          never silently overwritten. GoKesari's own documents are never
 *          edited by an import.
 */
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { and, eq, sql } from "drizzle-orm";

import { BOOK_ACCOUNT_LABELS, BOOK_ACCOUNTS, type BookAccount } from "@/lib/accounts/constants";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  accParties,
  invStockLedger,
  invUnitUqc,
  products,
  shopProducts,
  syncConflicts,
  syncRecords,
  type SyncEntity,
  type SyncSystem,
} from "@/server/db/schema";
import { upsertRow } from "@/server/db/split/upsert";
import { readSheet, sheetTypeOf, toCsv } from "@/server/integrations/tabular";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { todayIst } from "@/server/accounts/books";
import { recordJournal } from "@/server/accounts/journals";
import { recordPayment } from "@/server/accounts/money";
import { createParty, updateParty } from "@/server/accounts/parties";
import { confirmPurchase } from "@/server/accounts/purchases";
import { createSalesInvoice } from "@/server/accounts/sales";
import { postStock } from "@/server/accounts/stock";
import { LAYOUTS, parseItems, parseParties, parseVoucherLines, sheetKindOf, templateSheets, toToolSheets, type FileTool, type Sheet } from "./formats";
import { buildCanonicalBooks, hashOf, itemFingerprint, partyFingerprint, validateBooks, voucherFingerprint, type CanonicalBooks, type CLedger, type CStockItem, type CVoucher, type FixItem } from "./model";
import { parseTallyXml, toTallyXml } from "./tally";

export const MAX_SYNC_FILE_BYTES = 5 * 1024 * 1024;

async function workbook(sheets: Sheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.addRow(s.header).font = { bold: true };
    for (const r of s.rows) ws.addRow(r);
    s.header.forEach((h, i) => (ws.getColumn(i + 1).width = Math.min(40, Math.max(12, h.length + 2))));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** TallyPrime "Import from Excel" field map for the Excel file (verify on the shop's Tally version; docs/billing/connectors/tally.md). */
function tallyMappingTemplate(): string {
  const L = LAYOUTS.TALLY;
  const section = (title: string, map: Record<string, string>) => `[${title}]\n${Object.entries(map).map(([field, column]) => `${field}=${column}`).join("\n")}`;
  return [
    "; GoKesari → TallyPrime Excel import mapping (Gateway of Tally → Import → Masters / Transactions → Excel → Mapping).",
    "; Column headings are those of the gokesari-tally.xlsx file in this pack.",
    section("Ledger", L.parties as Record<string, string>),
    section("StockItem", L.items as Record<string, string>),
    section("Voucher", L.lines as Record<string, string>),
  ].join("\n\n") + "\n";
}

export interface ExportResult {
  bytes: Buffer;
  filename: string;
  contentType: string;
  counts: { new: number; changed: number; unchanged: number };
}

/** Records what was exchanged; returns new / changed / unchanged counts. */
async function recordExchange(shopId: string, system: SyncSystem, direction: "OUT" | "IN", records: { entity: SyncEntity; key: string; gokesariId?: string | null; hash: string }[]) {
  const existing = await db.select().from(syncRecords).where(and(eq(syncRecords.shopId, shopId), eq(syncRecords.system, system)));
  const byKey = new Map(existing.map((r) => [`${r.entityType}|${r.externalKey}`, r]));
  const counts = { new: 0, changed: 0, unchanged: 0 };
  for (const rec of records) {
    const before = byKey.get(`${rec.entity}|${rec.key}`);
    if (!before) counts.new += 1;
    else if (before.lastHash !== rec.hash) counts.changed += 1;
    else {
      counts.unchanged += 1;
      continue;
    }
    await upsertRow(db, syncRecords, {
      keys: [syncRecords.shopId, syncRecords.system, syncRecords.entityType, syncRecords.externalKey],
      values: { shopId, system, entityType: rec.entity, externalKey: rec.key, gokesariId: rec.gokesariId ?? null, lastHash: rec.hash, direction, status: "SYNCED", error: null, lastSyncedAt: new Date() },
      set: { lastHash: rec.hash, direction, status: "SYNCED", error: null, gokesariId: rec.gokesariId ?? null, lastSyncedAt: new Date() },
    });
  }
  return counts;
}

export class ExportBlocked extends Error {
  constructor(public readonly fixes: FixItem[]) {
    super(`${fixes.length} item(s) must be fixed before exporting.`);
  }
}

export async function exportForTool(shopId: string, tool: FileTool, range: { from: string; to: string }, actor: { id: string }): Promise<ExportResult> {
  const books = await buildCanonicalBooks(shopId, range.from, range.to);
  const fixes = validateBooks(books);
  if (fixes.length) throw new ExportBlocked(fixes);
  const L = LAYOUTS[tool];
  const base = `gokesari-${tool.toLowerCase()}-${range.from}-to-${range.to}`;
  const zip = new JSZip();
  if (tool === "TALLY") {
    zip.file("gokesari-tally.xml", toTallyXml(books));
    zip.file("gokesari-tally.xlsx", await workbook(toToolSheets(tool, books)));
    zip.file("gokesari-tally-mapping.tsf", tallyMappingTemplate());
  } else if (tool === "GENERIC") {
    zip.file("gokesari-books.json", JSON.stringify({ schema: "gokesari.books/1", ...books }, null, 2));
    zip.file("gokesari-books.xlsx", await workbook(toToolSheets(tool, books)));
  } else if (L.file === "CSV") {
    for (const s of toToolSheets(tool, books)) zip.file(`${s.name}.csv`, toCsv(s.header, s.rows));
  } else {
    zip.file(`${base}.xlsx`, await workbook(toToolSheets(tool, books)));
  }
  const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const counts = await recordExchange(shopId, tool, "OUT", [
    ...books.ledgers.map((l) => ({ entity: (l.kind === "PARTY" ? "PARTY" : "LEDGER") as SyncEntity, key: l.name, gokesariId: l.key, hash: l.kind === "PARTY" ? partyFingerprint(l) : hashOf(l) })),
    ...books.stockItems.map((i) => ({ entity: "STOCK_ITEM" as SyncEntity, key: i.name, gokesariId: i.key, hash: itemFingerprint(i) })),
    ...books.vouchers.map((v) => ({ entity: "VOUCHER" as SyncEntity, key: v.key, gokesariId: null, hash: voucherFingerprint(v) })),
  ]);
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.SYNC_FILE_EXPORTED, entityType: "shop", entityId: shopId, newValue: { tool, ...range, ...counts } });
  return { bytes, filename: `${base}.zip`, contentType: "application/zip", counts };
}

/** The empty templates of every tool, with a README — the template pack (§8). */
export async function templatePack(): Promise<Buffer> {
  const zip = new JSZip();
  for (const tool of Object.keys(LAYOUTS) as FileTool[]) {
    const L = LAYOUTS[tool];
    const folder = zip.folder(tool.toLowerCase())!;
    if (L.file === "CSV") for (const s of templateSheets(tool)) folder.file(`${s.name}.csv`, toCsv(s.header, []));
    else folder.file(`gokesari-${tool.toLowerCase()}-template.xlsx`, await workbook(templateSheets(tool)));
    if (tool === "TALLY") folder.file("gokesari-tally-mapping.tsf", tallyMappingTemplate());
  }
  zip.file(
    "README.txt",
    [
      "GoKesari template pack — one folder per accounting software.",
      "Each has three sheets: parties / ledgers, items, and voucher lines (one row per ledger or item line; rows with the same voucher type, date and number are one voucher).",
      "Amounts: debit positive, credit negative. Dates: DD-MM-YYYY for Tally, Busy, Marg, Vyapar and myBillBook; YYYY-MM-DD for Zoho, Odoo and the GoKesari standard.",
      "Step-by-step guides (English, Hindi, Marathi): GoKesari → Accounts → Sync → Help.",
    ].join("\n"),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

/* ------------------------------------------------------------- import */

export interface ImportSummary {
  tool: FileTool;
  parties: { created: number; updated: number; unchanged: number };
  items: { updated: number; unchanged: number; notFound: string[] };
  vouchers: { created: number; unchanged: number; skipped: { key: string; reason: string }[] };
  conflicts: number;
}

type Parsed = Pick<CanonicalBooks, "ledgers" | "stockItems" | "vouchers">;

async function sheetsOf(file: { name: string; bytes: Buffer }): Promise<{ header: string[]; rows: string[][] }[]> {
  if (/\.csv$/i.test(file.name)) {
    const rows = await readSheet(file.bytes, "CSV", 20_000);
    return rows.length ? [{ header: rows[0], rows: rows.slice(1) }] : [];
  }
  if (/\.zip$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file.bytes);
    const out: { header: string[]; rows: string[][] }[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !/\.(csv|xlsx)$/i.test(entry.name)) continue;
      out.push(...(await sheetsOf({ name: entry.name, bytes: Buffer.from(await entry.async("nodebuffer")) })));
    }
    return out;
  }
  if (sheetTypeOf(file.name, file.bytes) !== "XLSX") throw validationFailed("Upload an Excel (.xlsx), CSV, Tally XML, GoKesari JSON or a ZIP of them.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.bytes as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as unknown[]).slice(1).map((v) => (v == null ? "" : typeof v === "object" ? String((v as { text?: unknown; result?: unknown }).text ?? (v as { result?: unknown }).result ?? (v instanceof Date ? v.toISOString().slice(0, 10) : "")) : String(v)));
      rows.push(values);
    });
    return { header: rows[0] ?? [], rows: rows.slice(1, 20_001) };
  });
}

export async function parseImportFile(file: { name: string; bytes: Buffer }): Promise<Parsed> {
  if (file.bytes.length > MAX_SYNC_FILE_BYTES) throw validationFailed("The file is larger than 5 MB.");
  const textStart = file.bytes.subarray(0, 200).toString("utf8").trimStart();
  if (/\.xml$/i.test(file.name) || textStart.startsWith("<")) {
    const t = parseTallyXml(file.bytes.toString("utf8"));
    return { ledgers: t.ledgers, stockItems: t.stockItems, vouchers: t.vouchers };
  }
  if (/\.json$/i.test(file.name) || textStart.startsWith("{")) {
    const j = JSON.parse(file.bytes.toString("utf8")) as Partial<CanonicalBooks> & { schema?: string };
    if (j.schema !== "gokesari.books/1") throw validationFailed("This JSON is not a GoKesari books file (schema gokesari.books/1).");
    return { ledgers: j.ledgers ?? [], stockItems: j.stockItems ?? [], vouchers: j.vouchers ?? [] };
  }
  const out: Parsed = { ledgers: [], stockItems: [], vouchers: [] };
  for (const s of await sheetsOf(file)) {
    const kind = sheetKindOf(s.header);
    if (kind === "parties") out.ledgers.push(...parseParties(s.header, s.rows));
    else if (kind === "items") out.stockItems.push(...parseItems(s.header, s.rows));
    else if (kind === "lines") out.vouchers.push(...parseVoucherLines(s.header, s.rows));
  }
  return out;
}

const LEDGER_ALIASES: Record<string, BookAccount> = {
  cash: "CASH", "cash-in-hand": "CASH", "cash in hand": "CASH", bank: "BANK", "bank account": "BANK", "bank accounts": "BANK",
  sales: "SALES", "sales accounts": "SALES", "sales account": "SALES", purchase: "PURCHASES", purchases: "PURCHASES", "purchase accounts": "PURCHASES", "purchase account": "PURCHASES",
  "output cgst": "GST_OUTPUT_CGST", "output sgst": "GST_OUTPUT_SGST", "output igst": "GST_OUTPUT_IGST", "output cess": "GST_OUTPUT_CESS",
  "input cgst": "GST_INPUT_CGST", "input sgst": "GST_INPUT_SGST", "input igst": "GST_INPUT_IGST", "input cess": "GST_INPUT_CESS",
  "round off": "ROUND_OFF", "capital account": "CAPITAL", capital: "CAPITAL", "indirect expenses": "EXPENSE", expenses: "EXPENSE",
};

function accountFor(name: string): BookAccount | null {
  const n = name.trim().toLowerCase();
  const byLabel = BOOK_ACCOUNTS.find((a) => BOOK_ACCOUNT_LABELS[a].toLowerCase() === n);
  return byLabel ?? LEDGER_ALIASES[n] ?? null;
}

async function syncRecordOf(shopId: string, system: SyncSystem, entity: SyncEntity, key: string) {
  const [r] = await db.select().from(syncRecords).where(and(eq(syncRecords.shopId, shopId), eq(syncRecords.system, system), eq(syncRecords.entityType, entity), eq(syncRecords.externalKey, key)));
  return r ?? null;
}

async function queueConflict(shopId: string, system: SyncSystem, entity: SyncEntity, key: string, gokesariId: string | null, local: unknown, incoming: unknown): Promise<void> {
  await db
    .insert(syncConflicts)
    .values({ shopId, system, entityType: entity, externalKey: key, gokesariId, localSnapshot: local as Record<string, unknown>, incomingSnapshot: incoming as Record<string, unknown> })
    .onConflictDoNothing();
  await db.update(syncRecords).set({ status: "CONFLICT" }).where(and(eq(syncRecords.shopId, shopId), eq(syncRecords.system, system), eq(syncRecords.entityType, entity), eq(syncRecords.externalKey, key)));
}

const partyView = (p: typeof accParties.$inferSelect) => ({ name: p.name, gstin: p.gstin, phone: p.phone, email: p.email, address: p.address });
const incomingParty = (l: CLedger) => ({ name: l.name, gstin: l.gstin ?? null, phone: l.phone ?? null, email: l.email ?? null, address: l.address ?? null });

export async function importForTool(shopId: string, tool: FileTool, file: { name: string; bytes: Buffer }, actor: { id: string; role: Parameters<typeof confirmPurchase>[2]["role"] }): Promise<ImportSummary> {
  const parsed = await parseImportFile(file);
  const summary: ImportSummary = { tool, parties: { created: 0, updated: 0, unchanged: 0 }, items: { updated: 0, unchanged: 0, notFound: [] }, vouchers: { created: 0, unchanged: 0, skipped: [] }, conflicts: 0 };

  /* ------------------------------------------- masters first: parties */
  const parties = await db.select().from(accParties).where(eq(accParties.shopId, shopId));
  const partyByName = new Map(parties.map((p) => [p.name.toLowerCase(), p]));
  for (const l of parsed.ledgers.filter((x) => x.kind === "PARTY")) {
    const incoming = incomingParty(l);
    const hash = partyFingerprint(incoming);
    const local = (l.gstin && parties.find((p) => p.gstin === l.gstin)) || partyByName.get(l.name.toLowerCase());
    const record = await syncRecordOf(shopId, tool, "PARTY", l.name);
    if ((record && record.lastHash === hash) || (local && partyFingerprint(partyView(local)) === hash)) {
      summary.parties.unchanged += 1;
      continue;
    }
    if (!local) {
      const isSupplier = /creditor|supplier|vendor/i.test(l.group);
      const created = await createParty(shopId, { kind: isSupplier ? "SUPPLIER" : "CUSTOMER", name: l.name, gstin: l.gstin ?? null, phone: l.phone ?? null, email: l.email ?? null, address: l.address ?? null, openingBalancePaise: -l.openingPaise || undefined }, actor.id);
      partyByName.set(created.name.toLowerCase(), created);
      await recordExchange(shopId, tool, "IN", [{ entity: "PARTY", key: l.name, gokesariId: created.id, hash }]);
      summary.parties.created += 1;
      continue;
    }
    // Changed on both sides since the last exchange → the shop decides. Only GoKesari changed → keep it (the next export sends it).
    const localChanged = record != null && partyFingerprint(partyView(local)) !== record.lastHash;
    if (localChanged) {
      await queueConflict(shopId, tool, "PARTY", l.name, local.id, partyView(local), incoming);
      summary.conflicts += 1;
      continue;
    }
    await updateParty(shopId, local.id, { gstin: incoming.gstin ?? local.gstin, phone: incoming.phone ?? local.phone, email: incoming.email ?? local.email, address: incoming.address ?? local.address }, actor.id);
    await recordExchange(shopId, tool, "IN", [{ entity: "PARTY", key: l.name, gokesariId: local.id, hash }]);
    summary.parties.updated += 1;
  }

  /* ----------------------------------------------- masters: stock items */
  const listings = await db
    .select({ sp: shopProducts, p: products })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(eq(shopProducts.shopId, shopId));
  const listingByName = new Map(listings.map((r) => [(r.p.name + (r.p.variant ? ` ${r.p.variant}` : "")).toLowerCase(), r]));
  const listingByCode = new Map(listings.filter((r) => r.p.barcode || r.p.gtin).map((r) => [(r.p.barcode ?? r.p.gtin)!, r]));
  const matchItem = (i: Pick<CStockItem, "name" | "barcode">) => (i.barcode && listingByCode.get(i.barcode)) || listingByName.get(i.name.toLowerCase()) || null;
  for (const i of parsed.stockItems) {
    const hit = matchItem(i);
    if (!hit) {
      summary.items.notFound.push(i.name);
      continue;
    }
    const hash = itemFingerprint(i);
    const record = await syncRecordOf(shopId, tool, "STOCK_ITEM", i.name);
    if (record?.lastHash === hash || itemFingerprint({ hsn: hit.sp.hsnCode ?? hit.p.hsnCode, gstRateBp: hit.sp.gstRateBp ?? hit.p.gstRateBp, cessBp: hit.sp.cessBp, salePricePaise: hit.sp.offlinePricePaise }) === hash) {
      summary.items.unchanged += 1;
      continue;
    }
    await db
      .update(shopProducts)
      .set({
        ...(i.hsn ? { hsnCode: i.hsn } : {}),
        ...(i.gstRateBp != null ? { gstRateBp: i.gstRateBp } : {}),
        ...(i.cessBp ? { cessBp: i.cessBp } : {}),
        ...(i.salePricePaise != null ? { offlinePricePaise: i.salePricePaise } : {}),
        updatedAt: new Date(),
      })
      .where(eq(shopProducts.id, hit.sp.id));
    // Opening stock only for an item the books have never counted.
    if (i.openingQtyMilli > 0) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(invStockLedger).where(eq(invStockLedger.shopProductId, hit.sp.id));
      if (n === 0) await db.transaction((tx) => postStock([{ shopId, shopProductId: hit.sp.id, channel: "OFFLINE", movementType: "OPENING", qtyMilli: i.openingQtyMilli, sourceType: "MIGRATION", docRef: `${tool} import`, createdBy: actor.id }], tx));
    }
    await recordExchange(shopId, tool, "IN", [{ entity: "STOCK_ITEM", key: i.name, gokesariId: hit.sp.id, hash }]);
    summary.items.updated += 1;
  }

  /* --------------------------------------------------- then vouchers */
  for (const v of parsed.vouchers) {
    const hash = voucherFingerprint(v);
    const record = await syncRecordOf(shopId, tool, "VOUCHER", v.key);
    if (record && record.lastHash === hash) {
      summary.vouchers.unchanged += 1;
      continue;
    }
    if (record) {
      // Changed in the other software after it was exchanged: documents are never edited here.
      await queueConflict(shopId, tool, "VOUCHER", v.key, record.gokesariId, { key: v.key, note: "Recorded in GoKesari earlier" }, v as unknown as Record<string, unknown>);
      summary.conflicts += 1;
      continue;
    }
    try {
      const gokesariId = await applyVoucher(shopId, v, partyByName, matchItem, actor);
      if (!gokesariId) {
        summary.vouchers.skipped.push({ key: v.key, reason: `A ${v.tallyType} voucher is not imported automatically; enter it in GoKesari.` });
        continue;
      }
      await recordExchange(shopId, tool, "IN", [{ entity: "VOUCHER", key: v.key, gokesariId, hash }]);
      summary.vouchers.created += 1;
    } catch (error) {
      summary.vouchers.skipped.push({ key: v.key, reason: error instanceof Error ? error.message : "Could not be imported." });
    }
  }
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.SYNC_FILE_IMPORTED, entityType: "shop", entityId: shopId, newValue: { tool, import: true, parties: summary.parties, vouchers: { created: summary.vouchers.created, skipped: summary.vouchers.skipped.length }, conflicts: summary.conflicts } });
  return summary;
}

async function applyVoucher(
  shopId: string,
  v: CVoucher,
  partyByName: Map<string, typeof accParties.$inferSelect>,
  matchItem: (i: { name: string; barcode: string | null }) => { sp: typeof shopProducts.$inferSelect; p: typeof products.$inferSelect } | null,
  actor: { id: string; role: Parameters<typeof confirmPurchase>[2]["role"] },
): Promise<string | null> {
  const type = v.tallyType.toLowerCase();
  const party = v.party ? partyByName.get(v.party.toLowerCase()) ?? null : null;
  if (v.date > todayIst()) throw validationFailed("Dated in the future.");
  if (/^sales?$/.test(type) || type === "sale" || type === "sales invoice") {
    if (!v.inventoryLines.length) throw validationFailed("A sales voucher without items cannot be turned into an invoice; import it as a journal.");
    const lines = v.inventoryLines.map((i) => {
      const hit = matchItem({ name: i.item, barcode: null });
      return { shopProductId: hit?.sp.id ?? null, description: i.item, hsn: hit?.sp.hsnCode ?? hit?.p.hsnCode ?? null, qtyMilli: Math.abs(i.qtyMilli), unit: hit?.p.unit ?? null, ratePaise: i.ratePaise ?? 0, gstRateBp: hit?.sp.gstRateBp ?? hit?.p.gstRateBp ?? 0 };
    });
    const inv = await createSalesInvoice(shopId, { partyId: party?.id ?? null, buyerName: party ? null : v.party, invoiceDate: v.date, paymentMode: party ? "CREDIT" : "CASH", note: `Imported ${v.number}`, lines }, actor);
    return inv.id;
  }
  if (/^purchases?$/.test(type)) {
    if (!v.inventoryLines.length) throw validationFailed("A purchase voucher without items cannot be turned into a bill; import it as a journal.");
    const bill = await confirmPurchase(
      shopId,
      {
        supplier: { partyId: party?.id ?? null, name: v.party ?? "Supplier", gstin: party?.gstin ?? null },
        invoiceNo: v.number.slice(0, 40),
        invoiceDate: v.date,
        lines: v.inventoryLines.map((i) => {
          const hit = matchItem({ name: i.item, barcode: null });
          return {
            shopProductId: hit?.sp.id ?? null,
            createNew: hit ? null : { name: i.item.slice(0, 160), unit: "pc" },
            description: i.item,
            qtyMilli: Math.abs(i.qtyMilli),
            ratePaise: i.ratePaise ?? 0,
            gstRateBp: hit?.sp.gstRateBp ?? hit?.p.gstRateBp ?? 0,
          } as Parameters<typeof confirmPurchase>[1]["lines"][number];
        }),
      },
      actor,
    );
    return bill.id;
  }
  if ((type === "receipt" || type === "payment") && party) {
    const partyLine = v.ledgerLines.find((l) => l.ledger.toLowerCase() === party.name.toLowerCase());
    const cashLine = v.ledgerLines.find((l) => accountFor(l.ledger) === "CASH" || accountFor(l.ledger) === "BANK");
    if (partyLine && cashLine) {
      const p = await recordPayment(shopId, { partyId: party.id, direction: type === "receipt" ? "RECEIVED" : "PAID", mode: accountFor(cashLine.ledger) === "CASH" ? "CASH" : "BANK", amountPaise: Math.abs(partyLine.amountPaise), paymentDate: v.date, reference: v.number.slice(0, 80) }, actor.id);
      return (p as { id: string }).id;
    }
  }
  if (type === "journal" || type === "contra" || type === "receipt" || type === "payment") {
    const legs = v.ledgerLines.map((l) => {
      const p = partyByName.get(l.ledger.toLowerCase());
      const account = p ? "PARTY" : accountFor(l.ledger);
      if (!account) throw validationFailed(`Ledger "${l.ledger}" is not one of GoKesari's ledgers; map it first.`);
      return { account, partyId: p?.id ?? null, debitPaise: l.amountPaise > 0 ? l.amountPaise : undefined, creditPaise: l.amountPaise < 0 ? -l.amountPaise : undefined };
    });
    const j = await recordJournal(shopId, { date: v.date, narration: (v.narration || `Imported ${v.tallyType} ${v.number}`).slice(0, 300).padEnd(3, "."), legs }, actor);
    return j.sourceId;
  }
  return null;
}

/* ------------------------------------------------- conflicts and units */

export async function listConflicts(shopId: string) {
  return db.select().from(syncConflicts).where(and(eq(syncConflicts.shopId, shopId), eq(syncConflicts.status, "OPEN")));
}

/** KEEP_LOCAL: GoKesari's record stands (the next export sends it). TAKE_INCOMING: a party takes the other software's details. */
export async function resolveConflict(shopId: string, conflictId: string, choice: "KEEP_LOCAL" | "TAKE_INCOMING", actor: { id: string }) {
  const [c] = await db.select().from(syncConflicts).where(and(eq(syncConflicts.id, conflictId), eq(syncConflicts.shopId, shopId)));
  if (!c) throw notFound("Conflict");
  if (c.status !== "OPEN") return c;
  if (choice === "TAKE_INCOMING") {
    if (c.entityType !== "PARTY" || !c.gokesariId) throw conflict("A voucher in GoKesari cannot be overwritten: cancel it here (credit note / reversal) and import the corrected one.");
    const incoming = c.incomingSnapshot as ReturnType<typeof incomingParty>;
    await updateParty(shopId, c.gokesariId, { gstin: incoming.gstin, phone: incoming.phone, email: incoming.email, address: incoming.address }, actor.id);
  }
  const hash = c.entityType === "PARTY" ? partyFingerprint((choice === "TAKE_INCOMING" ? c.incomingSnapshot : c.localSnapshot) as ReturnType<typeof incomingParty>) : hashOf(choice === "TAKE_INCOMING" ? c.incomingSnapshot : c.localSnapshot);
  await db.update(syncRecords).set({ status: "SYNCED", lastHash: hash, lastSyncedAt: new Date() }).where(and(eq(syncRecords.shopId, shopId), eq(syncRecords.system, c.system), eq(syncRecords.entityType, c.entityType), eq(syncRecords.externalKey, c.externalKey)));
  const [row] = await db.update(syncConflicts).set({ status: choice === "TAKE_INCOMING" ? "TOOK_INCOMING" : "KEPT_LOCAL", resolvedBy: actor.id, resolvedAt: new Date() }).where(eq(syncConflicts.id, c.id)).returning();
  return row;
}

export async function setUnitUqc(shopId: string, unit: string, uqc: string): Promise<void> {
  const u = unit.trim().toLowerCase();
  const code = uqc.trim().toUpperCase();
  if (!u || !/^[A-Z]{3}$/.test(code)) throw validationFailed("Choose a 3-letter GST unit code (UQC), e.g. PAC, KGS, NOS.");
  await upsertRow(db, invUnitUqc, { keys: [invUnitUqc.shopId, invUnitUqc.unit], values: { shopId, unit: u, uqc: code }, set: { uqc: code, updatedAt: new Date() } });
}

/** Per-shop sync dashboard (§7.7): by software — last export / import, counts, open conflicts, failures. */
export async function syncDashboard(shopId: string) {
  const rows = await db
    .select({
      system: syncRecords.system,
      direction: syncRecords.direction,
      status: syncRecords.status,
      n: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${syncRecords.lastSyncedAt})`,
    })
    .from(syncRecords)
    .where(eq(syncRecords.shopId, shopId))
    .groupBy(syncRecords.system, syncRecords.direction, syncRecords.status);
  const conflicts = await listConflicts(shopId);
  const systems = Object.keys(LAYOUTS).map((system) => {
    const mine = rows.filter((r) => r.system === system);
    const last = (dir: "OUT" | "IN") => mine.filter((r) => r.direction === dir).map((r) => r.last).filter(Boolean).sort().pop() ?? null;
    return {
      system,
      label: LAYOUTS[system as FileTool].label,
      records: mine.reduce((n, r) => n + r.n, 0),
      failed: mine.filter((r) => r.status === "FAILED").reduce((n, r) => n + r.n, 0),
      conflicts: conflicts.filter((c) => c.system === system).length,
      lastExport: last("OUT"),
      lastImport: last("IN"),
    };
  });
  return { systems, conflicts };
}
