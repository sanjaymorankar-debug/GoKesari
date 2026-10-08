/**
 * GSTR-1-ready export (Module 2, Phase 3): a shop's GoKesari sales for one
 * month, in the JSON shape of the GST offline tool / API (b2b, b2cl, b2cs,
 * cdnr, cdnur, hsn split B2B/B2C, doc_issue) and as Excel. Download only —
 * for the shop or its CA to check and upload. GoKesari files nothing.
 *
 * It covers only what was sold through GoKesari; the shop's other sales are
 * in its own books. Thresholds (B2CL) come from gst_rules on each invoice's
 * date. Credit notes against B2C small invoices are netted into B2CS, as the
 * return requires; the HSN summary is net of credit notes.
 *
 * Not filled, pending the CA's answer (PLAN.md §9): the e-commerce operator
 * GSTIN ("etin") on supplies through GoKesari.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import ExcelJS from "exceljs";

import { validationFailed } from "@/lib/errors";
import { gstState } from "@/lib/gst-states";
import { db } from "@/server/db";
import { creditNotes, gstReturnExports, shops, taxInvoices, type TaxInvoice } from "@/server/db/schema";
import { toXlsx } from "@/server/integrations/tabular";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { InvoiceLine, InvoiceSnapshot } from "@/server/services/invoices";
import { uqcFor } from "@/server/integrations/canonical";
import type { CreditNoteSnapshot } from "./credit-notes";
import { getGstRule } from "./rules";

const r2 = (paise: number) => Math.round(paise) / 100;
const dmy = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)}`;
};

interface ItemDetail {
  txval: number;
  rt: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

interface Itm {
  num: number;
  itm_det: ItemDetail;
}

type Bucket = { txval: number; iamt: number; camt: number; samt: number };

function byRate(lines: InvoiceLine[], sign = 1): Itm[] {
  const map = new Map<number, Bucket>();
  for (const l of lines) {
    const b = map.get(l.rateBp) ?? { txval: 0, iamt: 0, camt: 0, samt: 0 };
    b.txval += sign * l.taxablePaise;
    b.iamt += sign * l.igstPaise;
    b.camt += sign * l.cgstPaise;
    b.samt += sign * l.sgstPaise;
    map.set(l.rateBp, b);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, b], i) => ({
      num: i + 1,
      itm_det: { txval: r2(b.txval), rt: rate / 100, iamt: r2(b.iamt), camt: r2(b.camt), samt: r2(b.samt), csamt: 0 },
    }));
}

type Section = "B2B" | "B2CL" | "B2CS";

async function classify(s: InvoiceSnapshot, totalPaise: number, at: Date): Promise<Section> {
  if (s.buyer.gstin) return "B2B";
  if (s.supplyType === "INTER") {
    const rule = await getGstRule<{ invoiceValuePaise: number }>("b2clThreshold", at);
    if (rule && totalPaise > rule.invoiceValuePaise) return "B2CL";
  }
  return "B2CS";
}

export interface Gstr1Result {
  json: Record<string, unknown>;
  counts: Record<string, number>;
  totals: { taxablePaise: number; taxPaise: number; invoices: number; creditNotes: number };
  warnings: string[];
  sheets: { name: string; header: string[]; rows: (string | number)[][] }[];
}

export function periodBounds(period: string): { from: Date; to: Date; fp: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw validationFailed("Choose a month (YYYY-MM).");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = new Date(`${m[1]}-${m[2]}-01T00:00:00+05:30`);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  return { from, to: new Date(`${next}-01T00:00:00+05:30`), fp: `${m[2]}${m[1]}` };
}

export async function buildGstr1(shopId: string, period: string): Promise<Gstr1Result> {
  const { from, to, fp } = periodBounds(period);
  const [shop] = await db.select({ gstin: shops.gstin, name: shops.name }).from(shops).where(eq(shops.id, shopId));
  if (!shop?.gstin) throw validationFailed("GSTR-1 is for GST-registered shops: add your GSTIN in the shop's GST details first.");
  const warnings: string[] = [];

  const invoices = await db
    .select()
    .from(taxInvoices)
    .where(and(eq(taxInvoices.shopId, shopId), gte(taxInvoices.issuedAt, from), lt(taxInvoices.issuedAt, to)))
    .orderBy(asc(taxInvoices.financialYear), asc(taxInvoices.sequence));
  const notes = await db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.shopId, shopId), gte(creditNotes.issuedAt, from), lt(creditNotes.issuedAt, to)))
    .orderBy(asc(creditNotes.financialYear), asc(creditNotes.sequence));
  // Invoices the credit notes are against (may be from earlier months).
  const againstIds = [...new Set(notes.map((n) => n.taxInvoiceId))];
  const against = new Map<string, TaxInvoice>(
    againstIds.length ? (await db.select().from(taxInvoices).where(inArray(taxInvoices.id, againstIds))).map((i) => [i.id, i]) : [],
  );

  const b2b = new Map<string, unknown[]>();
  const b2cl = new Map<string, unknown[]>();
  const b2cs = new Map<string, Bucket & { sply_ty: string; pos: string; rt: number }>();
  const cdnr = new Map<string, unknown[]>();
  const cdnur: unknown[] = [];
  const hsn: Record<"B2B" | "B2C", Map<string, { hsn: string; desc: string; uqc: string; qty: number; rt: number } & Bucket>> = { B2B: new Map(), B2C: new Map() };
  const sheetRows: Record<string, (string | number)[][]> = { b2b: [], b2cl: [], b2cs: [], cdnr: [], cdnur: [], "hsn(b2b)": [], "hsn(b2c)": [], docs: [] };

  const addHsn = (section: "B2B" | "B2C", lines: InvoiceLine[], sign: number) => {
    for (const l of lines) {
      const uqc = l.uqc ?? uqcFor(l.unit ?? "");
      const code = l.hsn ?? "";
      if (!code) warnings.push(`"${l.description}" has no HSN code.`);
      const key = `${code}|${uqc}|${l.rateBp}`;
      const row = hsn[section].get(key) ?? { hsn: code, desc: l.description.slice(0, 30), uqc, qty: 0, rt: l.rateBp / 100, txval: 0, iamt: 0, camt: 0, samt: 0 };
      row.qty += sign * (l.qty ?? 0);
      row.txval += sign * l.taxablePaise;
      row.iamt += sign * l.igstPaise;
      row.camt += sign * l.cgstPaise;
      row.samt += sign * l.sgstPaise;
      hsn[section].set(key, row);
    }
  };
  const addB2cs = (s: InvoiceSnapshot | CreditNoteSnapshot, lines: InvoiceLine[], sign: number) => {
    const pos = gstState(s.placeOfSupply)?.code ?? "";
    for (const l of lines) {
      const key = `${s.supplyType}|${pos}|${l.rateBp}`;
      const b = b2cs.get(key) ?? { sply_ty: s.supplyType, pos, rt: l.rateBp / 100, txval: 0, iamt: 0, camt: 0, samt: 0 };
      b.txval += sign * l.taxablePaise;
      b.iamt += sign * l.igstPaise;
      b.camt += sign * l.cgstPaise;
      b.samt += sign * l.sgstPaise;
      b2cs.set(key, b);
    }
  };

  let taxable = 0;
  let tax = 0;
  const counted: TaxInvoice[] = [];
  for (const inv of invoices) {
    const s = inv.snapshot as unknown as InvoiceSnapshot;
    if (s.kind !== "TAX_INVOICE") {
      warnings.push(`${inv.invoiceNumber} is a bill of supply (issued while the shop had no GSTIN) and is left out.`);
      continue;
    }
    counted.push(inv);
    taxable += inv.taxablePaise;
    tax += inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
    const pos = gstState(s.placeOfSupply)?.code ?? "";
    const section = await classify(s, inv.totalPaise, inv.issuedAt);
    const itms = byRate(s.lines);
    if (section === "B2B") {
      const list = b2b.get(s.buyer.gstin!) ?? [];
      list.push({ inum: inv.invoiceNumber, idt: dmy(inv.issuedAt), val: r2(inv.totalPaise), pos, rchrg: "N", inv_typ: "R", itms });
      b2b.set(s.buyer.gstin!, list);
      for (const it of itms) sheetRows.b2b.push([s.buyer.gstin!, s.buyer.name, inv.invoiceNumber, dmy(inv.issuedAt), r2(inv.totalPaise), posLabel(pos), "N", "", "Regular B2B", "", it.itm_det.rt, it.itm_det.txval, 0]);
      addHsn("B2B", s.lines, 1);
    } else if (section === "B2CL") {
      const list = b2cl.get(pos) ?? [];
      list.push({ inum: inv.invoiceNumber, idt: dmy(inv.issuedAt), val: r2(inv.totalPaise), itms: itms.map((i) => ({ num: i.num, itm_det: { txval: i.itm_det.txval, rt: i.itm_det.rt, iamt: i.itm_det.iamt, csamt: 0 } })) });
      b2cl.set(pos, list);
      for (const it of itms) sheetRows.b2cl.push([inv.invoiceNumber, dmy(inv.issuedAt), r2(inv.totalPaise), posLabel(pos), "", it.itm_det.rt, it.itm_det.txval, 0, ""]);
      addHsn("B2C", s.lines, 1);
    } else {
      addB2cs(s, s.lines, 1);
      addHsn("B2C", s.lines, 1);
    }
  }

  for (const note of notes) {
    const s = note.snapshot as unknown as CreditNoteSnapshot;
    const inv = against.get(note.taxInvoiceId);
    if (!inv || (inv.snapshot as unknown as InvoiceSnapshot).kind !== "TAX_INVOICE") continue;
    const invSnap = inv.snapshot as unknown as InvoiceSnapshot;
    taxable -= note.taxablePaise;
    tax -= note.cgstPaise + note.sgstPaise + note.igstPaise;
    const pos = gstState(s.placeOfSupply)?.code ?? "";
    const section = await classify(invSnap, inv.totalPaise, inv.issuedAt);
    const itms = byRate(s.lines);
    if (section === "B2B") {
      const list = cdnr.get(invSnap.buyer.gstin!) ?? [];
      list.push({ ntty: "C", nt_num: note.creditNoteNumber, nt_dt: dmy(note.issuedAt), val: r2(note.totalPaise), pos, rchrg: "N", inv_typ: "R", itms });
      cdnr.set(invSnap.buyer.gstin!, list);
      for (const it of itms) sheetRows.cdnr.push([invSnap.buyer.gstin!, invSnap.buyer.name, note.creditNoteNumber, dmy(note.issuedAt), "C", posLabel(pos), "N", "Regular B2B", r2(note.totalPaise), "", it.itm_det.rt, it.itm_det.txval, 0]);
      addHsn("B2B", s.lines, -1);
    } else if (section === "B2CL") {
      cdnur.push({ typ: "B2CL", ntty: "C", nt_num: note.creditNoteNumber, nt_dt: dmy(note.issuedAt), val: r2(note.totalPaise), pos, itms: itms.map((i) => ({ num: i.num, itm_det: { txval: i.itm_det.txval, rt: i.itm_det.rt, iamt: i.itm_det.iamt, csamt: 0 } })) });
      for (const it of itms) sheetRows.cdnur.push(["B2CL", note.creditNoteNumber, dmy(note.issuedAt), "C", posLabel(pos), r2(note.totalPaise), "", it.itm_det.rt, it.itm_det.txval, 0]);
      addHsn("B2C", s.lines, -1);
    } else {
      addB2cs(s, s.lines, -1);
      addHsn("B2C", s.lines, -1);
    }
  }

  const b2csList = [...b2cs.values()]
    .filter((b) => b.txval !== 0)
    .map((b) => ({ sply_ty: b.sply_ty, pos: b.pos, typ: "OE", rt: b.rt, txval: r2(b.txval), iamt: r2(b.iamt), camt: r2(b.camt), samt: r2(b.samt), csamt: 0 }));
  for (const b of b2csList) sheetRows.b2cs.push(["OE", posLabel(b.pos), "", b.rt, b.txval, 0, ""]);

  const hsnRows = (section: "B2B" | "B2C") =>
    [...hsn[section].values()]
      .filter((h) => h.txval !== 0)
      .map((h, i) => ({ num: i + 1, hsn_sc: h.hsn, desc: h.desc, uqc: h.uqc, qty: Math.round(h.qty * 1000) / 1000, rt: h.rt, txval: r2(h.txval), iamt: r2(h.iamt), camt: r2(h.camt), samt: r2(h.samt), csamt: 0 }));
  const hsnB2b = hsnRows("B2B");
  const hsnB2c = hsnRows("B2C");
  for (const h of hsnB2b) sheetRows["hsn(b2b)"].push([h.hsn_sc, h.desc, h.uqc, h.qty, h.txval + h.iamt + h.camt + h.samt, h.rt, h.txval, h.iamt, h.camt, h.samt, 0]);
  for (const h of hsnB2c) sheetRows["hsn(b2c)"].push([h.hsn_sc, h.desc, h.uqc, h.qty, h.txval + h.iamt + h.camt + h.samt, h.rt, h.txval, h.iamt, h.camt, h.samt, 0]);

  const docDet: unknown[] = [];
  if (counted.length) {
    docDet.push({ doc_num: 1, doc_typ: "Invoices for outward supply", docs: [{ num: 1, from: counted[0].invoiceNumber, to: counted[counted.length - 1].invoiceNumber, totnum: counted.length, cancel: 0, net_issue: counted.length }] });
    sheetRows.docs.push(["Invoices for outward supply", counted[0].invoiceNumber, counted[counted.length - 1].invoiceNumber, counted.length, 0]);
  }
  if (notes.length) {
    docDet.push({ doc_num: 5, doc_typ: "Credit Note", docs: [{ num: 1, from: notes[0].creditNoteNumber, to: notes[notes.length - 1].creditNoteNumber, totnum: notes.length, cancel: 0, net_issue: notes.length }] });
    sheetRows.docs.push(["Credit Note", notes[0].creditNoteNumber, notes[notes.length - 1].creditNoteNumber, notes.length, 0]);
  }
  if (counted.length + notes.length > 0) warnings.push("E-commerce operator GSTIN (etin) is not filled: confirm with your CA how supplies through GoKesari are to be reported.");

  const json: Record<string, unknown> = {
    gstin: shop.gstin,
    fp,
    b2b: [...b2b.entries()].map(([ctin, inv]) => ({ ctin, inv })),
    b2cl: [...b2cl.entries()].map(([pos, inv]) => ({ pos, inv })),
    b2cs: b2csList,
    cdnr: [...cdnr.entries()].map(([ctin, nt]) => ({ ctin, nt })),
    cdnur,
    hsn: { hsn_b2b: hsnB2b, hsn_b2c: hsnB2c },
    doc_issue: { doc_det: docDet },
  };
  const counts = {
    b2b: [...b2b.values()].reduce((s, l) => s + l.length, 0),
    b2cl: [...b2cl.values()].reduce((s, l) => s + l.length, 0),
    b2cs: b2csList.length,
    cdnr: [...cdnr.values()].reduce((s, l) => s + l.length, 0),
    cdnur: cdnur.length,
    hsnB2b: hsnB2b.length,
    hsnB2c: hsnB2c.length,
  };
  return {
    json,
    counts,
    totals: { taxablePaise: taxable, taxPaise: tax, invoices: counted.length, creditNotes: notes.length },
    warnings: [...new Set(warnings)],
    sheets: [
      { name: "b2b", header: ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"], rows: sheetRows.b2b },
      { name: "b2cl", header: ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], rows: sheetRows.b2cl },
      { name: "b2cs", header: ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], rows: sheetRows.b2cs },
      { name: "cdnr", header: ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"], rows: sheetRows.cdnr },
      { name: "cdnur", header: ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"], rows: sheetRows.cdnur },
      { name: "hsn(b2b)", header: ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"], rows: sheetRows["hsn(b2b)"] },
      { name: "hsn(b2c)", header: ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"], rows: sheetRows["hsn(b2c)"] },
      { name: "docs", header: ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"], rows: sheetRows.docs },
    ],
  };
}

function posLabel(code: string): string {
  const s = gstState(code);
  return s ? `${s.code}-${s.name}` : code;
}

export async function exportGstr1(
  shopId: string,
  period: string,
  format: "json" | "xlsx",
  actor: { id: string; role: string },
): Promise<{ fileName: string; contentType: string; body: Buffer }> {
  const result = await buildGstr1(shopId, period);
  let body: Buffer;
  if (format === "json") {
    body = Buffer.from(JSON.stringify(result.json, null, 2), "utf8");
  } else {
    // One workbook, one sheet per section, as the offline tool's Excel template.
    const first = result.sheets[0];
    const base = await toXlsx(first.name, first.header, first.rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(base as unknown as ArrayBuffer);
    for (const sheet of result.sheets.slice(1)) {
      const ws = workbook.addWorksheet(sheet.name);
      ws.addRow(sheet.header).font = { bold: true };
      for (const row of sheet.rows) ws.addRow(row);
    }
    if (result.warnings.length) {
      const ws = workbook.addWorksheet("notes");
      ws.addRow(["Check before uploading"]).font = { bold: true };
      for (const w of result.warnings) ws.addRow([w]);
    }
    body = Buffer.from(await workbook.xlsx.writeBuffer());
  }
  await db.insert(gstReturnExports).values({
    shopId,
    period,
    format: format === "json" ? "JSON" : "XLSX",
    counts: result.counts,
    checksum: createHash("sha256").update(body).digest("hex"),
    generatedBy: actor.id,
  });
  await recordAudit({
    actorId: actor.id,
    action: AUDIT_ACTIONS.GST_RETURN_EXPORTED,
    entityType: "shop",
    entityId: shopId,
    newValue: { period, format, counts: result.counts },
  });
  return {
    fileName: `GSTR1-${period}-${shopId.slice(0, 8)}.${format}`,
    contentType: format === "json" ? "application/json" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body,
  };
}

