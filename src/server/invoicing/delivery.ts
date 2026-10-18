/**
 * F9.2.6 (NEW-037) — the customer's GST invoice, complete (batch-2026-10 WS-E).
 *
 * Extends NEW-007 (services/invoices.ts) without changing it while rule
 * invoiceDelivery is off:
 *
 *   - place of supply = the delivery address's state (its PIN code when the
 *     address has no state); the shop's state for a pickup; when truly
 *     unknown, the shop's state, and the invoice says it was assumed
 *     (resolvePlaceOfSupply — used by buildSnapshot);
 *   - wording for a supplier without GSTIN: unregistered / PAN-only, or a
 *     composition dealer (sellerRegistrationNotes);
 *   - a QR code drawn on the PDF: the e-invoice's signed QR when an IRN
 *     exists, else a B2C QR (invoiceQrPayload);
 *   - the PDF emailed to the customer and a copy (notification + PDF) to the
 *     shop owner with the order (onInvoiceIssued);
 *   - a credit note when an invoiced order ends up refunded / cancelled
 *     without refunds having credited all of it (creditNoteOnOrderReversal).
 *
 * Tax rates stay where NEW-007 reads them (shop listing → master product →
 * dated hsn_tax_rates → invoicing.defaultGstRateBp): nothing is hard-coded.
 */
import { eq } from "drizzle-orm";

import { gstState } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { textPdf } from "@/lib/pdf";
import { qrMatrix } from "@/lib/qr";
import { getEnv } from "@/lib/env";
import { db, type DbClient } from "@/server/db";
import { shops, taxInvoices, type CreditNote, type TaxInvoice } from "@/server/db/schema";
import { queueDocumentEmail, safeName } from "@/server/documents/email";
import { emitEvent } from "@/server/events/emit";
import { issueCreditNoteForRefund } from "@/server/gst/credit-notes";
import { einvoiceFor, invoiceTextLines, renderInvoicePdf, type InvoiceSnapshot } from "@/server/services/invoices";
import { getRule } from "@/server/services/settings";

export {
  PLACE_OF_SUPPLY_NOTE,
  resolvePlaceOfSupply,
  sellerRegistrationNotes,
  sellerRegistrationOf,
  type PlaceOfSupplySource,
  type SellerRegistration,
} from "./place-of-supply";

/* -------------------------------------------------------------------- QR */

const rupees = (paise: number) => (paise / 100).toFixed(2);
const dmy = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
};

/**
 * B2C invoice QR (no IRN): the fields the dynamic-QR notification lists for
 * B2C invoices — supplier GSTIN (or "URP" + PAN for an unregistered supplier),
 * invoice number and date, invoice value and the tax amounts — plus the
 * place of supply, the order number (payment was made on GoKesari before the
 * invoice, so it cross-references the payment) and a link to check the
 * invoice. Plain "key:value|…" text so any QR reader shows it.
 */
export function invoiceQrPayload(s: InvoiceSnapshot, invoiceId: string, baseUrl = getEnv().AUTH_URL ?? "https://gokesari.com"): string {
  const parts = [
    `SellerGSTIN:${s.seller.gstin ?? "URP"}`,
    ...(s.seller.gstin ? [] : s.seller.panMasked ? [`SellerPAN:${s.seller.panMasked}`] : []),
    `SellerName:${s.seller.legalName.slice(0, 60)}`,
    `DocType:${s.kind === "TAX_INVOICE" ? "INV" : "BOS"}`,
    `DocNo:${s.invoiceNumber}`,
    `DocDt:${dmy(s.issuedAt)}`,
    `TotInvVal:${rupees(s.totals.totalPaise)}`,
    `TaxableVal:${rupees(s.totals.taxablePaise)}`,
    `CGST:${rupees(s.totals.cgstPaise)}`,
    `SGST:${rupees(s.totals.sgstPaise)}`,
    `IGST:${rupees(s.totals.igstPaise)}`,
    `Cess:0.00`,
    `POS:${gstState(s.placeOfSupply)?.code ?? s.placeOfSupply}`,
    `OrderNo:${s.orderNumber}`,
    `PaidVia:GoKesari`,
    `Verify:${baseUrl.replace(/\/$/, "")}/invoices/${invoiceId}`,
  ];
  return parts.join("|");
}

/* ------------------------------------------------------------------- PDF */

/**
 * The invoice PDF as the customer and the shop get it. With rule
 * invoiceDelivery off (or qrOnPdf off) it is exactly NEW-007's PDF.
 */
export async function renderInvoiceDocument(invoice: TaxInvoice): Promise<Buffer> {
  const extras = await getRule("invoiceDelivery");
  const einvoice = await einvoiceFor(invoice.id);
  const plain = einvoice ? { irn: einvoice.irn, ackNo: einvoice.ackNo, ackDate: einvoice.ackDate } : null;
  if (!extras.enabled || !extras.qrOnPdf) return renderInvoicePdf(invoice, plain);
  const s: InvoiceSnapshot = { ...(invoice.snapshot as unknown as InvoiceSnapshot), einvoice: plain ?? undefined };
  const signed = einvoice?.signedQr ?? null;
  const qr = qrMatrix(signed ?? invoiceQrPayload(s, invoice.id));
  return textPdf(invoiceTextLines(s), {
    title: `Invoice ${s.invoiceNumber}`,
    qr: {
      ...qr,
      caption: signed
        ? ["E-invoice QR (signed by the IRP)", `IRN ${einvoice!.irn.slice(0, 32)}`, einvoice!.irn.slice(32)]
        : ["Invoice QR code", `${s.invoiceNumber}  ${dmy(s.issuedAt)}`, `Value Rs. ${rupees(s.totals.totalPaise)}`, "Scan to check this invoice on GoKesari."],
    },
  });
}

export async function renderInvoiceDocumentById(invoiceId: string): Promise<{ pdf: Buffer; filename: string } | null> {
  const invoice = await db.query.taxInvoices.findFirst({ where: eq(taxInvoices.id, invoiceId) });
  if (!invoice) return null;
  return { pdf: await renderInvoiceDocument(invoice), filename: `${safeName(invoice.invoiceNumber)}.pdf` };
}

/* -------------------------------------------------------------- delivery */

/**
 * Inside the issuing transaction (services/invoices.ts): email the PDF to the
 * customer, and give the shop owner a copy with the order — in the app now
 * (event layer) and by email with the PDF. Nothing while the rule is off.
 */
export async function onInvoiceIssued(
  invoice: TaxInvoice,
  order: { id: string; orderNumber: string; userId: string; shopId: string },
  client: DbClient,
): Promise<void> {
  const extras = await getRule("invoiceDelivery");
  if (!extras.enabled) return;
  const title = `Invoice ${invoice.invoiceNumber}`;
  if (extras.emailCustomer) {
    await queueDocumentEmail(
      {
        docType: "TAX_INVOICE",
        docId: invoice.id,
        userId: order.userId,
        recipientRole: "CUSTOMER",
        title: `Your invoice for order ${order.orderNumber}`,
        body: `${title} (${formatPaise(invoice.totalPaise)}) for your GoKesari order ${order.orderNumber} is attached as a PDF. You can also download it from your orders.`,
        actionUrl: `/invoices/${invoice.id}`,
        category: "ORDERS",
        maxAttempts: extras.emailMaxAttempts,
      },
      client,
    );
  }
  if (extras.copyToShopOwner) {
    const [shop] = await client.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, order.shopId));
    if (!shop) return;
    await emitEvent(
      {
        type: "invoice.shop_copy",
        subjectId: invoice.id,
        orderId: order.id,
        payload: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          orderNumber: order.orderNumber,
          ownerId: shop.ownerId,
          amount: formatPaise(invoice.totalPaise),
        },
        idempotencyKey: `invoice-shop-copy:${invoice.id}`,
      },
      client,
    );
    await queueDocumentEmail(
      {
        docType: "TAX_INVOICE",
        docId: invoice.id,
        userId: shop.ownerId,
        recipientRole: "SHOP_OWNER",
        title: `Copy: ${title} for order ${order.orderNumber}`,
        body: `${shop.name}: order ${order.orderNumber} was delivered and ${title} (${formatPaise(invoice.totalPaise)}) was issued to the customer in your shop's name. Your copy is attached.`,
        actionUrl: `/invoices/${invoice.id}`,
        category: "SHOP",
        maxAttempts: extras.emailMaxAttempts,
      },
      client,
    );
  }
}

/**
 * An invoiced order that ends REFUNDED (cancelled after delivery, a full
 * refund outside refundDeliveredOrder, WS-C's refunds) gets a CANCELLATION
 * credit note for whatever earlier credit notes did not already cover. One
 * per order, ever; nothing when the order has no invoice (cancelled before
 * delivery) or everything is already credited. Runs under a savepoint.
 *
 * Refund flows that know their amount call issueCreditNoteForRefund
 * (gst/credit-notes.ts) directly — unchanged signature — with their own
 * refund id as sourceRef, reason REFUND / RETURN / CANCELLATION.
 */
export async function creditNoteOnOrderReversal(orderId: string, actorId: string | null, client: DbClient = db): Promise<CreditNote | null> {
  const extras = await getRule("invoiceDelivery");
  if (!extras.enabled || !extras.creditNoteOnCancellation) return null;
  return client.transaction(async (sp) => {
    const [invoice] = await sp.select({ id: taxInvoices.id, totalPaise: taxInvoices.totalPaise }).from(taxInvoices).where(eq(taxInvoices.orderId, orderId));
    if (!invoice) return null;
    const note = await issueCreditNoteForRefund(
      { orderId, sourceRef: `order-reversal:${orderId}`, amountPaise: invoice.totalPaise, reason: "CANCELLATION", restock: false, actorId },
      sp,
    );
    // Module 2: like a refund's note, it goes to the shop's accounting software when connected.
    if (note) {
      const { enqueueCreditNotePush } = await import("@/server/integrations/jobs");
      await enqueueCreditNotePush(note, sp);
    }
    return note;
  });
}
