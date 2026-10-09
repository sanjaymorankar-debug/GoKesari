/**
 * SMS and WhatsApp (Module 3). One place that sends a text message, used by
 * the notification channels and by one-time codes.
 *
 *   none   nothing is sent (the channel reports itself unavailable);
 *   mock   the message is written to outbound_test_messages so testers can
 *          read codes and links at /admin/test-messages — test site and
 *          development only, refused on gokesari.com.
 *
 * A real vendor (MSG91 with DLT templates for SMS, Meta Cloud API or a BSP
 * for WhatsApp) is added as another mode here; callers do not change.
 */
import { getEnv, messagingConfigProblem } from "@/lib/env";
import { db } from "@/server/db";
import { outboundTestMessages } from "@/server/db/schema";

export type TextChannel = "SMS" | "WHATSAPP";

export class MessagingUnavailableError extends Error {}

export function textChannelMode(channel: TextChannel): "none" | "mock" {
  const env = getEnv();
  if (messagingConfigProblem(env)) return "none";
  return channel === "SMS" ? env.SMS_PROVIDER : env.WHATSAPP_PROVIDER;
}

export function isTextChannelAvailable(channel: TextChannel): boolean {
  return textChannelMode(channel) !== "none";
}

/** Sends one text message. Throws MessagingUnavailableError when the channel is not set up. */
export async function sendText(channel: TextChannel, to: string, body: string, purpose: string): Promise<{ providerRef: string }> {
  const mode = textChannelMode(channel);
  if (mode === "none") {
    const problem = messagingConfigProblem();
    throw new MessagingUnavailableError(problem ?? `${channel} is not set up on this server.`);
  }
  const [row] = await db
    .insert(outboundTestMessages)
    .values({ channel, toAddress: to, body: body.slice(0, 2000), purpose: purpose.slice(0, 80) })
    .returning({ id: outboundTestMessages.id });
  return { providerRef: `mock:${row.id}` };
}

/**
 * Short text for SMS / WhatsApp from a queued notification (whose subject is
 * "<title> — Gokesari" and whose text is title, body, link and footer).
 */
export function textFromNotification(subject: string, text: string, actionUrl?: string | null): string {
  const title = subject.replace(/\s+—\s+Gokesari$/i, "").trim();
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const body = paragraphs[0] === title ? (paragraphs[1] ?? "") : (paragraphs[0] ?? "");
  const link = actionUrl ? ` ${actionUrl.startsWith("http") ? actionUrl : `${(getEnv().AUTH_URL ?? "").replace(/\/$/, "")}${actionUrl}`}` : "";
  return `GoKesari: ${title}. ${body}`.slice(0, 480 - link.length) + link;
}
