/**
 * Outbound email — one place, used by OTP delivery and the notification
 * framework. Same configuration as magic-link sign-in: AUTH_EMAIL_FROM plus an
 * SMTP connection string in AUTH_EMAIL_SERVER. Without a server, non-production
 * environments log the message to the console; production reports the channel
 * as unavailable rather than pretending to send.
 *
 * Test site (owner, 20 Nov 2026): with EMAIL_REDIRECT_TO set, every message
 * except a sign-in code goes to that one inbox instead of the test accounts'
 * own addresses. Never on gokesari.com.
 */
import { getEnv, isProductionSite, type ServerEnv } from "@/lib/env";

import { withEmailBrand } from "./brand";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** batch-2026-10 WS-E: files to attach (invoice PDF, statement PDF/CSV). Optional — existing callers send none. */
  attachments?: EmailAttachment[];
  /**
   * A sign-in code: always delivered to its own address, even where
   * EMAIL_REDIRECT_TO sends the rest of the test site's mail to one inbox
   * (the staging QA sign-in reads these codes from the accounts' mailboxes).
   */
  keepRecipient?: boolean;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  /** Content-ID: an HTML body can show the file inline with <img src="cid:…"> (shop welcome kit banner). */
  cid?: string;
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

type RedirectEnv = Pick<ServerEnv, "EMAIL_REDIRECT_TO" | "NODE_ENV" | "AUTH_URL" | "KYC_PRODUCTION_HOST">;

let warnedOnProduction = false;

/** The one inbox the test site's mail goes to, or null (unset, or this is gokesari.com). */
export function emailRedirectTarget(env: RedirectEnv = getEnv()): string | null {
  const target = env.EMAIL_REDIRECT_TO?.trim();
  if (!target) return null;
  if (isProductionSite(env as ServerEnv)) {
    if (!warnedOnProduction) {
      console.warn("[email] EMAIL_REDIRECT_TO is ignored on the production site; mail goes to its real recipients.");
      warnedOnProduction = true;
    }
    return null;
  }
  return target;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The message as it is actually sent: unchanged, or readdressed to the test inbox naming who it was for. */
export function redirectedEmail(message: OutboundEmail, env: RedirectEnv = getEnv()): OutboundEmail {
  const target = message.keepRecipient ? null : emailRedirectTarget(env);
  if (!target || target.toLowerCase() === message.to.trim().toLowerCase()) return message;
  const note = `Test site: this e-mail was meant for ${message.to}.`;
  return {
    ...message,
    to: target,
    subject: `[for ${message.to}] ${message.subject}`,
    text: `${note}\n\n${message.text}`,
    html: message.html
      ? `<p style="margin:0 0 12px;padding:8px 10px;background:#fef3c7;border-radius:6px;color:#92400e;font-size:12px">${escapeHtml(note)}</p>${message.html}`
      : undefined,
  };
}

export async function sendEmail(original: OutboundEmail): Promise<void> {
  const env = getEnv();
  const mode = emailMode();
  if (mode === "disabled") throw new EmailUnavailableError();
  const message = redirectedEmail(original, env);
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
      ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) })) }
      : {}),
  });
  const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
  if (failed.length) throw new Error("The email could not be delivered.");
}
