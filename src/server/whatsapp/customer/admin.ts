/**
 * Admin actions on the WhatsApp log (/admin/whatsapp-messages;
 * docs/customer-whatsapp-2026-11/README.md):
 *
 *   retryWhatsAppMessage     a FAILED template message (shop alert or customer
 *                            update) goes back into the queue with fresh attempts
 *                            (admins and operators: order:update-status:any); audited
 *   simulateCustomerInbound  the test site only: a customer message typed by an
 *                            admin (system:config) runs the chat exactly as one
 *                            from Meta would — replies land in the log and, in
 *                            mock mode, in Admin → Test messages; audited
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { conflict, forbidden, validationFailed } from "@/lib/errors";
import { isProductionSite } from "@/lib/env";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { whatsappMessages, whatsappWebhookEvents, type UserRole } from "@/server/db/schema";
import { toE164 } from "@/server/notifications/providers/whatsapp-meta";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { RETRYABLE_KINDS } from "@/server/whatsapp/shop-orders/dispatch";
import { scheduleWhatsAppDispatch } from "@/server/whatsapp/shop-orders/queue";
import { customerWhatsAppState } from "./config";
import { handleCustomerInbound } from "./sessions";

export interface Actor {
  id: string;
  role: UserRole;
}

export function canRetryWhatsApp(role: UserRole): boolean {
  return can(role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY);
}

export function canSimulateWhatsApp(role: UserRole): boolean {
  return can(role, PERMISSIONS.SYSTEM_CONFIG) && !isProductionSite();
}

/** FAILED → QUEUED with attempts reset; the dispatcher sends it (subject to the same switches and checks). */
export async function retryWhatsAppMessage(messageId: string, actor: Actor): Promise<void> {
  if (!canRetryWhatsApp(actor.role)) throw forbidden("You cannot retry WhatsApp messages.");
  const [row] = await db
    .update(whatsappMessages)
    .set({ status: "QUEUED", attempts: 0, error: null, errorCode: null, failedAt: null, updatedAt: new Date() })
    .where(and(eq(whatsappMessages.id, messageId), eq(whatsappMessages.status, "FAILED"), inArray(whatsappMessages.kind, RETRYABLE_KINDS)))
    .returning({ id: whatsappMessages.id, kind: whatsappMessages.kind });
  if (!row) throw conflict("Only a failed template message can be retried.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.WHATSAPP_MESSAGE_RETRIED,
    entityType: "whatsapp_message",
    entityId: row.id,
    newValue: { kind: row.kind },
  });
  scheduleWhatsAppDispatch(false);
}

export async function simulateCustomerInbound(input: { from: string; text: string }, actor: Actor): Promise<string> {
  if (!can(actor.role, PERMISSIONS.SYSTEM_CONFIG)) throw forbidden("Only an admin can simulate WhatsApp messages.");
  if (isProductionSite()) throw forbidden("Simulated WhatsApp messages are for the test site only.");
  if (!(await customerWhatsAppState()).flagOn) throw validationFailed("Switch on whatsapp_customer_enabled first.");
  const digits = input.from.replace(/[^\d]/g, "");
  if (!/^[1-9]\d{9,14}$/.test(digits)) throw validationFailed("Give the number with its country code, e.g. +919876543210.");
  const text = input.text.trim().slice(0, 500);
  if (!text) throw validationFailed("Type the message.");
  const from = toE164(digits);
  const inboundId = `sim:${randomUUID()}`;
  const [event] = await db
    .insert(whatsappWebhookEvents)
    .values({ eventKey: `msg:${inboundId}`, kind: "MESSAGE", fromNumber: from, payload: { simulated: true, by: actor.id, text } })
    .returning({ id: whatsappWebhookEvents.id });
  const result = await handleCustomerInbound({ from, text, inboundId });
  await db.update(whatsappWebhookEvents).set({ result: result.slice(0, 300) }).where(eq(whatsappWebhookEvents.id, event.id));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.WHATSAPP_INBOUND_SIMULATED,
    entityType: "whatsapp_webhook_event",
    entityId: event.id,
    newValue: { from, result },
  });
  return result;
}
