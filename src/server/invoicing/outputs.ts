/**
 * Billing v2 document outputs (docs/billing §4.6): the same GST documents as
 * an 80 mm thermal receipt, as machine-readable JSON, with a UPI payment QR
 * (counter bills) and a WhatsApp share link. The A4 PDF stays the document of
 * record (invoicing/delivery.ts); these are other views of the same snapshot.
 */
import { formatPaise } from "@/lib/money";
import { RECEIPT_LINE_WIDTH, receiptPdf, type PdfLine } from "@/lib/pdf";
import { qrMatrix } from "@/lib/qr";
import { stateLabel } from "@/lib/gst-states";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { shops, type TaxInvoice } from "@/server/db/schema";
import { getSettings } from "@/server/accounts/books";
import { getSalesInvoice } from "@/server/accounts/sales";
import { einvoiceFor, type InvoiceSnapshot } from "@/server/services/invoices";
import { invoiceQrPayload } from "./delivery";

const money = (paise: number) => formatPaise(paise).replace("₹", "Rs.");
const dmy = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata" });

/** "upi://pay?…" — the payee's UPI id, name, amount in rupees, and a note (NPCI linking spec). */
export function upiPaymentUri(input: { vpa: string; payeeName: string; amountPaise: number; note?: string; reference?: string }): string {
  const params = [
    `pa=${encodeURIComponent(input.vpa.trim())}`,
    `pn=${encodeURIComponent(input.payeeName.slice(0, 50))}`,
    `am=${(input.amountPaise / 100).toFixed(2)}`,
    "cu=INR",
    ...(input.note ? [`tn=${encodeURIComponent(input.note.slice(0, 80))}`] : []),
    ...(input.reference ? [`tr=${encodeURIComponent(input.reference.slice(0, 35))}`] : []),
  ];
  return `upi://pay?${params.join("&")}`;
}

/** A WhatsApp "share" link carrying the text (the person picks the chat). No personal data goes in the URL by us. */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** The invoice as 80 mm receipt lines (RECEIPT_LINE_WIDTH characters). */
export function invoiceReceiptLines(s: InvoiceSnapshot): PdfLine[] {
  const W = RECEIPT_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l.slice(0, W - r.length - 1) + r.padStart(Math.max(1, W - Math.min(l.length, W - r.length - 1))));
  const wrap = (text: string) => {
    let rest = text;
    while (rest.length > W) {
      const cut = rest.lastIndexOf(" ", W);
      const at = cut > 0 ? cut : W;
      add(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (rest) add(rest);
  };
  const rule = "-".repeat(W);
  add(s.kind === "TAX_INVOICE" ? "TAX INVOICE" : "BILL OF SUPPLY", true);
  wrap(s.seller.legalName);
  wrap(s.seller.address);
  if (s.seller.gstin) add(`GSTIN ${s.seller.gstin}`);
  if (s.sellerEnrolmentId) add(`Enrolment ID ${s.sellerEnrolmentId}`);
  add(rule);
  add(`No ${s.invoiceNumber}`);
  add(`Date ${dmy(s.issuedAt)}  Order ${s.orderNumber}`);
  wrap(`To ${s.buyer.name}${s.buyer.gstin ? ` GSTIN ${s.buyer.gstin}` : ""}`);
  wrap(`POS ${stateLabel(s.placeOfSupply) ?? s.placeOfSupply}`);
  add(rule);
  for (const l of s.lines) {
    wrap(`${l.description}${l.hsn ? ` (${l.hsn})` : ""}`);
    pair(`  ${l.quantity}${l.uqc ? ` ${l.uqc}` : ""} @${(l.rateBp / 100).toFixed(l.rateBp % 100 ? 2 : 0)}%`, money(l.grossPaise));
  }
  add(rule);
  pair("Taxable", money(s.totals.taxablePaise));
  if (s.supplyType === "INTRA") {
    pair("CGST", money(s.totals.cgstPaise));
    pair("SGST", money(s.totals.sgstPaise));
  } else {
    pair("IGST", money(s.totals.igstPaise));
  }
  if (s.totals.cessPaise) pair("Cess", money(s.totals.cessPaise));
  pair("TOTAL", money(s.totals.totalPaise));
  add(rule);
  if (s.eco) wrap(`Through e-commerce operator ${s.eco.legalName} GSTIN ${s.eco.gstin}`);
  if (s.einvoice) wrap(`IRN ${s.einvoice.irn}`);
  add("Computer-generated; no signature needed.");
  return out;
}

/** The invoice on 80 mm paper, with its QR (the signed e-invoice QR when an IRN exists). */
export async function renderInvoiceReceipt(invoice: TaxInvoice): Promise<Buffer> {
  const einvoice = await einvoiceFor(invoice.id);
  const s: InvoiceSnapshot = {
    ...(invoice.snapshot as unknown as InvoiceSnapshot),
    einvoice: einvoice ? { irn: einvoice.irn, ackNo: einvoice.ackNo, ackDate: einvoice.ackDate } : undefined,
  };
  const qr = qrMatrix(einvoice?.signedQr ?? invoiceQrPayload(s, invoice.id));
  const lines = invoiceReceiptLines(s);
  if (invoice.status === "CANCELLED") lines.unshift({ text: "*** CANCELLED ***", bold: true });
  return receiptPdf(lines, { title: `Invoice ${s.invoiceNumber}`, qr: { ...qr, widthPt: 120, caption: [einvoice ? "E-invoice QR" : "Scan to check this invoice"] } });
}

/**
 * The invoice as JSON (schema "gokesari.invoice/1"): every amount in paise
 * (integers, exact), dates in ISO 8601, states as GST state codes.
 */
export async function invoiceJson(invoice: TaxInvoice): Promise<Record<string, unknown>> {
  const s = invoice.snapshot as unknown as InvoiceSnapshot;
  const einvoice = await einvoiceFor(invoice.id);
  return {
    schema: "gokesari.invoice/1",
    id: invoice.id,
    status: invoice.status,
    documentType: s.kind,
    number: s.invoiceNumber,
    financialYear: s.financialYear,
    issuedAt: s.issuedAt,
    orderNumber: s.orderNumber,
    supplyType: s.supplyType,
    placeOfSupply: s.placeOfSupply,
    reverseCharge: false,
    seller: { name: s.seller.legalName, tradeName: s.seller.name, gstin: s.seller.gstin, enrolmentId: s.sellerEnrolmentId ?? null, stateCode: s.seller.stateCode, address: s.seller.address },
    buyer: { name: s.buyer.name, gstin: s.buyer.gstin, address: s.buyer.address },
    ecommerceOperator: s.eco ?? null,
    lines: s.lines.map((l, i) => ({
      no: i + 1,
      description: l.description,
      hsn: l.hsn,
      quantity: l.qty ?? null,
      unit: l.unit ?? null,
      uqc: l.uqc ?? null,
      gstRateBp: l.rateBp,
      cessRateBp: l.cessBp ?? 0,
      taxablePaise: l.taxablePaise,
      cgstPaise: l.cgstPaise,
      sgstPaise: l.sgstPaise,
      igstPaise: l.igstPaise,
      cessPaise: l.cessPaise ?? 0,
      totalPaise: l.grossPaise,
    })),
    totals: { ...s.totals, cessPaise: s.totals.cessPaise ?? 0 },
    einvoice: einvoice ? { irn: einvoice.irn, ackNo: einvoice.ackNo, ackDate: einvoice.ackDate } : null,
  };
}

/**
 * A counter-sale invoice (accounts/sales.ts) on 80 mm paper, with the shop's
 * UPI payment QR for the amount when the shop has set its UPI id (inv_settings).
 */
export async function salesReceiptPdf(shopId: string, salesId: string): Promise<{ bytes: Buffer; filename: string }> {
  const { invoice, lines } = await getSalesInvoice(shopId, salesId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  const settings = await getSettings(shopId);
  const W = RECEIPT_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l.slice(0, W - r.length - 1).padEnd(W - r.length) + r);
  const legal = shop.legalBusinessName ?? shop.name;
  if (invoice.status === "CANCELLED") add("*** CANCELLED ***", true);
  add(shop.gstin ? "TAX INVOICE" : "BILL OF SUPPLY", true);
  add(legal.slice(0, W));
  add([shop.addressLine1, shop.city, shop.pincode].filter(Boolean).join(", ").slice(0, W));
  if (shop.gstin) add(`GSTIN ${shop.gstin}`);
  add("-".repeat(W));
  add(`No ${invoice.invoiceNo}   ${invoice.invoiceDate}`);
  if (invoice.buyerName) add(`To ${invoice.buyerName}`.slice(0, W));
  if (invoice.buyerGstin) add(`GSTIN ${invoice.buyerGstin}`);
  add("-".repeat(W));
  for (const l of lines) {
    add(`${l.description}${l.hsn ? ` (${l.hsn})` : ""}`.slice(0, W));
    pair(`  ${l.qtyMilli / 1000}${l.unit ? ` ${l.unit}` : ""} @${l.gstRateBp / 100}%`, money(l.totalPaise));
  }
  add("-".repeat(W));
  pair("Taxable", money(invoice.taxablePaise));
  if (invoice.interState) pair("IGST", money(invoice.igstPaise));
  else {
    pair("CGST", money(invoice.cgstPaise));
    pair("SGST", money(invoice.sgstPaise));
  }
  if (invoice.cessPaise) pair("Cess", money(invoice.cessPaise));
  if (invoice.roundOffPaise) pair("Round off", money(invoice.roundOffPaise));
  pair("TOTAL", money(invoice.totalPaise));
  add("Thank you!");
  const upi = settings.upiVpa && invoice.status === "ISSUED"
    ? upiPaymentUri({ vpa: settings.upiVpa, payeeName: legal, amountPaise: invoice.totalPaise, note: `Invoice ${invoice.invoiceNo}`, reference: invoice.invoiceNo })
    : null;
  const bytes = receiptPdf(out, {
    title: `Invoice ${invoice.invoiceNo}`,
    ...(upi ? { qr: { ...qrMatrix(upi), widthPt: 120, caption: [`Pay ${money(invoice.totalPaise)} by UPI`, settings.upiVpa!] } } : {}),
  });
  return { bytes, filename: `${invoice.invoiceNo}-80mm.pdf` };
}
