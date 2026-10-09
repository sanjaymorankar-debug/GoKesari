/**
 * Where Module 2 joins the order and refund flows. Each hook runs inside the
 * caller's transaction under its own savepoint, and the callers catch its
 * errors: a sync or GST problem never blocks a delivery or a refund. A job
 * that failed to queue is found by the safety-net sweep (sweep.ts).
 */
import type { DbClient } from "@/server/db";
import { queueEinvoice } from "@/server/gst/einvoice";
import { issueCreditNoteForRefund } from "@/server/gst/credit-notes";
import { issueInvoiceForOrder } from "@/server/services/invoices";
import { enqueueCreditNotePush, enqueueInvoicePush, liveIntegration } from "./jobs";

/**
 * Order DELIVERED (the customer's delivery OTP): the shop's invoice is issued
 * — always when the shop has an accounting connection, which needs a numbered
 * invoice — then queued for the shop's software and, where it applies, for
 * an e-invoice.
 */
export async function onOrderDelivered(orderId: string, shopId: string, tx: DbClient): Promise<void> {
  const integration = await liveIntegration(shopId, tx);
  const invoice = await issueInvoiceForOrder(orderId, tx, { force: Boolean(integration) });
  if (!invoice) return;
  await tx.transaction(async (sp) => {
    await enqueueInvoicePush(invoice, sp);
    await queueEinvoice(invoice, sp);
  });
}

export interface RefundCreditInput {
  orderId: string;
  /** The refund's financial adjustment — one credit note per refund, ever. */
  adjustmentId: string;
  amountPaise: number;
  reason: "REFUND" | "RETURN";
  /** Goods came back to the shop (a return with pickup): stock goes back up in the software. */
  restock: boolean;
  actorId: string | null;
}

/** Refund after delivery: the shop's credit note against its invoice, queued for its software. */
export async function onRefundRecorded(input: RefundCreditInput, tx: DbClient): Promise<void> {
  await tx.transaction(async (sp) => {
    const note = await issueCreditNoteForRefund(
      { orderId: input.orderId, sourceRef: input.adjustmentId, amountPaise: input.amountPaise, reason: input.reason, restock: input.restock, actorId: input.actorId },
      sp,
    );
    if (note) await enqueueCreditNotePush(note, sp);
  });
}
