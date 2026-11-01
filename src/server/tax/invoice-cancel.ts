/**
 * Cancelling a shop's tax invoice (billing v2, docs/billing §4.2). The invoice
 * is never deleted or renumbered: it is marked CANCELLED with who, when and
 * why, its number stays used, and GSTR-1 counts it in Table 13 as cancelled
 * and leaves it out of the supplies. Refused when a credit note was already
 * issued against it (the supply stands; credit it instead) or while it has a
 * live e-invoice (the IRN must be cancelled on the IRP first).
 */
import { and, eq, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { creditNotes, einvoiceRecords, taxInvoices, type TaxInvoice, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export async function cancelTaxInvoice(invoiceId: string, reason: string, actor: { id: string; role: UserRole }): Promise<TaxInvoice> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can cancel an invoice.");
  const why = reason.trim();
  if (why.length < 5) throw validationFailed("Say why the invoice is cancelled.", { fields: { reason: "At least 5 characters." } });
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(taxInvoices).where(eq(taxInvoices.id, invoiceId)).for("update");
    if (!invoice) throw notFound("Invoice");
    if (invoice.status === "CANCELLED") return invoice;
    const [{ notes }] = await tx.select({ notes: sql<number>`count(*)::int` }).from(creditNotes).where(eq(creditNotes.taxInvoiceId, invoiceId));
    if (notes > 0) throw conflict("A credit note was already issued against this invoice: issue another credit note instead of cancelling it.");
    const [irn] = await tx
      .select({ id: einvoiceRecords.id })
      .from(einvoiceRecords)
      .where(and(eq(einvoiceRecords.taxInvoiceId, invoiceId), eq(einvoiceRecords.status, "GENERATED")));
    if (irn) throw conflict("This invoice has an e-invoice (IRN): cancel the IRN first (within 24 hours of generation), or issue a credit note.");
    const [updated] = await tx
      .update(taxInvoices)
      .set({ status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: why })
      .where(eq(taxInvoices.id, invoiceId))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.INVOICE_CANCELLED,
        entityType: "tax_invoice",
        entityId: invoiceId,
        previousValue: { status: "ISSUED" },
        newValue: { status: "CANCELLED", invoiceNumber: invoice.invoiceNumber, reason: why },
      },
      tx,
    );
    return updated;
  });
}
