/**
 * Outbound email — one place, used by OTP delivery and the notification
 * framework. Same configuration as magic-link sign-in: AUTH_EMAIL_FROM plus an
 * SMTP connection string in AUTH_EMAIL_SERVER. Without a server, non-production
 * environments log the message to the console; production reports the channel
 * as unavailable rather than pretending to send.
 */
import { getEnv } from "@/lib/env";

import { withEmailBrand } from "./brand";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** batch-2026-10 WS-E: files to attach (invoice PDF, statement PDF/CSV). Optional — existing callers send none. */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export type EmailMode = "smtp" | "console" | "disabled";

export function emailMode(): EmailMode {
  const env = getEnv();
  if (!env.AUTH_EMAIL_FROM) return "disabled";
  if (env.AUTH_EMAIL_SERVER) return "smtp";
  return env.NODE_ENV === "production" ? "disabled" : "console";
}

export class EmailUnavailableError extends Error {
  constructor() {
    super("Email delivery is not configured.");
    this.name = "EmailUnavailableError";
  }
}

export async function sendEmail(message: OutboundEmail): Promise<void> {
  const env = getEnv();
  const mode = emailMode();
  if (mode === "disabled") throw new EmailUnavailableError();
  if (mode === "console") {
    // Bodies can hold codes: printed only outside production, as for magic links.
    console.info(`[email:console] to=${message.to} subject=${message.subject}\n${message.text}`);
    if (message.attachments?.length) {
      console.info(`[email:console] attachments: ${message.attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(", ")}`);
    }
    return;
  }
  const { createTransport } = await import("nodemailer");
  const result = await createTransport(env.AUTH_EMAIL_SERVER).sendMail({
    from: env.AUTH_EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    // Every HTML email opens with the GoKesari wordmark.
    html: message.html ? withEmailBrand(message.html) : undefined,
    ...(message.attachments?.length
      ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }
      : {}),
  });
  const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
  if (failed.length) throw new Error("The email could not be delivered.");
}
