/**
 * Sending to customers (docs/customer-whatsapp-2026-11/README.md): through the
 * Meta Cloud API (WHATSAPP_PROVIDER=meta) or, on the test site, the mock outbox
 * (WHATSAPP_PROVIDER=mock → outbound_test_messages, read at Admin → Test messages).
 * Every message is also in whatsapp_messages (Admin → WhatsApp messages).
 * Never called inside a database transaction.
 */
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { whatsappMessages } from "@/server/db/schema";
import { MessagingUnavailableError, sendText } from "@/server/messaging/sms-whatsapp";
import {
  MetaWhatsAppError,
  sendMetaInteractive,
  sendMetaTemplate,
  sendMetaText,
  toE164,
  type SendResult,
} from "@/server/notifications/providers/whatsapp-meta";
import { customerWhatsAppMode } from "./config";
import type { BotReply } from "./conversation";

const MOCK_PURPOSE = "whatsapp-customer";

async function sendMock(to: string, text: string): Promise<SendResult> {
  try {
    const { providerRef } = await sendText("WHATSAPP", to, text, MOCK_PURPOSE);
    return { messageId: providerRef, sentTo: toE164(to) };
  } catch (error) {
    if (error instanceof MessagingUnavailableError) throw new MetaWhatsAppError(error.message, "NOT_CONFIGURED", false);
    throw error;
  }
}

/** A template update (outside the 24-hour window). `text` is what the mock outbox shows. */
export async function sendCustomerTemplate(args: { to: string; name: string; language: string; bodyParams: string[]; text: string }): Promise<SendResult> {
  const { mode, problem } = customerWhatsAppMode();
  if (mode === "meta") return sendMetaTemplate({ to: args.to, name: args.name, language: args.language, bodyParams: args.bodyParams });
  if (mode === "mock") return sendMock(args.to, `[template ${args.name}] ${args.text}`);
  throw new MetaWhatsAppError(`WhatsApp is not set up: ${problem}`, "NOT_CONFIGURED", false);
}

/** Sends one chat reply (interactive when it has choices and the provider is Meta; plain text otherwise). */
async function deliverReply(to: string, reply: BotReply): Promise<SendResult> {
  const { mode, problem } = customerWhatsAppMode();
  if (mode === "meta") {
    if (reply.list || reply.buttons?.length) {
      return sendMetaInteractive({ to, body: reply.interactiveText ?? reply.text, buttons: reply.buttons, list: reply.list });
    }
    return sendMetaText(to, reply.text);
  }
  if (mode === "mock") return sendMock(to, reply.text);
  throw new MetaWhatsAppError(`WhatsApp is not set up: ${problem}`, "NOT_CONFIGURED", false);
}

/**
 * A chat reply, logged as CUSTOMER_REPLY. The person just wrote, so the
 * 24-hour window is open. A failure is logged, never thrown.
 */
export async function sendCustomerReply(to: string, reply: BotReply, userId: string | null): Promise<"SENT" | "FAILED"> {
  const [row] = await db
    .insert(whatsappMessages)
    .values({
      userId,
      kind: "CUSTOMER_REPLY",
      body: reply.text,
      params: { text: reply.text, ...(reply.list ? { list: reply.list } : {}), ...(reply.buttons ? { buttons: reply.buttons } : {}) },
      intendedTo: to,
      status: "SENDING",
      attempts: 1,
    })
    .returning({ id: whatsappMessages.id });
  try {
    const sent = await deliverReply(to, reply);
    await db
      .update(whatsappMessages)
      .set({ status: "SENT", metaMessageId: sent.messageId, sentTo: sent.sentTo, sentAt: new Date(), updatedAt: new Date() })
      .where(eq(whatsappMessages.id, row.id));
    return "SENT";
  } catch (error) {
    const err = error instanceof MetaWhatsAppError ? error : null;
    await db
      .update(whatsappMessages)
      .set({
        status: "FAILED",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        errorCode: err?.code ?? null,
        failedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(whatsappMessages.id, row.id));
    console.warn("[whatsapp-customer] reply failed", error instanceof Error ? error.message : error);
    return "FAILED";
  }
}
