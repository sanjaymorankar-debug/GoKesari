/**
 * GoKesari's tax invoices and credit notes in the canonical form (Module 2),
 * built when a push job runs — not when it is queued — so a product matched
 * after a failed attempt is picked up by the retry.
 */
import { and, eq, inArray } from "drizzle-orm";

import { gstState } from "@/lib/gst-states";
import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { creditNotes, integrationItemLinks, taxInvoices, type CreditNote, type TaxInvoice } from "@/server/db/schema";
import type { CreditNoteSnapshot } from "@/server/gst/credit-notes";
import { istDate } from "@/server/gst/rules";
import type { InvoiceLine, InvoiceSnapshot } from "@/server/services/invoices";
import { uqcFor, type CanonicalCreditNote, type CanonicalInvoice, type CanonicalLine } from "./canonical";

export interface MappedItem {
  externalId: string;
  unit: string | null;
}

/** Matched shop-software items for these listings. */
export async function mappingFor(integrationId: string, shopProductIds: string[]): Promise<Map<string, MappedItem>> {
  const ids = shopProductIds.filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ shopProductId: integrationItemLinks.shopProductId, externalId: integrationItemLinks.externalId, unit: integrationItemLinks.externalUnit })
    .from(integrationItemLinks)
    .where(
      and(
        eq(integrationItemLinks.integrationId, integrationId),
        eq(integrationItemLinks.matchStatus, "MATCHED"),
        inArray(integrationItemLinks.shopProductId, ids),
      ),
    );
  return new Map(rows.map((r) => [r.shopProductId!, { externalId: r.externalId, unit: r.unit }]));
}

/** Numeric quantity and unit of an invoice line ("2.5 kg" for lines issued before Module 2). */
function quantityOf(line: InvoiceLine): { qty: number; unit: string } {
  if (line.qty != null && line.unit) return { qty: line.qty, unit: line.unit };
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(line.quantity);
  return { qty: m ? Number(m[1]) || 1 : 1, unit: (m?.[2] || "NOS").trim() || "NOS" };
}

function toLines(lines: InvoiceLine[], mapping: Map<string, MappedItem>): CanonicalLine[] {
  return lines.map((line, index) => {
    const { qty, unit } = quantityOf(line);
    const mapped = line.shopProductId ? mapping.get(line.shopProductId) : undefined;
    const quantity = qty > 0 ? qty : 1;
    return {
      lineNo: index + 1,
      shopProductId: line.shopProductId ?? null,
      externalItemId: mapped?.externalId ?? null,
      name: line.description,
      hsn: line.hsn,
      quantity,
      // The software's own unit name when the item is matched (Tally needs it).
      unit: mapped?.unit ?? unit,
      uqc: line.uqc ?? uqcFor(unit),
      ratePaise: Math.round(line.taxablePaise / quantity),
      taxablePaise: line.taxablePaise,
      gstRateBp: line.rateBp,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
      cessPaise: 0,
      totalPaise: line.grossPaise,
    };
  });
}

const stateCode = (raw: string | null | undefined) => gstState(raw)?.code ?? null;

function parties(s: Pick<InvoiceSnapshot, "seller" | "buyer" | "placeOfSupply">) {
  return {
    seller: { name: s.seller.legalName, gstin: s.seller.gstin, stateCode: stateCode(s.seller.gstin ?? s.seller.stateCode), address: s.seller.address },
    buyer: { name: s.buyer.name, gstin: s.buyer.gstin, stateCode: stateCode(s.buyer.gstin ?? s.placeOfSupply), address: s.buyer.address },
    placeOfSupply: stateCode(s.placeOfSupply),
  };
}

export function invoiceToCanonical(invoice: TaxInvoice, mapping: Map<string, MappedItem>): CanonicalInvoice {
  const s = invoice.snapshot as unknown as InvoiceSnapshot;
  return {
    id: invoice.id,
    number: invoice.invoiceNumber,
    date: istDate(invoice.issuedAt),
    ...parties(s),
    supplyType: s.supplyType,
    kind: s.kind,
    reverseCharge: false,
    lines: toLines(s.lines, mapping),
    totals: {
      taxablePaise: s.totals.taxablePaise,
      cgstPaise: s.totals.cgstPaise,
      sgstPaise: s.totals.sgstPaise,
      igstPaise: s.totals.igstPaise,
      cessPaise: 0,
      roundOffPaise: 0,
      totalPaise: s.totals.totalPaise,
    },
    orderNumber: s.orderNumber,
  };
}

export function creditNoteToCanonical(note: CreditNote, mapping: Map<string, MappedItem>): CanonicalCreditNote {
  const s = note.snapshot as unknown as CreditNoteSnapshot;
  return {
    id: note.id,
    number: note.creditNoteNumber,
    date: istDate(note.issuedAt),
    ...parties(s),
    supplyType: s.supplyType,
    kind: s.againstInvoice.kind,
    reverseCharge: false,
    lines: toLines(s.lines, mapping),
    totals: {
      taxablePaise: s.totals.taxablePaise,
      cgstPaise: s.totals.cgstPaise,
      sgstPaise: s.totals.sgstPaise,
      igstPaise: s.totals.igstPaise,
      cessPaise: 0,
      roundOffPaise: 0,
      totalPaise: s.totals.totalPaise,
    },
    orderNumber: s.orderNumber,
    reason: note.reason,
    restock: note.restock,
    againstInvoice: { id: s.againstInvoice.id, number: s.againstInvoice.number, date: istDate(new Date(s.againstInvoice.issuedAt)) },
  };
}

/** The canonical document a push job sends, from the current invoice / credit note and mapping. */
export async function buildPushDocument(
  integrationId: string,
  kind: "PUSH_INVOICE" | "PUSH_CREDIT_NOTE",
  subjectId: string,
): Promise<CanonicalInvoice | CanonicalCreditNote> {
  if (kind === "PUSH_INVOICE") {
    const invoice = await db.query.taxInvoices.findFirst({ where: eq(taxInvoices.id, subjectId) });
    if (!invoice) throw notFound("Invoice");
    const lines = (invoice.snapshot as unknown as InvoiceSnapshot).lines;
    return invoiceToCanonical(invoice, await mappingFor(integrationId, lines.map((l) => l.shopProductId ?? "")));
  }
  const note = await db.query.creditNotes.findFirst({ where: eq(creditNotes.id, subjectId) });
  if (!note) throw notFound("Credit note");
  const lines = (note.snapshot as unknown as CreditNoteSnapshot).lines;
  return creditNoteToCanonical(note, await mappingFor(integrationId, lines.map((l) => l.shopProductId ?? "")));
}
