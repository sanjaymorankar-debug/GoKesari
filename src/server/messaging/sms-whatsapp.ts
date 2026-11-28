/**
 * SMS and WhatsApp (Module 3). One place that sends a text message, used by
 * the notification channels and by one-time codes.
 *
 *   none   nothing is sent (the channel reports itself unavailable);
 *   mock   the message is written to outbound_test_messages so testers can
 *          read codes and links at /admin/test-messages — test site and
 *          development only, refused on gokesari.com.
 *
 * A real vendor (MSG91 with DLT templates for SMS) is added as another mode
 * here; callers do not change. WhatsApp's Meta Cloud API mode is used only by
 * the shop-order alerts (notifications/providers/whatsapp-meta.ts).
 */
import { getEnv, isProductionSite, messagingConfigProblem, msg91ConfigProblem, smsFortiusConfigProblem } from "@/lib/env";
import { db } from "@/server/db";
import { outboundTestMessages } from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";

export type TextChannel = "SMS" | "WHATSAPP";

export class MessagingUnavailableError extends Error {}

export function textChannelMode(channel: TextChannel): "none" | "mock" {
  const env = getEnv();
  if (messagingConfigProblem(env)) return "none";
  // SMS_PROVIDER=msg91 sends DLT-approved one-time codes only (smsOtpMode below); general texts
  // have no DLT template, so they are not sent in that mode.
  if (channel === "SMS") return env.SMS_PROVIDER === "mock" ? "mock" : "none";
  // WHATSAPP_PROVIDER=meta serves only the shop-order alerts (server/whatsapp/shop-orders, approved
  // templates); a general notification has no approved template, so its WhatsApp copy is skipped.
  return env.WHATSAPP_PROVIDER === "mock" ? "mock" : "none";
}

/**
 * docs/sms-2fa-2026-11: how one-time codes go by SMS — the mock outbox, MSG91
 * (only with all its keys), or not at all.
 */
export function smsOtpMode(): "none" | "mock" | "msg91" | "smsfortius" {
  const env = getEnv();
  if (env.SMS_PROVIDER === "msg91") return msg91ConfigProblem(env) ? "none" : "msg91";
  if (env.SMS_PROVIDER === "smsfortius") return smsFortiusConfigProblem(env) ? "none" : "smsfortius";
  return textChannelMode("SMS");
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
  if (channel === "SMS") emailMockSmsCopy(to, body);
  return { providerRef: `mock:${row.id}` };
}

/** The test inbox that gets a copy of each mock SMS (SMS_MOCK_EMAIL_TO), or null: unset, or gokesari.com. */
export function mockSmsEmailTarget(env = getEnv()): string | null {
  const target = env.SMS_MOCK_EMAIL_TO?.trim();
  if (!target || isProductionSite(env)) return null;
  return target;
}

/** "[test SMS to +91…] Code 482913": the first 4–8 digit number in the text, else its start. */
export function mockSmsEmailSubject(to: string, body: string): string {
  const code = body.match(/\b\d{4,8}\b/)?.[0];
  return `[test SMS to ${to}] ${code ? `Code ${code}` : body.slice(0, 60)}`;
}

/**
 * Test site (owner, 28 Nov 2026): testers get the mock SMS by e-mail, the code in the subject.
 * Sent after the outbox row, never awaited: a full mail quota leaves the code on /admin/test-messages.
 */
function emailMockSmsCopy(to: string, body: string): void {
  const target = mockSmsEmailTarget();
  if (!target) return;
  void sendEmail({
    to: target,
    keepRecipient: true,
    subject: mockSmsEmailSubject(to, body),
    text: `Test site: this SMS was not sent to a phone (SMS_PROVIDER=mock).\n\nTo: ${to}\n\n${body}`,
  }).catch((error: unknown) => console.warn("[sms:mock] e-mail copy not sent:", error instanceof Error ? error.message : error));
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
