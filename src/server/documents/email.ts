/**
 * Document emails (batch-2026-10 WS-E): an email that carries a document —
 * the customer's invoice PDF, the shop owner's copy, a payout statement (PDF +
 * CSV), GoKesari's fee invoice to a shop.
 *
 * The notification outbox (notification_deliveries) holds text only, so these
 * get a small outbox of their own with the same discipline: queued inside the
 * business transaction (one row per document and recipient, ever), sent just
 * after commit, a failed send retried with backoff up to max_attempts and then
 * DEAD (audited); no SMTP or no real address → SKIPPED, never an error. The
 * attachment is rendered again at send time from the document's stored
 * snapshot, so nothing large sits in the outbox. Respects the recipient's
 * email opt-out for the category (ORDERS for invoices, SHOP for shop papers).
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { db, type DbClient } from "@/server/db";
import { documentEmails, notificationPreferences, users, type DocumentEmail } from "@/server/db/schema";
import { EmailUnavailableError, emailMode, sendEmail, type EmailAttachment } from "@/server/email/transport";
import { renderEmail } from "@/server/notifications/templates";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const DOCUMENT_TYPES = ["TAX_INVOICE", "CREDIT_NOTE", "PAYOUT_STATEMENT", "PLATFORM_INVOICE"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface QueueDocumentEmailInput {
  docType: DocumentType;
  docId: string;
  userId: string;
  recipientRole: "CUSTOMER" | "SHOP_OWNER";
  title: string;
  body: string;
  /** In-app path the email links to. */
  actionUrl?: string;
  /** Notification category whose email opt-out applies. */
  category: "ORDERS" | "SHOP";
  maxAttempts?: number;
}

/** Queues the email (once per document and recipient). Returns false when it was not queued (opted out, or already queued). */
export async function queueDocumentEmail(input: QueueDocumentEmailInput, client: DbClient = db): Promise<boolean> {
  const [optOut] = await client
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, input.userId),
        eq(notificationPreferences.category, input.category),
        eq(notificationPreferences.channel, "EMAIL"),
      ),
    );
  if (optOut && !optOut.enabled) return false;
  const email = renderEmail({ title: input.title, body: input.body, actionUrl: input.actionUrl, baseUrl: getEnv().AUTH_URL });
  const [row] = await client
    .insert(documentEmails)
    .values({
      docType: input.docType,
      docId: input.docId,
      userId: input.userId,
      recipientRole: input.recipientRole,
      subject: email.subject,
      body: email.text,
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning({ id: documentEmails.id });
  if (!row) return false;
  scheduleDocumentDelivery(client);
  return true;
}

/** Rows queued inside a transaction are visible only after it commits: send a moment later (the cron sweep is the safety net). */
function scheduleDocumentDelivery(client: DbClient): void {
  if (getEnv().NODE_ENV === "test") return; // tests send explicitly with deliverDocumentEmails()
  const run = () => void deliverDocumentEmails().catch((error) => console.error("[document-emails] delivery run failed", error));
  if (client === db) run();
  else setTimeout(run, 2_000).unref?.();
}

/* ------------------------------------------------------------ renderers */

export interface RenderedDocument {
  attachments: EmailAttachment[];
}

/** Renders a document's attachments by type. Lazy imports keep this module free of the services' dependency graph. */
export async function renderDocumentAttachments(docType: string, docId: string): Promise<RenderedDocument | null> {
  switch (docType) {
    case "TAX_INVOICE": {
      const { renderInvoiceDocumentById } = await import("@/server/invoicing/delivery");
      const doc = await renderInvoiceDocumentById(docId);
      return doc ? { attachments: [{ filename: doc.filename, content: doc.pdf, contentType: "application/pdf" }] } : null;
    }
    case "CREDIT_NOTE": {
      const { getCreditNote, renderCreditNotePdf } = await import("@/server/gst/credit-notes");
      const note = await getCreditNote(docId);
      if (!note) return null;
      return { attachments: [{ filename: `${safeName(note.creditNoteNumber)}.pdf`, content: renderCreditNotePdf(note), contentType: "application/pdf" }] };
    }
    case "PAYOUT_STATEMENT": {
      const { renderPayoutStatement } = await import("@/server/payouts/statements");
      const doc = await renderPayoutStatement(docId);
      if (!doc) return null;
      return {
        attachments: [
          { filename: `${doc.basename}.pdf`, content: doc.pdf, contentType: "application/pdf" },
          { filename: `${doc.basename}.csv`, content: Buffer.from(doc.csv, "utf8"), contentType: "text/csv" },
        ],
      };
    }
    case "PLATFORM_INVOICE": {
      const { renderPlatformInvoiceById } = await import("@/server/platform-invoices/service");
      const doc = await renderPlatformInvoiceById(docId);
      return doc ? { attachments: [{ filename: doc.filename, content: doc.pdf, contentType: "application/pdf" }] } : null;
    }
    default:
      return null;
  }
}

export const safeName = (value: string) => value.replace(/[^A-Za-z0-9-]+/g, "_");

/* ------------------------------------------------------------- delivery */

const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

/**
 * Sends due document emails (PENDING / FAILED whose time has come). Rows are
 * claimed with SKIP LOCKED so overlapping runs never send one twice; a row
 * stuck in SENDING for 10 minutes (process died) is retried.
 */
export async function deliverDocumentEmails(options: { limit?: number } = {}): Promise<{ sent: number; failed: number; skipped: number; dead: number }> {
  const tally = { sent: 0, failed: 0, skipped: 0, dead: 0 };
  await db
    .update(documentEmails)
    .set({ status: "FAILED", lastError: "Interrupted while sending", updatedAt: new Date() })
    .where(and(eq(documentEmails.status, "SENDING"), lte(documentEmails.updatedAt, sql`now() - interval '10 minutes'`)));
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: documentEmails.id })
      .from(documentEmails)
      .where(and(inArray(documentEmails.status, ["PENDING", "FAILED"]), lte(documentEmails.nextAttemptAt, sql`now()`)))
      .orderBy(documentEmails.nextAttemptAt)
      .limit(options.limit ?? 50)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(documentEmails)
      .set({ status: "SENDING", updatedAt: new Date() })
      .where(inArray(documentEmails.id, due.map((d) => d.id)))
      .returning();
  });
  for (const row of claimed) {
    const outcome = await sendDocumentEmail(row);
    tally[outcome] += 1;
  }
  return tally;
}

async function sendDocumentEmail(row: DocumentEmail): Promise<"sent" | "failed" | "skipped" | "dead"> {
  const finish = (fields: Partial<typeof documentEmails.$inferInsert>) =>
    db.update(documentEmails).set({ ...fields, updatedAt: new Date() }).where(eq(documentEmails.id, row.id));
  if (emailMode() === "disabled") {
    await finish({ status: "SKIPPED", lastError: "Email delivery is not configured." });
    return "skipped";
  }
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
  const to = user?.email && !isPlaceholderEmail(user.email) ? user.email : null;
  if (!to) {
    await finish({ status: "SKIPPED", lastError: "The recipient has no email address." });
    return "skipped";
  }
  const attempts = row.attempts + 1;
  try {
    const doc = await renderDocumentAttachments(row.docType, row.docId);
    if (!doc) {
      await finish({ status: "SKIPPED", attempts, toAddress: to, lastError: "The document no longer exists." });
      return "skipped";
    }
    await sendEmail({ to, subject: row.subject, text: row.body, attachments: doc.attachments });
    await finish({ status: "SENT", attempts, toAddress: to, sentAt: new Date(), lastError: null });
    return "sent";
  } catch (error) {
    if (error instanceof EmailUnavailableError) {
      await finish({ status: "SKIPPED", attempts, toAddress: to, lastError: error.message });
      return "skipped";
    }
    const message = error instanceof Error ? error.message.slice(0, 300) : "Delivery failed.";
    if (attempts >= row.maxAttempts) {
      await finish({ status: "DEAD", attempts, toAddress: to, lastError: message });
      await recordAudit({
        action: AUDIT_ACTIONS.NOTIFICATION_DELIVERY_DEAD,
        entityType: "document_email",
        entityId: row.id,
        newValue: { docType: row.docType, docId: row.docId, attempts, error: message },
      });
      return "dead";
    }
    const wait = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
    await finish({ status: "FAILED", attempts, toAddress: to, lastError: message, nextAttemptAt: new Date(Date.now() + wait * 1000) });
    return "failed";
  }
}

export async function listDocumentEmails(docType: DocumentType, docId: string): Promise<DocumentEmail[]> {
  return db.select().from(documentEmails).where(and(eq(documentEmails.docType, docType), eq(documentEmails.docId, docId)));
}
