/**
 * From uploaded files to a bill draft (docs/inventory-accounting-2026-10, Parts 4–5).
 *
 * Engines, most trusted first:
 *   1. E-invoice JSON (the IRP's signed invoice): the data itself, 100%.
 *   2. The signed e-invoice QR on a PDF or photo: the trusted header (supplier
 *      GSTIN, number, date, total, IRN) the rest is checked against; its RS256
 *      signature is verified when EINVOICE_QR_PUBLIC_KEY (NIC's key) is set.
 *   3. Claude (when enabled): items and header from photos / PDFs, any
 *      language, per-field confidence.
 *   4. Local: Excel / CSV tables, a PDF's text layer, tesseract OCR of photos
 *      (English), read with the regular expressions of bill-text-parse.
 * Whatever is read, the owner reviews it before anything is booked.
 */
import { randomUUID } from "node:crypto";

import { decodeSignedQr, parseEinvoiceJson, verifySignedQr, type EinvoiceData, type SignedQrPayload } from "@/lib/einvoice/parse";
import { emptyDraft, emptyLine, f, type BillDraft, type DraftLine } from "@/lib/accounts/bill-draft";
import { parseBillSheet, parseBillText, type TextBill, type TextBillLine } from "@/lib/accounts/bill-text-parse";
import type { ExtractionEngine } from "@/lib/accounts/constants";
import { readSheet, sheetTypeOf } from "@/server/integrations/tabular";
import { ocrImageText, pdfText } from "@/server/kyc/document-reader";
import { aiExtractionEnabled, extractTextWithClaude, extractWithClaude, type AiBill } from "./extract-ai";
import { findQrCodes, findQrCodesInPdf } from "../qr-decode";

export interface ExtractInputFile {
  bytes: Buffer;
  contentType: string;
  name: string | null;
}

export interface ExtractResult {
  draft: BillDraft;
  engine: ExtractionEngine;
}

const toPaise = (rupees: number | null | undefined) => (rupees == null || !Number.isFinite(rupees) ? null : Math.round(rupees * 100));
const toMilli = (qty: number | null | undefined) => (qty == null || !Number.isFinite(qty) ? null : Math.round(qty * 1000));
const toBp = (pct: number | null | undefined) => (pct == null || !Number.isFinite(pct) ? null : Math.round(pct * 100));

/* --------------------------------------------------------------- engines */

export function draftFromEinvoice(e: EinvoiceData, buyerStateCode: string | null): BillDraft {
  const d = emptyDraft(buyerStateCode);
  d.supplierName = f(e.supplier.tradeName ?? e.supplier.legalName ?? null);
  d.supplierGstin = f(e.supplier.gstin);
  d.invoiceNo = f(e.invoiceNo);
  d.invoiceDate = f(e.invoiceDate);
  d.placeOfSupply = f(e.buyer.placeOfSupply ?? e.buyer.stateCode ?? buyerStateCode);
  d.irn = e.irn;
  d.totals = {
    taxablePaise: f(e.totals.taxablePaise),
    cgstPaise: f(e.totals.cgstPaise),
    sgstPaise: f(e.totals.sgstPaise),
    igstPaise: f(e.totals.igstPaise),
    cessPaise: f(e.totals.cessPaise),
    otherChargesPaise: f(e.totals.otherChargesPaise),
    roundOffPaise: f(e.totals.roundOffPaise),
    totalPaise: f(e.totals.totalPaise),
  };
  d.lines = e.lines.map((l) => ({
    ...emptyLine(randomUUID()),
    description: f(l.description),
    hsn: f(l.hsn),
    barcode: f(l.barcode),
    qtyMilli: f(Math.round(l.qty * 1000)),
    unit: f(l.unit),
    ratePaise: f(l.unitPricePaise),
    discountPaise: f(l.discountPaise),
    gstRateBp: f(l.gstRateBp),
    taxablePaise: f(l.taxablePaise),
    taxPaise: f(l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise),
    totalPaise: f(l.totalPaise),
  }));
  if (e.docType !== "INV") d.notes.push(`This is a ${e.docType === "CRN" ? "credit" : "debit"} note, not an invoice — check before adding it as a purchase.`);
  d.notes.push("Read from the e-invoice JSON (IRN data) — trusted source.");
  return d;
}

export function draftFromAi(a: AiBill, buyerStateCode: string | null): BillDraft {
  const d = emptyDraft(buyerStateCode);
  const c = (x: { confidence: number }) => Math.round(x.confidence);
  d.supplierName = f(a.supplier_name.value, c(a.supplier_name));
  d.supplierGstin = f(a.supplier_gstin.value?.replace(/\s+/g, "").toUpperCase() ?? null, c(a.supplier_gstin));
  d.invoiceNo = f(a.invoice_number.value, c(a.invoice_number));
  d.invoiceDate = f(a.invoice_date.value && /^\d{4}-\d{2}-\d{2}$/.test(a.invoice_date.value) ? a.invoice_date.value : null, c(a.invoice_date));
  if (a.place_of_supply_state_code.value && /^\d{2}$/.test(a.place_of_supply_state_code.value)) d.placeOfSupply = f(a.place_of_supply_state_code.value, c(a.place_of_supply_state_code));
  const money = (x: { value: number | null; confidence: number }) => f(toPaise(x.value), c(x));
  d.totals = {
    taxablePaise: money(a.taxable_total),
    cgstPaise: money(a.cgst_total),
    sgstPaise: money(a.sgst_total),
    igstPaise: money(a.igst_total),
    cessPaise: a.cess_total.value == null ? f(0, 100) : money(a.cess_total),
    otherChargesPaise: a.other_charges.value == null ? f(0, 100) : money(a.other_charges),
    roundOffPaise: money(a.round_off),
    totalPaise: money(a.grand_total),
  };
  d.lines = a.lines.map((l) => ({
    ...emptyLine(randomUUID()),
    description: f(l.description.value ?? "", c(l.description)),
    hsn: f(l.hsn.value, c(l.hsn)),
    barcode: f(l.barcode.value, c(l.barcode)),
    qtyMilli: f(toMilli(l.quantity.value), c(l.quantity)),
    unit: f(l.unit.value, c(l.unit)),
    ratePaise: money(l.rate),
    discountPaise: l.discount_amount.value == null ? f(0, 90) : money(l.discount_amount),
    gstRateBp: f(toBp(l.gst_rate_percent.value), c(l.gst_rate_percent)),
    taxablePaise: money(l.taxable_value),
    totalPaise: money(l.line_total),
    batchNo: f(l.batch_number.value, c(l.batch_number)),
    expiryDate: f(l.expiry_date.value && /^\d{4}-\d{2}-\d{2}$/.test(l.expiry_date.value) ? l.expiry_date.value : null, c(l.expiry_date)),
    mrpPaise: money(l.mrp),
  }));
  if (a.handwritten) d.notes.push("Handwritten bill — check every highlighted value.");
  if (a.language && !/^en/i.test(a.language)) d.notes.push(`Bill language: ${a.language}. Item names were transliterated.`);
  if (!a.is_bill) d.notes.push("This does not look like a bill. Check the file.");
  d.notes.push(...a.notes.slice(0, 5));
  return d;
}

function linesFromText(lines: TextBillLine[], confidence: number): DraftLine[] {
  return lines.map((l) => {
    const qty = toMilli(l.qty);
    const rate = toPaise(l.rate);
    const amount = toPaise(l.amount);
    return {
      ...emptyLine(randomUUID()),
      description: f(l.description, confidence),
      hsn: f(l.hsn, l.hsn ? confidence : 0),
      qtyMilli: f(qty, qty != null ? confidence : 0),
      unit: f(l.unit, l.unit ? confidence : 0),
      ratePaise: f(rate, rate != null ? confidence : 0),
      gstRateBp: f(toBp(l.gstRatePercent), l.gstRatePercent != null ? confidence : 0),
      taxablePaise: f(amount, amount != null ? confidence - 10 : 0),
    };
  });
}

export function draftFromText(t: TextBill, buyerStateCode: string | null, confidence: number): BillDraft {
  const d = emptyDraft(buyerStateCode);
  d.supplierName = f(t.supplierName, t.supplierName ? confidence - 15 : 0);
  d.supplierGstin = f(t.supplierGstin, t.supplierGstin ? confidence + 10 : 0);
  d.invoiceNo = f(t.invoiceNo, t.invoiceNo ? confidence : 0);
  d.invoiceDate = f(t.invoiceDate, t.invoiceDate ? confidence : 0);
  d.totals.taxablePaise = f(toPaise(t.taxable), t.taxable != null ? confidence : 0);
  d.totals.cgstPaise = f(toPaise(t.cgst), t.cgst != null ? confidence : 0);
  d.totals.sgstPaise = f(toPaise(t.sgst), t.sgst != null ? confidence : 0);
  d.totals.igstPaise = f(toPaise(t.igst), t.igst != null ? confidence : 0);
  d.totals.totalPaise = f(toPaise(t.total), t.total != null ? confidence : 0);
  d.lines = linesFromText(t.lines, confidence);
  return d;
}

/** Overlays the signed QR's header: those fields are what the GST system recorded. */
export function applySignedQr(d: BillDraft, qr: SignedQrPayload, verified: boolean | null): void {
  d.einvoice = { irn: qr.irn, sellerGstin: qr.sellerGstin, docNo: qr.docNo, docDate: qr.docDate, totalPaise: qr.totalPaise, signatureVerified: verified };
  d.irn = qr.irn;
  d.supplierGstin = f(qr.sellerGstin);
  d.invoiceNo = f(qr.docNo);
  d.invoiceDate = f(qr.docDate);
  if (d.totals.totalPaise.value == null || d.totals.totalPaise.confidence < 100) d.totals.totalPaise = f(qr.totalPaise);
  d.notes.push(`E-invoice QR found (IRN ${qr.irn.slice(0, 12)}…)${verified === true ? ", signature verified" : verified === false ? " — signature did NOT verify" : ""}: supplier GSTIN, number, date and total taken from it.`);
}

/* ------------------------------------------------------------- dispatch */

function looksLikeJson(file: ExtractInputFile): boolean {
  return file.contentType === "application/json" || file.bytes.subarray(0, 200).toString("utf8").trimStart().startsWith("{") || file.bytes.subarray(0, 200).toString("utf8").trimStart().startsWith("[");
}

function isSheet(file: ExtractInputFile): boolean {
  return file.contentType.includes("spreadsheet") || file.contentType.includes("excel") || file.contentType === "text/csv" || /\.(xlsx|xls|csv)$/i.test(file.name ?? "");
}

async function qrFrom(files: ExtractInputFile[]): Promise<SignedQrPayload | null> {
  for (const file of files) {
    const codes = file.contentType === "application/pdf" ? await findQrCodesInPdf(file.bytes) : file.contentType.startsWith("image/") ? await findQrCodes(file.bytes) : [];
    for (const code of codes) {
      const decoded = decodeSignedQr(code);
      if (decoded) {
        const key = process.env.EINVOICE_QR_PUBLIC_KEY?.replace(/\\n/g, "\n");
        const verified = key ? verifySignedQr(code, key) : null;
        return Object.assign(decoded.payload, { __verified: verified });
      }
    }
  }
  return null;
}

export type Progress = (percent: number, stage: string) => Promise<void>;

export async function extractBill(files: ExtractInputFile[], context: { buyerStateCode: string | null; ownGstin: string | null }, progress: Progress): Promise<ExtractResult> {
  const { buyerStateCode, ownGstin } = context;

  // 1. E-invoice JSON.
  const json = files.find(looksLikeJson);
  if (json) {
    await progress(30, "Reading e-invoice data");
    return { draft: draftFromEinvoice(parseEinvoiceJson(json.bytes.toString("utf8").replace(/^﻿/, "")), buyerStateCode), engine: "EINVOICE_JSON" };
  }

  // Spreadsheets.
  const sheet = files.find(isSheet);
  if (sheet) {
    await progress(30, "Reading the spreadsheet");
    const rows = await readSheet(sheet.bytes, sheetTypeOf(sheet.name ?? "bill.xlsx", sheet.bytes), 2000);
    const parsed = parseBillSheet(rows, ownGstin);
    const d = draftFromText({ ...parsed, taxable: null, cgst: null, sgst: null, igst: null, total: null }, buyerStateCode, 80);
    d.notes.push("Read from the spreadsheet's item table.");
    return { draft: d, engine: "EXCEL" };
  }

  // 2. The signed QR, if the bill has one.
  await progress(20, "Looking for an e-invoice QR code");
  const qr = await qrFrom(files).catch(() => null);
  const verified = qr ? ((qr as SignedQrPayload & { __verified?: boolean | null }).__verified ?? null) : null;

  // 3. AI.
  if (aiExtractionEnabled()) {
    await progress(45, "Reading the bill (AI)");
    try {
      const ai = await extractWithClaude(files.map((x) => ({ bytes: x.bytes, contentType: x.contentType })));
      if (ai) {
        const d = draftFromAi(ai, buyerStateCode);
        if (qr) applySignedQr(d, qr, verified);
        return { draft: d, engine: qr ? "EINVOICE_QR" : "AI" };
      }
    } catch (error) {
      console.warn(`[bill-capture] AI reading failed, using local reading: ${(error as Error).name}: ${(error as Error).message}`.slice(0, 300));
    }
  }

  // 4. Local text: PDF text layer, else OCR of each photo.
  await progress(55, "Reading the text");
  let text = "";
  let engine: ExtractionEngine = "PDF_TEXT";
  let confidence = 60;
  const notes: string[] = [];
  for (const [i, file] of files.entries()) {
    if (file.contentType === "application/pdf") {
      const t = await pdfText(file.bytes).catch(() => "");
      if (t.trim()) text += `\n${t}`;
      else notes.push(`Page ${i + 1}: scanned PDF without text — type the details or upload photos instead.`);
    } else if (file.contentType.startsWith("image/")) {
      engine = "OCR";
      try {
        const r = await ocrImageText(file.bytes);
        text += `\n${r.text}`;
        confidence = Math.min(confidence, Math.max(20, Math.round(r.confidence * 0.7)));
      } catch {
        notes.push(`Page ${i + 1} could not be read on this server — type the details from the photo.`);
      }
    }
    await progress(55 + Math.round((30 * (i + 1)) / files.length), `Reading page ${i + 1} of ${files.length}`);
  }
  if (text.trim() && aiExtractionEnabled()) {
    const ai = await extractTextWithClaude(text).catch(() => null);
    if (ai) {
      const d = draftFromAi(ai, buyerStateCode);
      if (qr) applySignedQr(d, qr, verified);
      d.notes.push(...notes);
      return { draft: d, engine: qr ? "EINVOICE_QR" : "AI" };
    }
  }
  const d = draftFromText(parseBillText(text, ownGstin), buyerStateCode, confidence);
  d.notes.push(...notes);
  if (!text.trim()) d.notes.push("Nothing could be read automatically. Type the details from the bill shown on the left.");
  else d.notes.push("Read on this server without AI: please check every line.");
  if (qr) applySignedQr(d, qr, verified);
  return { draft: d, engine: qr ? "EINVOICE_QR" : text.trim() ? engine : "MANUAL" };
}
