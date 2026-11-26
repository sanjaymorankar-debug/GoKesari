/**
 * System tickets (docs/flows-v3/wave1.md, F17 step 2; flag flow_f17; migration 0221).
 *
 * The system opens a help-desk ticket for an event that needs a person: a shop's GST / PAN or document check that
 * failed or needs review, an identity check sent to review, a payment the gateway does not confirm, an order
 * dispute, a locked delivery code, a society application and an account-recovery request. One ticket per
 * (source, source_ref) — the partial unique index makes a repeat a no-op that returns the first ticket.
 *
 * The ticket has no requester account (requester_role SYSTEM, or the recovery form's name and e-mail), lands in
 * the support queue and goes through routing like any new ticket (afterTicketOpened).
 *
 * openSystemTicket never throws and does nothing while the flag is off: the flow that called it carries on
 * exactly as before. Call it after that flow's own transaction has committed (system-ticket-hook.ts).
 */
import { and, eq } from "drizzle-orm";

import { type TicketPriority } from "@/lib/support-ticket-states";
import { db } from "@/server/db";
import { supportTickets, type SupportTicket } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { afterTicketOpened, announceCreated, appendEvent, flowF17On, slaDeadlines } from "./support-tickets";

export const SYSTEM_TICKET_KINDS = [
  "GST_PAN_CHECK",
  "SHOP_DOCUMENT_CHECK",
  "IDENTITY_REVIEW",
  "PAYMENT_MISMATCH",
  "DISPUTE_OPENED",
  "DELIVERY_CODE_LOCKOUT",
  "SOCIETY_REVIEW",
  "ACCOUNT_RECOVERY",
] as const;
export type SystemTicketKind = (typeof SYSTEM_TICKET_KINDS)[number];

/** The ticket category each kind is filed under (routing rules match on it). */
export const SYSTEM_TICKET_CATEGORY: Record<SystemTicketKind, string> = {
  GST_PAN_CHECK: "SHOP_VERIFICATION",
  SHOP_DOCUMENT_CHECK: "SHOP_VERIFICATION",
  IDENTITY_REVIEW: "ACCOUNT",
  PAYMENT_MISMATCH: "REFUND_PAYMENT",
  DISPUTE_OPENED: "ORDER",
  DELIVERY_CODE_LOCKOUT: "DELIVERY",
  SOCIETY_REVIEW: "OTHER",
  ACCOUNT_RECOVERY: "ACCOUNT",
};

export interface SystemTicketInput {
  subject: string;
  description: string;
  shopId?: string | null;
  orderId?: string | null;
  priority?: TicketPriority;
  /** Who the ticket is about (recovery form): shown to support; no account is linked. */
  requesterName?: string | null;
  requesterEmail?: string | null;
}

/** The ticket already opened for this event, if any. */
export async function findSystemTicket(kind: SystemTicketKind, sourceRef: string): Promise<SupportTicket | null> {
  const [row] = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.source, kind), eq(supportTickets.sourceRef, sourceRef)));
  return row ?? null;
}

/**
 * Opens (once) the support ticket for a system event. Returns it, the one opened earlier for the same event, or
 * null while flow_f17 is off or on any error (logged).
 */
export async function openSystemTicket(kind: SystemTicketKind, sourceRef: string, input: SystemTicketInput): Promise<SupportTicket | null> {
  try {
    if (!(await flowF17On())) return null;
    const ref = String(sourceRef).slice(0, 200);
    const existing = await findSystemTicket(kind, ref);
    if (existing) return existing;
    const now = new Date();
    const { acknowledgeBy, resolveBy } = await slaDeadlines(now);
    const created = await db.transaction(async (tx) => {
      const [ticket] = await tx
        .insert(supportTickets)
        .values({
          requesterId: null,
          requesterRole: "SYSTEM",
          requesterName: input.requesterName?.trim().slice(0, 120) || null,
          requesterEmail: input.requesterEmail?.trim().slice(0, 200) || null,
          orderId: input.orderId ?? null,
          shopId: input.shopId ?? null,
          category: SYSTEM_TICKET_CATEGORY[kind],
          subject: input.subject.trim().slice(0, 200),
          description: input.description.trim().slice(0, 5000),
          priority: input.priority ?? "NORMAL",
          acknowledgeBy,
          resolveBy,
          createdAt: now,
          source: kind,
          sourceRef: ref,
        })
        .onConflictDoNothing()
        .returning();
      if (!ticket) return null;
      await appendEvent(tx, ticket.id, { kind: "CREATED", to: "OPEN", actor: null, note: `Opened by the system (${kind}).` });
      await recordAudit(
        {
          actorId: null,
          actorRole: null,
          action: AUDIT_ACTIONS.SUPPORT_TICKET_CREATED,
          entityType: "support_ticket",
          entityId: ticket.id,
          newValue: { ticketNumber: ticket.ticketNumber, category: ticket.category, source: kind, sourceRef: ref },
        },
        tx,
      );
      await announceCreated(tx, ticket, null, input.requesterName?.trim() || "GoKesari (system)");
      return ticket;
    });
    // Another process opened it in the meantime: that one stands.
    if (!created) return findSystemTicket(kind, ref);
    return afterTicketOpened(created);
  } catch (error) {
    console.error("[helpdesk] could not open a system ticket", kind, sourceRef, error);
    return null;
  }
}
