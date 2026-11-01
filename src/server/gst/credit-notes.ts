/**
 * GST credit notes (Module 2). When money is refunded on an order the shop
 * has already invoiced — a refund after delivery, a return — the shop issues
 * a credit note against that invoice. GoKesari issues it in the refund's own
 * transaction, numbers it in the shop's credit-note series for the financial
 * year, and (Module 2) sends it to the shop's accounting software.
 *
 * Refunds are amounts, not lines, so the credited amount is spread over the
 * invoice lines in proportion to their value (largest remainder, so the parts
 * add up exactly) and each part's tax is worked out of it at the line's rate.
 * Billing v2 (docs/billing §4.5, while billing_v2 is on): a return's note
 * credits only the returned lines, in proportion to the quantity returned,
 * and never more than those lines were sold for.
 * The total credited on an invoice never exceeds the invoice; the refund's
 * own key (`source_ref`) is unique, so one refund never makes two notes.
 * Cancellations before delivery have no invoice and need no credit note.
 */
import { and, eq, sql } from "drizzle-orm";

import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { stateLabel } from "@/lib/gst-states";
import { db, type DbClient } from "@/server/db";
import { creditNoteCounters, creditNotes, orderItems, returnItems, shops, taxInvoices, type CreditNote } from "@/server/db/schema";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { amountInWords, financialYearOf, lineTax, type InvoiceLine, type InvoiceSnapshot } from "@/server/services/invoices";
import { documentNumbering, formatDocumentNumber } from "./rules";

export interface CreditNoteLine extends InvoiceLine {
  /** The invoice line's position (1-based) this credits. */
  invoiceLineNo: number;
}

export interface CreditNoteSnapshot {
  creditNoteNumber: string;
  financialYear: string;
  issuedAt: string;
  reason: CreditNote["reason"];
  restock: boolean;
  againstInvoice: { id: string; number: string; issuedAt: string; kind: InvoiceSnapshot["kind"] };
  orderNumber: string;
  supplyType: InvoiceSnapshot["supplyType"];
  seller: InvoiceSnapshot["seller"];
  buyer: InvoiceSnapshot["buyer"];
  placeOfSupply: string;
  lines: CreditNoteLine[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; cessPaise?: number };
  note: string;
}

/** Splits `amount` over `weights` in proportion, in whole paise, adding up exactly. */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (amount * w) / total);
  const parts = exact.map(Math.floor);
  let left = amount - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts;
}

export interface IssueCreditNoteInput {
  orderId: string;
  /** The refund's unique reference (the financial adjustment id). */
  sourceRef: string;
  /** Amount refunded to the customer; only the part within the invoice is credited. */
  amountPaise: number;
  reason: CreditNote["reason"];
  /** Goods came back to the shop. */
  restock: boolean;
  actorId?: string | null;
  /** Billing v2: the return being refunded — its items decide which lines are credited. */
  returnId?: string | null;
}

/**
 * Weight of each invoice line in a return's credit: the line's value times
 * the share of its quantity that came back (by listing). Null when the return
 * names no invoiced line (the note is then spread over all lines, as before).
 */
export function returnedLineWeights(
  lines: Pick<InvoiceLine, "grossPaise" | "shopProductId" | "qty">[],
  returned: { shopProductId: string | null; quantityMilli: number }[],
): number[] | null {
  const left = new Map<string, number>();
  for (const r of returned) if (r.shopProductId) left.set(r.shopProductId, (left.get(r.shopProductId) ?? 0) + r.quantityMilli);
  const weights = lines.map((line) => {
    if (!line.shopProductId || !left.has(line.shopProductId)) return 0;
    const lineMilli = Math.round((line.qty ?? 0) * 1000);
    if (lineMilli <= 0) return line.grossPaise;
    const take = Math.min(left.get(line.shopProductId)!, lineMilli);
    left.set(line.shopProductId, left.get(line.shopProductId)! - take);
    return Math.round((line.grossPaise * take) / lineMilli);
  });
  return weights.some((w) => w > 0) ? weights : null;
}

/** Issues the credit note for a refund, or returns the one already issued for it. Null when the order has no invoice. */
export async function issueCreditNoteForRefund(input: IssueCreditNoteInput, client: DbClient = db): Promise<CreditNote | null> {
  const existing = await client.query.creditNotes.findFirst({ where: eq(creditNotes.sourceRef, input.sourceRef) });
  if (existing) return existing;
  const [invoice] = await client.select().from(taxInvoices).where(eq(taxInvoices.orderId, input.orderId)).for("update");
  if (!invoice) return null;
  const [{ credited }] = await client
    .select({ credited: sql<number>`coalesce(sum(${creditNotes.totalPaise}), 0)::bigint` })
    .from(creditNotes)
    .where(eq(creditNotes.taxInvoiceId, invoice.id));
  let amount = Math.min(input.amountPaise, invoice.totalPaise - Number(credited));
  if (amount <= 0) return null;

  const inv = invoice.snapshot as unknown as InvoiceSnapshot;
  let weights = inv.lines.map((l) => l.grossPaise);
  if (input.returnId && (await isFeatureEnabledForShop("billing_v2", invoice.shopId))) {
    const returned = await client
      .select({ shopProductId: orderItems.shopProductId, quantityMilli: returnItems.quantityMilli })
      .from(returnItems)
      .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
      .where(eq(returnItems.returnId, input.returnId));
    const byLine = returnedLineWeights(inv.lines, returned);
    if (byLine) {
      weights = byLine;
      amount = Math.min(amount, byLine.reduce((s, w) => s + w, 0));
    }
  }
  const parts = allocate(amount, weights);
  const lines: CreditNoteLine[] = [];
  inv.lines.forEach((line, index) => {
    const gross = parts[index];
    if (gross <= 0) return;
    const fraction = gross / line.grossPaise;
    lines.push({
      ...line,
      invoiceLineNo: index + 1,
      grossPaise: gross,
      ...lineTax(gross, line.rateBp, line.cessBp ?? 0, inv.supplyType),
      qty: line.qty != null ? Math.round(line.qty * fraction * 1000) / 1000 : undefined,
      quantity: fraction >= 0.9999 ? line.quantity : `${(fraction * 100).toFixed(1)}% of ${line.quantity}`,
    });
  });
  const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "grossPaise") => lines.reduce((s, l) => s + l[k], 0);

  const issuedAt = new Date();
  const financialYear = financialYearOf(issuedAt);
  const [shop] = await client.select({ registrationNumber: shops.registrationNumber }).from(shops).where(eq(shops.id, invoice.shopId));
  const [counter] = await client
    .insert(creditNoteCounters)
    .values({ shopId: invoice.shopId, financialYear, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [creditNoteCounters.shopId, creditNoteCounters.financialYear],
      set: { lastNumber: sql`${creditNoteCounters.lastNumber} + 1` },
    })
    .returning();
  const number = formatDocumentNumber(await documentNumbering(issuedAt, client), "CREDIT_NOTE", shop.registrationNumber, financialYear, counter.lastNumber);
  const snapshot: CreditNoteSnapshot = {
    creditNoteNumber: number,
    financialYear,
    issuedAt: issuedAt.toISOString(),
    reason: input.reason,
    restock: input.restock,
    againstInvoice: { id: invoice.id, number: invoice.invoiceNumber, issuedAt: invoice.issuedAt.toISOString(), kind: inv.kind },
    orderNumber: inv.orderNumber,
    supplyType: inv.supplyType,
    seller: inv.seller,
    buyer: inv.buyer,
    placeOfSupply: inv.placeOfSupply,
    lines,
    totals: {
      taxablePaise: sum("taxablePaise"),
      cgstPaise: sum("cgstPaise"),
      sgstPaise: sum("sgstPaise"),
      igstPaise: sum("igstPaise"),
      totalPaise: sum("grossPaise"),
      ...(lines.some((l) => l.cessPaise) ? { cessPaise: lines.reduce((s, l) => s + (l.cessPaise ?? 0), 0) } : {}),
    },
    note:
      input.reason === "RETURN"
        ? "Goods returned by the customer."
        : "Amount refunded to the customer after delivery.",
  };
  const [note] = await client
    .insert(creditNotes)
    .values({
      shopId: invoice.shopId,
      orderId: input.orderId,
      taxInvoiceId: invoice.id,
      creditNoteNumber: number,
      financialYear,
      sequence: counter.lastNumber,
      reason: input.reason,
      restock: input.restock,
      sourceRef: input.sourceRef,
      taxablePaise: snapshot.totals.taxablePaise,
      cgstPaise: snapshot.totals.cgstPaise,
      sgstPaise: snapshot.totals.sgstPaise,
      igstPaise: snapshot.totals.igstPaise,
      totalPaise: snapshot.totals.totalPaise,
      snapshot: snapshot as unknown as Record<string, unknown>,
      issuedAt,
    })
    .returning();
  await recordAudit(
    {
      actorId: input.actorId ?? null,
      action: AUDIT_ACTIONS.CREDIT_NOTE_ISSUED,
      entityType: "order",
      entityId: input.orderId,
      newValue: { creditNoteNumber: number, againstInvoice: invoice.invoiceNumber, totalPaise: note.totalPaise, reason: input.reason, sourceRef: input.sourceRef },
    },
    client,
  );
  return note;
}

export async function getCreditNote(id: string): Promise<CreditNote | null> {
  return (await db.query.creditNotes.findFirst({ where: eq(creditNotes.id, id) })) ?? null;
}

export async function creditNotesForInvoice(invoiceId: string): Promise<CreditNote[]> {
  return db.select().from(creditNotes).where(and(eq(creditNotes.taxInvoiceId, invoiceId)));
}

/* ------------------------------------------------------------------- PDF */

const money = (paise: number) => formatPaise(paise).replace("₹", "Rs. ");
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export function creditNoteTextLines(s: CreditNoteSnapshot): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (left: string, right: string) => add(left + right.padStart(Math.max(1, W - left.length)));
  const rule = "-".repeat(W);
  // Against a bill of supply there is no tax to reverse: the document says so.
  add(s.againstInvoice.kind === "BILL_OF_SUPPLY" ? "CREDIT NOTE (against bill of supply)" : "CREDIT NOTE", true);
  pair(`Credit note no: ${s.creditNoteNumber}`, `Date: ${fmtDate(s.issuedAt)}`);
  pair(`Against invoice: ${s.againstInvoice.number}`, `Invoice date: ${fmtDate(s.againstInvoice.issuedAt)}`);
  add(`Order no: ${s.orderNumber}   Reason: ${s.note}`);
  add(rule);
  add("ISSUED BY", true);
  add(s.seller.legalName);
  add(s.seller.address.slice(0, W));
  add(s.seller.gstin ? `GSTIN: ${s.seller.gstin}` : "Not GST-registered");
  add();
  add("TO", true);
  add(s.buyer.name);
  add(s.buyer.address.slice(0, W));
  if (s.buyer.gstin) add(`GSTIN: ${s.buyer.gstin}`);
  add(`Place of supply: ${stateLabel(s.placeOfSupply) ?? s.placeOfSupply}   Reverse charge: No`);
  add(rule);
  for (const [i, l] of s.lines.entries()) {
    const tax = l.cgstPaise + l.sgstPaise + l.igstPaise;
    add(`${String(i + 1).padEnd(3)}${l.description.slice(0, 34).padEnd(35)}${(l.hsn ?? "-").padEnd(9)}${money(l.taxablePaise).padStart(12)}${money(tax).padStart(11)}${money(l.grossPaise).padStart(12)}`.slice(0, W));
  }
  add(rule);
  pair("Taxable value", money(s.totals.taxablePaise));
  if (s.supplyType === "INTRA") {
    pair("CGST", money(s.totals.cgstPaise));
    pair("SGST", money(s.totals.sgstPaise));
  } else pair("IGST", money(s.totals.igstPaise));
  if (s.totals.cessPaise) pair("Cess", money(s.totals.cessPaise));
  pair("Credit note total", money(s.totals.totalPaise));
  add(amountInWords(s.totals.totalPaise));
  add();
  add(`For ${s.seller.legalName}`);
  add("Authorised signatory (electronically issued)");
  return out;
}

export function renderCreditNotePdf(note: CreditNote): Buffer {
  const s = note.snapshot as unknown as CreditNoteSnapshot;
  return textPdf(creditNoteTextLines(s), { title: `Credit note ${s.creditNoteNumber}` });
}
